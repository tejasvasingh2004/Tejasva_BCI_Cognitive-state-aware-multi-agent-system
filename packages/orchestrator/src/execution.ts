import { randomUUID } from 'node:crypto';
import {
  addUsage,
  type ChatMessage,
  type ExecutionPlan,
  type ModelRole,
  type ToolCall,
  type Usage,
} from '@neuroflow/contracts';
import { ModelError, type FinishReason, type ModelResponse, type ToolChoice } from '@neuroflow/models';
import { runtimeMetrics, withSpan } from '@neuroflow/observability';
import { toolResultContent, type EmitFn } from '@neuroflow/tools';
import type { AgentCatalog, AgentDefinition } from './agents/definitions';
import { buildContext } from './context';
import { BudgetExceededError, RunCancelledError } from './errors';
import type { OrchestratorDeps, RunIdentity } from './types';

/** Tracks per-run resource budgets so autonomous loops cannot run away. */
export class RunBudget {
  private modelCalls = 0;
  private readonly deadline: number;

  constructor(private readonly plan: ExecutionPlan) {
    this.deadline = Date.now() + plan.budgets.maxDurationMs;
  }

  consumeModelCall() {
    if (++this.modelCalls > this.plan.budgets.maxModelCalls) throw new BudgetExceededError('model call');
    if (Date.now() > this.deadline) throw new BudgetExceededError('time');
  }

  get used() {
    return this.modelCalls;
  }
}

/**
 * The single path to the user-visible answer. What is streamed is exactly what is persisted.
 */
export class ResponseChannel {
  private buffer = '';

  constructor(private readonly emit: EmitFn) {}

  write(text: string) {
    if (!text) return;
    this.buffer += text;
    this.emit('response.delta', { text });
  }

  reset(reason: string) {
    this.buffer = '';
    this.emit('response.reset', { reason });
  }

  get text() {
    return this.buffer;
  }
}

export type RunContext = {
  run: RunIdentity;
  plan: ExecutionPlan;
  history: ChatMessage[];
  scopes: readonly string[];
  signal: AbortSignal;
  emit: EmitFn;
  deps: OrchestratorDeps;
  agents: AgentCatalog;
  budget: RunBudget;
  response: ResponseChannel;
  temperature?: number;
  maxOutputTokens?: number;
  usage: { total?: Usage };
  /** Latest finish reason of a user-facing generation (used by evaluation). */
  lastFinishReason?: FinishReason;
  toolFailures: number;
  stage: string;
  /** Clients that cannot retract streamed text (OpenAI protocol) need append-only output. */
  appendOnly: boolean;
};

export function modelFor(ctx: RunContext, role: ModelRole): { model: string; fallbacks: string[] } {
  const a =
    ctx.plan.models.find((m) => m.role === role) ??
    ctx.plan.models.find((m) => m.role === 'agent') ??
    ctx.plan.models[0]!;
  return { model: a.model, fallbacks: a.fallbacks };
}

export function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new RunCancelledError();
}

export type ModelCallOptions = {
  role: ModelRole;
  messages: ChatMessage[];
  agentExecutionId?: string;
  tools?: ReturnType<OrchestratorDeps['tools']['registry']['specs']>;
  toolChoice?: ToolChoice;
  /** Stream text deltas to the user as they arrive. */
  streamToUser: boolean;
  responseFormat?: 'text' | 'json';
  maxOutputTokens?: number;
};

/** One observable model call through the Model Gateway. */
export async function callModel(ctx: RunContext, opts: ModelCallOptions): Promise<ModelResponse> {
  throwIfCancelled(ctx.signal);
  ctx.budget.consumeModelCall();
  const { model, fallbacks } = modelFor(ctx, opts.role);
  const callId = randomUUID();
  const started = Date.now();
  let current = model;
  let announced = false;

  return withSpan('model.call', { 'model.role': opts.role, 'model.requested': model }, async (span) => {
    try {
      let response: ModelResponse | undefined;
      for await (const ev of ctx.deps.gateway.stream({
        model,
        fallbacks,
        messages: opts.messages,
        tools: opts.tools?.length ? opts.tools : undefined,
        toolChoice: opts.toolChoice,
        reasoningBudget: ctx.plan.reasoningBudget,
        temperature: ctx.temperature,
        maxOutputTokens: opts.maxOutputTokens ?? ctx.maxOutputTokens,
        responseFormat: opts.responseFormat,
        signal: ctx.signal,
      })) {
        switch (ev.type) {
          case 'attempt':
            current = ev.ref;
            if (!announced) {
              announced = true;
              ctx.emit('model.started', {
                callId,
                role: opts.role,
                provider: ev.provider,
                model: ev.ref,
                ...(opts.agentExecutionId ? { agentExecutionId: opts.agentExecutionId } : {}),
              });
            }
            break;
          case 'retry':
            runtimeMetrics.modelRetries.add(1, { model: ev.ref });
            ctx.emit('model.retry', { callId, attempt: ev.attempt, reason: ev.reason, delayMs: ev.delayMs });
            break;
          case 'fallback':
            runtimeMetrics.modelFallbacks.add(1, { from: ev.from, to: ev.to });
            ctx.emit('model.fallback', { callId, from: ev.from, to: ev.to, reason: ev.reason });
            break;
          case 'delta':
            if (opts.streamToUser) ctx.response.write(ev.text);
            break;
          case 'done':
            response = ev.response;
            break;
        }
      }
      if (!response) throw new ModelError('provider_error', 'Model returned no response');

      ctx.usage.total = addUsage(ctx.usage.total, response.usage);
      span.setAttributes({ 'model.provider': response.provider, 'model.ref': response.ref });
      runtimeMetrics.modelLatency.record(response.latencyMs, { model: response.ref, role: opts.role });
      if (response.firstTokenMs !== undefined) runtimeMetrics.modelFirstToken.record(response.firstTokenMs, { model: response.ref });
      if (response.usage) runtimeMetrics.tokens.add(response.usage.totalTokens, { model: response.ref });

      if (!announced) {
        ctx.emit('model.started', { callId, role: opts.role, provider: response.provider, model: response.ref });
      }
      ctx.emit('model.completed', {
        callId,
        provider: response.provider,
        model: response.ref,
        status: 'completed',
        latencyMs: response.latencyMs,
        attempts: response.attempts,
        finishReason: response.finishReason,
        ...(response.firstTokenMs !== undefined ? { firstTokenMs: response.firstTokenMs } : {}),
        ...(response.usage ? { usage: response.usage } : {}),
      });
      await ctx.deps.store.recordModelCall({
        runId: ctx.run.id,
        agentExecutionId: opts.agentExecutionId,
        role: opts.role,
        provider: response.provider,
        model: response.ref,
        status: 'completed',
        latencyMs: response.latencyMs,
        firstTokenMs: response.firstTokenMs,
        usage: response.usage,
        attempts: response.attempts,
        fallbackFrom: response.fallbackFrom,
        finishReason: response.finishReason,
      });
      if (opts.streamToUser) ctx.lastFinishReason = response.finishReason;
      return response;
    } catch (err) {
      const cancelled = ctx.signal.aborted || (err instanceof ModelError && err.code === 'cancelled');
      const status = cancelled ? 'cancelled' : 'failed';
      const message = err instanceof Error ? err.message : String(err);
      runtimeMetrics.modelErrors.add(1, { model: current, code: err instanceof ModelError ? err.code : 'unknown' });
      if (!announced) {
        ctx.emit('model.started', { callId, role: opts.role, provider: current.split('/')[0]!, model: current });
      }
      ctx.emit('model.completed', {
        callId,
        provider: current.split('/')[0]!,
        model: current,
        status,
        latencyMs: Date.now() - started,
        attempts: 1,
        error: cancelled ? 'cancelled' : err instanceof ModelError ? err.code : 'error',
      });
      await ctx.deps.store
        .recordModelCall({
          runId: ctx.run.id,
          agentExecutionId: opts.agentExecutionId,
          role: opts.role,
          provider: current.split('/')[0]!,
          model: current,
          status,
          latencyMs: Date.now() - started,
          attempts: 1,
          error: message.slice(0, 500),
        })
        .catch(() => {});
      if (cancelled) throw new RunCancelledError();
      throw err;
    }
  });
}

export type AgentRunOptions = {
  agent: AgentDefinition;
  /** Replace the user's message with a delegated task (multi-agent). */
  task?: string;
  /** Notes from previous stages / other agents. */
  notes?: ChatMessage[];
  streamToUser: boolean;
  /** Overrides the agent's model role (e.g. the synthesiser in a supervisor run). */
  role?: ModelRole;
};

export type AgentRunResult = { text: string; agentExecutionId: string; iterations: number };

/**
 * Agent loop: model → (tool calls → validated execution → results) → model … → answer.
 * Bounded by the agent's iteration limit, the run's tool-call policy and the run budget.
 */
export async function runAgent(ctx: RunContext, opts: AgentRunOptions): Promise<AgentRunResult> {
  throwIfCancelled(ctx.signal);
  const role = opts.role ?? opts.agent.modelRole;
  const { model } = modelFor(ctx, role);
  const agentExecutionId = await ctx.deps.store.startAgent({
    runId: ctx.run.id,
    agentId: opts.agent.id,
    role,
    model,
  });
  const started = Date.now();
  ctx.stage = `agent:${opts.agent.id}`;
  ctx.emit('agent.started', { agentExecutionId, agentId: opts.agent.id, name: opts.agent.name, role, model });

  const allowed =
    opts.agent.tools === '*'
      ? ctx.plan.toolPolicy.allowed
      : ctx.plan.toolPolicy.allowed.filter((t) => (opts.agent.tools as string[]).includes(t));
  const toolSpecs = ctx.deps.tools.registry.specs(allowed);
  const scratch: ChatMessage[] = [];
  let toolCallsUsed = 0;
  let iterations = 0;
  let text = '';

  return withSpan('agent.run', { 'agent.id': opts.agent.id, 'agent.role': role }, async () => {
    try {
      while (true) {
        iterations++;
        const toolsLeft = toolSpecs.length > 0 && toolCallsUsed < ctx.plan.toolPolicy.maxToolCalls;
        const lastIteration = iterations >= opts.agent.maxIterations;
        const { messages, report } = buildContext({
          plan: ctx.plan,
          instructions: opts.agent.instructions,
          history: ctx.history,
          taskMessages: opts.notes,
          scratch,
          ...(opts.task !== undefined ? { replaceTask: opts.task } : {}),
        });
        if (iterations === 1) ctx.emit('context.built', { agentExecutionId, ...report });

        const res = await callModel(ctx, {
          role,
          messages,
          agentExecutionId,
          streamToUser: opts.streamToUser,
          ...(toolsLeft && !lastIteration ? { tools: toolSpecs, toolChoice: 'auto' as const } : {}),
        });
        text += res.text;

        if (res.toolCalls.length === 0 || !toolsLeft || lastIteration) break;

        scratch.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
        for (const call of res.toolCalls.slice(0, ctx.plan.toolPolicy.maxToolCalls - toolCallsUsed)) {
          toolCallsUsed++;
          ctx.stage = `tool:${call.name}`;
          const result = await ctx.deps.tools.execute(call, {
            runId: ctx.run.id,
            workspaceId: ctx.run.workspaceId,
            userId: ctx.run.userId,
            scopes: ctx.scopes,
            signal: ctx.signal,
            emit: ctx.emit,
            allowedTools: allowed,
            agentExecutionId,
          });
          if (result.status === 'cancelled') throw new RunCancelledError();
          if (result.status !== 'success') ctx.toolFailures++;
          scratch.push({ role: 'tool', content: toolResultContent(result), toolCallId: call.id, name: call.name });
        }
        skipUnansweredCalls(res.toolCalls, scratch);
        ctx.stage = `agent:${opts.agent.id}`;
      }

      await ctx.deps.store.finishAgent(agentExecutionId, { status: 'completed', iterations, output: text });
      ctx.emit('agent.completed', {
        agentExecutionId,
        agentId: opts.agent.id,
        status: 'completed',
        durationMs: Date.now() - started,
      });
      return { text, agentExecutionId, iterations };
    } catch (err) {
      const cancelled = err instanceof RunCancelledError || ctx.signal.aborted;
      const error = err instanceof Error ? err.message : String(err);
      await ctx.deps.store
        .finishAgent(agentExecutionId, { status: cancelled ? 'cancelled' : 'failed', iterations, output: text, error })
        .catch(() => {});
      ctx.emit('agent.completed', {
        agentExecutionId,
        agentId: opts.agent.id,
        status: cancelled ? 'cancelled' : 'failed',
        durationMs: Date.now() - started,
        ...(cancelled ? {} : { error: 'Agent failed' }),
      });
      throw err;
    }
  });
}

/** Every tool call the model made must have a tool message, even if skipped by limits. */
function skipUnansweredCalls(calls: ToolCall[], scratch: ChatMessage[]) {
  const answered = new Set(scratch.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  for (const c of calls) {
    if (!answered.has(c.id)) {
      scratch.push({
        role: 'tool',
        toolCallId: c.id,
        name: c.name,
        content: JSON.stringify({ status: 'error', error: { code: 'loop_limit', message: 'Tool call limit reached' } }),
      });
    }
  }
}
