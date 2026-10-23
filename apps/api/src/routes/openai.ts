import type { FastifyInstance } from 'fastify';
import {
  AUTO_MODEL_ALIASES,
  OpenAIChatCompletionRequest,
  RequestedAgentStrategy,
  RunRequest,
  Scopes,
  type ChatMessage,
  type OpenAIChatMessage,
  type ReasoningBudget,
  type RunEvent,
  type ToolCall,
} from '@neuroflow/contracts';
import { runsRepo } from '@neuroflow/db';
import { requireScope } from '../auth';
import { type AppDeps, modelScope } from '../deps';
import { HttpError } from '../errors';
import { serveGatewayCompletion } from '../gateway-mode';
import type { RunManager } from '../run-manager';
import { openSse } from '../sse';

/**
 * OpenAI-compatible interoperability boundary. Requests are normalised into NeuroFlow runs and
 * executed by the normal runtime (queue → worker → orchestrator → Model Gateway).
 */
export async function openaiRoutes(app: FastifyInstance, deps: AppDeps, runs: RunManager) {
  app.get('/v1/models', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const scope = await modelScope(deps, p.workspaceId);
    const models = deps.gateway.listModels(scope);
    return {
      object: 'list',
      default: deps.gateway.defaultModel(scope) ?? null,
      data: [
        {
          id: 'neuroflow-auto',
          object: 'model',
          owned_by: 'neuroflow',
          created: 0,
          display_name: 'Auto',
          available: models.some((m) => m.available),
        },
        ...models.map((m) => ({
          id: m.ref,
          object: 'model',
          owned_by: m.provider,
          created: 0,
          display_name: m.displayName,
          tier: m.tier,
          context_window: m.contextWindow,
          capabilities: m.capabilities,
          available: m.available,
        })),
      ],
    };
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const principal = requireScope(req, Scopes.runsWrite);
    const body = OpenAIChatCompletionRequest.parse(req.body);
    const auto = AUTO_MODEL_ALIASES.includes(body.model);
    // The workspace's own view: models of providers it has keys for count, not only platform ones.
    if (!auto && !deps.gateway.listModels(await modelScope(deps, principal.workspaceId)).some((m) => m.ref === body.model)) {
      throw new HttpError('not_found', `The model "${body.model}" does not exist. Use GET /v1/models or "neuroflow-auto".`);
    }

    const messages = body.messages.map(toChatMessage).filter((m): m is ChatMessage => m !== null);
    if (!messages.some((m) => m.role === 'user')) throw new HttpError('bad_request', 'At least one user message is required');

    // Gateway mode: one model call served by this process (no queue, no agents or server tools).
    const gatewayMode = deps.config.GATEWAY_FAST_PATH === 'enabled' && (body.neuroflow?.gateway === true || req.headers['x-neuroflow-mode'] === 'gateway');
    if (gatewayMode) {
      const rf = mapResponseFormat(body).responseFormat;
      return serveGatewayCompletion(
        req,
        reply,
        deps,
        principal,
        {
          ...(auto ? {} : { model: body.model }),
          displayModel: body.model,
          messages,
          ...(body.tools?.length
            ? {
                tools: body.tools.map((t) => ({ name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters ?? { type: 'object', properties: {} } })),
                toolChoice: body.tool_choice === 'none' ? 'none' : body.tool_choice === 'required' || typeof body.tool_choice === 'object' ? 'required' : 'auto',
              }
            : {}),
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          ...((body.max_completion_tokens ?? body.max_tokens) ? { maxOutputTokens: body.max_completion_tokens ?? body.max_tokens } : {}),
          ...(body.reasoning_effort ? { reasoningBudget: mapEffort(body.reasoning_effort) } : {}),
          ...(rf ? { responseFormat: 'json' as const } : {}),
          stream: Boolean(body.stream),
          ...(body.neuroflow?.cache_ttl_seconds ? { cacheTtlSeconds: body.neuroflow.cache_ttl_seconds } : {}),
          options: { ...(body.metadata ? { metadata: body.metadata } : {}), ...(auto ? {} : { selectedModel: body.model }) },
        },
        () => runs.admitGatewayCall(principal),
      );
    }

    const strategy = RequestedAgentStrategy.safeParse(body.neuroflow?.agent_strategy ?? 'auto');
    const request = RunRequest.parse({
      messages,
      conversationId: body.neuroflow?.conversation_id,
      mode: body.neuroflow?.mode ?? 'standard',
      agentStrategy: strategy.success ? strategy.data : 'auto',
      ...(auto ? {} : { selectedModel: body.model }),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...((body.max_completion_tokens ?? body.max_tokens) ? { maxOutputTokens: body.max_completion_tokens ?? body.max_tokens } : {}),
      ...(body.reasoning_effort ? { reasoningBudget: mapEffort(body.reasoning_effort) } : {}),
      ...mapTools(body),
      ...mapResponseFormat(body),
      // OpenAI streaming cannot retract text, so strategies must only ever append.
      metadata: { ...(body.metadata ?? {}), 'neuroflow.appendOnly': true },
    });

    const { run } = await runs.create(principal, request, {
      source: 'openai',
      idempotencyKey: req.headers['idempotency-key'] as string | undefined,
    });
    const id = `chatcmpl-${run.id}`;
    const created = Math.floor(Date.now() / 1000);

    if (body.stream) {
      const sse = openSse(req, reply);
      let finished = false;
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
        sse.send({
          data: { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra },
        });
      chunk({ role: 'assistant', content: '' }, null);
      const stop = await deps.hub.follow(run.id, 0, (event) => {
        if (event.type === 'response.delta') chunk({ content: event.data.text }, null);
        else if (event.type === 'run.completed') {
          finished = true;
          if (event.data.toolCalls?.length) {
            chunk({ tool_calls: event.data.toolCalls.map((c, index) => ({ index, ...toOpenAIToolCall(c) })) }, null);
            chunk({}, 'tool_calls');
          } else {
            chunk({}, 'stop');
          }
          if (event.data.usage) {
            sse.send({
              data: { id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: toOpenAIUsage(event.data.usage) },
            });
          }
          sse.send({ data: '[DONE]' });
          setImmediate(() => sse.close());
        } else if (event.type === 'run.failed' || event.type === 'run.cancelled') {
          finished = true;
          const message = event.type === 'run.failed' ? event.data.error.message : 'Run cancelled';
          sse.send({ data: { error: { message, type: 'server_error', code: event.type === 'run.failed' ? event.data.error.code : 'cancelled' } } });
          sse.send({ data: '[DONE]' });
          setImmediate(() => sse.close());
        }
      });
      sse.onClose(() => {
        void stop();
        // A client that disconnects mid-stream no longer wants the result.
        if (!finished) void runs.cancel(principal, run.id).catch(() => {});
      });
      if (sse.closed) void stop();
      return;
    }

    const terminal = await waitForTerminal(deps, run.id, deps.config.RUN_WAIT_TIMEOUT_MS, () => req.raw.destroyed);
    if (!terminal) {
      await runs.cancel(principal, run.id).catch(() => {});
      throw new HttpError('unavailable', 'The run did not finish in time and was cancelled', undefined, true);
    }
    const final = (await runsRepo.get(deps.pool, run.id))!;
    if (final.status !== 'completed') {
      throw new HttpError(final.status === 'cancelled' ? 'conflict' : 'unavailable', final.error?.message ?? `Run ${final.status}`, {
        run_id: run.id,
        code: final.error?.code,
      });
    }
    const primary = final.executionPlan?.models.find((m) => m.role !== 'evaluator')?.model ?? body.model;
    const toolCalls = final.toolCalls ?? [];
    return {
      id,
      object: 'chat.completion',
      created,
      model: auto ? primary : body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: toolCalls.length && !final.output ? null : (final.output ?? ''),
            ...(toolCalls.length ? { tool_calls: toolCalls.map(toOpenAIToolCall) } : {}),
          },
          finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: toOpenAIUsage(final.usage ?? undefined),
      neuroflow: {
        run_id: run.id,
        conversation_id: final.conversationId,
        strategy: final.executionPlan?.agentStrategy,
        models: [...new Set(final.executionPlan?.models.map((m) => m.model) ?? [])],
        ...(final.usage?.costUsd !== undefined ? { cost_usd: final.usage.costUsd } : {}),
      },
    };
  });
}

function toChatMessage(m: OpenAIChatMessage): ChatMessage | null {
  const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('');
  switch (m.role) {
    case 'system':
    case 'developer':
      return { role: 'system', content: text };
    case 'user':
      return { role: 'user', content: text };
    case 'assistant': {
      // Client-side tool calls are kept so the model sees its own calls next to their results.
      const toolCalls = m.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
      if (!text && !toolCalls?.length) return null;
      return { role: 'assistant', content: text, ...(toolCalls?.length ? { toolCalls } : {}) };
    }
    case 'tool':
      return m.tool_call_id ? { role: 'tool', content: text, toolCallId: m.tool_call_id, ...(m.name ? { name: m.name } : {}) } : null;
    default:
      return null;
  }
}

function mapTools(body: OpenAIChatCompletionRequest) {
  if (!body.tools?.length) return {};
  const choice = body.tool_choice;
  return {
    clientTools: body.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    })),
    ...(choice ? { clientToolChoice: typeof choice === 'string' ? choice : { name: choice.function.name } } : {}),
  };
}

function mapResponseFormat(body: OpenAIChatCompletionRequest) {
  const rf = body.response_format;
  if (!rf || rf.type === 'text') return {};
  if (rf.type === 'json_object') return { responseFormat: 'json' as const };
  return {
    responseFormat: {
      type: 'json_schema' as const,
      schema: rf.json_schema.schema,
      ...(rf.json_schema.name ? { name: rf.json_schema.name } : {}),
    },
  };
}

function toOpenAIToolCall(c: ToolCall) {
  return { id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } };
}

function mapEffort(effort: string): ReasoningBudget {
  if (effort === 'none' || effort === 'minimal') return 'off';
  return effort as ReasoningBudget;
}

function toOpenAIUsage(u?: { promptTokens: number; completionTokens: number; totalTokens: number }) {
  return u
    ? { prompt_tokens: u.promptTokens, completion_tokens: u.completionTokens, total_tokens: u.totalTokens }
    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

async function waitForTerminal(deps: AppDeps, runId: string, timeoutMs: number, aborted: () => boolean): Promise<RunEvent | null> {
  return new Promise((resolve) => {
    let stop: (() => Promise<void>) | undefined;
    let finished = false;
    const done = (e: RunEvent | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(watch);
      void stop?.();
      resolve(e);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const watch = setInterval(() => aborted() && done(null), 1000);
    void deps.hub
      .follow(runId, 0, (e) => {
        if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled') done(e);
      })
      .then((s) => {
        stop = s;
        // The terminal event may already have been replayed before the subscription resolved.
        if (finished) void s();
      });
  });
}
