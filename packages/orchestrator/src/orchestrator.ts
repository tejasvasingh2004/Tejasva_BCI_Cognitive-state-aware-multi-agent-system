import type { CognitivePolicy } from '@neuroflow/contracts';
import { derivePolicy } from '@neuroflow/cognitive';
import { withSpan } from '@neuroflow/observability';
import { AgentCatalog, type AgentDefinition } from './agents/definitions';
import { BudgetExceededError, RunCancelledError } from './errors';
import { evaluate, recordEvaluation } from './evaluation';
import { newCodeRunState, observeCodeEvent, ResponseChannel, RunBudget, throwIfCancelled, type RunContext } from './execution';
import { planExecution } from './router';
import { STRATEGIES } from './strategies';
import type { ExecuteRunInput, OrchestratorDeps, RunOutcome } from './types';

const COGNITIVE_TIMEOUT_MS = 3_000;

export class StageError extends Error {
  constructor(
    readonly stage: string,
    override readonly cause: unknown,
    readonly partialOutput: string,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'StageError';
  }
}

/**
 * NeuroFlow Orchestrator. Resolves mode → cognitive policy (optional) → router → execution
 * strategy → evaluation. Returns the final output; lifecycle (start/complete/fail/cancel
 * persistence) is owned by the worker.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async execute(input: ExecuteRunInput): Promise<RunOutcome> {
    const response = new ResponseChannel(input.emit);
    let stage = 'routing';
    let ctxRef: RunContext | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await withSpan('run.orchestrate', { 'run.id': input.run.id, 'run.mode': input.run.mode }, async (span) => {
        throwIfCancelled(input.signal);
        input.emit('router.started', {});

        const custom = await this.loadAgents(input.run.workspaceId);
        const catalog = new AgentCatalog([...(this.deps.agents ?? []), ...custom]);
        const cognitive = input.run.mode === 'cognitive' ? await this.resolveCognitive(input) : undefined;
        const lastUser = [...input.history].reverse().find((m) => m.role === 'user')?.content ?? '';

        const plan = await withSpan('router.plan', { 'run.id': input.run.id }, async (routeSpan) => {
          const p = planExecution({
            mode: input.run.mode,
            request: input.request,
            lastUserMessage: lastUser,
            models: this.deps.gateway.listModels(),
            defaultModel: this.deps.gateway.defaultModel(),
            // Repository tools exist only in code runs; Restricted mode only gets side-effect-free tools.
            availableTools: this.deps.tools.registry.namesFor({
              code: Boolean(input.request.workspaceContext),
              readOnly: input.request.workspaceContext?.approvalMode === 'restricted',
            }),
            availableAgents: catalog.ids(),
            ...(cognitive ? { cognitive } : {}),
          });
          routeSpan.setAttributes({
            'plan.strategy': p.agentStrategy,
            'plan.model_strategy': p.modelStrategy,
            'plan.task_class': p.taskClass,
            'plan.models': [...new Set(p.models.map((m) => m.model))].join(','),
          });
          return p;
        });
        await this.deps.store.setPlan(input.run.id, plan);
        input.emit('router.selected', { plan });
        span.setAttributes({ 'plan.strategy': plan.agentStrategy, 'plan.task_class': plan.taskClass });

        // Wall-clock budget: interrupts in-flight model and tool calls, not just the next step.
        const budgetController = new AbortController();
        deadline = setTimeout(
          () => budgetController.abort(new BudgetExceededError('time')),
          plan.budgets.maxDurationMs,
        );
        const signal = AbortSignal.any([input.signal, budgetController.signal]);
        const codeState = input.request.workspaceContext ? newCodeRunState() : undefined;
        // Observe real tool events to drive the code test/repair loop and evaluation.
        const emit: typeof input.emit = codeState
          ? (type, data) => {
              observeCodeEvent(codeState, type, data);
              input.emit(type, data);
            }
          : input.emit;

        const ctx: RunContext = {
          run: input.run,
          request: input.request,
          plan,
          history: input.history,
          scopes: input.scopes,
          signal,
          emit,
          deps: this.deps,
          agents: catalog,
          budget: new RunBudget(plan),
          response,
          temperature: input.request.temperature,
          maxOutputTokens: input.request.maxOutputTokens,
          usage: {},
          toolFailures: 0,
          stage: 'execution',
          appendOnly: input.request.metadata?.['neuroflow.appendOnly'] === true,
          trajectory: [],
          toolLimitHit: false,
          extras: {
            ...(input.context?.workspaceInstructions ? { workspaceInstructions: input.context.workspaceInstructions } : {}),
            ...(input.context?.conversationSummary ? { summary: input.context.conversationSummary } : {}),
            ...(input.context?.code ? { code: input.context.code } : {}),
          },
          ...(codeState ? { code: codeState } : {}),
        };
        ctxRef = ctx;
        const strategyResult = await STRATEGIES[plan.agentStrategy](ctx, lastUser);
        stage = ctx.stage;

        if (!strategyResult.evaluated) {
          throwIfCancelled(signal);
          stage = 'evaluation';
          ctx.stage = 'evaluation';
          const kind = plan.evaluationPolicy.kind;
          input.emit('evaluation.started', { kind, iteration: 0 });
          const verdict = await evaluate(ctx, lastUser, response.text, kind, 0).catch(async (err) => {
            if (err instanceof RunCancelledError || err instanceof BudgetExceededError) throw err;
            // A failed model evaluation never fails the run: fall back to the heuristic verdict.
            const fallback = await evaluate(ctx, lastUser, response.text, 'heuristic', 0);
            return { ...fallback, issues: [...fallback.issues, 'Model evaluation unavailable'] };
          });
          await recordEvaluation(ctx, verdict, 0);
        }

        if (!response.text.trim() && !ctx.clientToolCalls?.length) {
          throw new Error('The model returned an empty response');
        }
        span.setAttribute('run.cost_usd', ctx.budget.costUsd);
        return {
          output: response.text,
          usage: ctx.usage.total,
          plan,
          ...(ctx.clientToolCalls?.length ? { toolCalls: ctx.clientToolCalls } : {}),
        };
      });
    } catch (err) {
      throw new StageError(ctxRef && stage === 'routing' ? ctxRef.stage : stage, err, response.text);
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Workspace agents are optional: a failure to load them never blocks the run. */
  private async loadAgents(workspaceId: string): Promise<AgentDefinition[]> {
    if (!this.deps.loadAgents) return [];
    try {
      return await this.deps.loadAgents(workspaceId);
    } catch {
      return [];
    }
  }

  /** Cognitive state is an optional signal: unavailability never blocks execution. */
  private async resolveCognitive(input: ExecuteRunInput): Promise<CognitivePolicy | undefined> {
    if (!this.deps.cognitive) {
      input.emit('cognitive.applied', { available: false, reason: 'No cognitive state provider configured' });
      return undefined;
    }
    try {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(COGNITIVE_TIMEOUT_MS)]);
      const state = await this.deps.cognitive.getState(
        { workspaceId: input.run.workspaceId, userId: input.run.userId },
        signal,
      );
      if (!state) {
        input.emit('cognitive.applied', { available: false, reason: 'No current cognitive state' });
        return undefined;
      }
      const policy = derivePolicy(state);
      input.emit('cognitive.applied', { available: true, state, policy });
      return policy;
    } catch {
      throwIfCancelled(input.signal);
      input.emit('cognitive.applied', { available: false, reason: 'Cognitive state provider unavailable' });
      return undefined;
    }
  }
}
