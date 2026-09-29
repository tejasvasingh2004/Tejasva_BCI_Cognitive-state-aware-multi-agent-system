import type { CognitivePolicy } from '@neuroflow/contracts';
import { derivePolicy } from '@neuroflow/cognitive';
import { withSpan } from '@neuroflow/observability';
import { AgentCatalog } from './agents/definitions';
import { RunCancelledError } from './errors';
import { heuristicEvaluation, modelEvaluation, recordEvaluation } from './evaluation';
import { ResponseChannel, RunBudget, throwIfCancelled, type RunContext } from './execution';
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
    try {
      return await withSpan('run.orchestrate', { 'run.id': input.run.id, 'run.mode': input.run.mode }, async (span) => {
        throwIfCancelled(input.signal);
        input.emit('router.started', {});

        const cognitive = input.run.mode === 'cognitive' ? await this.resolveCognitive(input) : undefined;
        const lastUser = [...input.history].reverse().find((m) => m.role === 'user')?.content ?? '';
        const plan = planExecution({
          mode: input.run.mode,
          request: input.request,
          lastUserMessage: lastUser,
          models: this.deps.gateway.listModels(),
          defaultModel: this.deps.gateway.defaultModel(),
          availableTools: this.deps.tools.registry.names(),
          ...(cognitive ? { cognitive } : {}),
        });
        await this.deps.store.setPlan(input.run.id, plan);
        input.emit('router.selected', { plan });
        span.setAttributes({
          'plan.strategy': plan.agentStrategy,
          'plan.model_strategy': plan.modelStrategy,
          'plan.task_class': plan.taskClass,
        });

        const ctx: RunContext = {
          run: input.run,
          plan,
          history: input.history,
          scopes: input.scopes,
          signal: input.signal,
          emit: input.emit,
          deps: this.deps,
          agents: new AgentCatalog(this.deps.agents),
          budget: new RunBudget(plan),
          response,
          temperature: input.request.temperature,
          maxOutputTokens: input.request.maxOutputTokens,
          usage: {},
          toolFailures: 0,
          stage: 'execution',
          appendOnly: input.request.metadata?.['neuroflow.appendOnly'] === true,
        };
        ctxRef = ctx;
        const strategyResult = await STRATEGIES[plan.agentStrategy](ctx, lastUser);
        stage = ctx.stage;

        if (!strategyResult.evaluated) {
          throwIfCancelled(input.signal);
          stage = 'evaluation';
          ctx.stage = 'evaluation';
          const kind = plan.evaluationPolicy.kind;
          input.emit('evaluation.started', { kind, iteration: 0 });
          const heuristic = heuristicEvaluation(ctx, response.text);
          const verdict =
            kind === 'model' && heuristic.verdict !== 'failed'
              ? await modelEvaluation(ctx, lastUser, response.text).catch((err) => {
                  if (err instanceof RunCancelledError) throw err;
                  return { ...heuristic, issues: [...heuristic.issues, 'Model evaluation unavailable'] };
                })
              : heuristic;
          await recordEvaluation(ctx, verdict, 0);
        }

        if (!response.text.trim()) {
          throw new Error('The model returned an empty response');
        }
        return { output: response.text, usage: ctx.usage.total, plan };
      });
    } catch (err) {
      throw new StageError(ctxRef && stage === 'routing' ? ctxRef.stage : stage, err, response.text);
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
