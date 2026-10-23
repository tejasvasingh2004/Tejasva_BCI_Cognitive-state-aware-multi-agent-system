import { ALL_SCOPES, type ChatMessage, type RunEvent, type RunEventType, type RunRequest } from '@neuroflow/contracts';
import { DefaultModelGateway, GroqAdapter, QwenAdapter, buildCatalog } from '@neuroflow/models';
import { builtinTools, ToolRegistry, ToolRuntime } from '@neuroflow/tools';
import type { MockOpenAIServer } from '@neuroflow/models/testing';
import type { CognitiveStateProvider } from '@neuroflow/cognitive';
import { Orchestrator, planExecution, type OrchestratorDeps, type RunStore } from '../src';

export class MemoryStore implements RunStore {
  plans: unknown[] = [];
  agents: Array<{ id: string; agentId: string; role: string; model: string; status?: string }> = [];
  modelCalls: Array<{ role: string; model: string; provider: string; status: string }> = [];
  evaluations: Array<{ verdict: string; kind: string }> = [];
  async setPlan(_id: string, plan: unknown) {
    this.plans.push(plan);
  }
  async startAgent(i: { agentId: string; role: string; model: string }) {
    const id = `ae-${this.agents.length + 1}`;
    this.agents.push({ id, ...i });
    return id;
  }
  async finishAgent(id: string, i: { status: string }) {
    const a = this.agents.find((x) => x.id === id);
    if (a) a.status = i.status;
  }
  async recordModelCall(i: { role: string; model: string; provider: string; status: string }) {
    this.modelCalls.push(i);
  }
  async recordEvaluation(i: { verdict: string; kind: string }) {
    this.evaluations.push(i);
  }
}

export function makeGateway(qwen: MockOpenAIServer, groq?: MockOpenAIServer) {
  return new DefaultModelGateway(
    [
      new QwenAdapter({ baseUrl: qwen.url, flavor: 'ollama', models: buildCatalog('qwen3:8b', 'toggle') }),
      ...(groq
        ? [new GroqAdapter({ baseUrl: groq.url, apiKey: 'k', models: buildCatalog('llama-3.3-70b-versatile') })]
        : []),
    ],
    { baseBackoffMs: 1, maxBackoffMs: 2, defaultModel: 'qwen/qwen3:8b' },
  );
}

export function makeOrchestrator(opts: {
  qwen: MockOpenAIServer;
  groq?: MockOpenAIServer;
  cognitive?: CognitiveStateProvider;
  approvals?: ConstructorParameters<typeof ToolRuntime>[1];
  loadAgents?: OrchestratorDeps['loadAgents'];
}) {
  const store = new MemoryStore();
  const registry = new ToolRegistry().registerAll(builtinTools);
  const orchestrator = new Orchestrator({
    gateway: makeGateway(opts.qwen, opts.groq),
    tools: new ToolRuntime(registry, opts.approvals),
    store,
    ...(opts.cognitive ? { cognitive: opts.cognitive } : {}),
    ...(opts.loadAgents ? { loadAgents: opts.loadAgents } : {}),
  });
  return { orchestrator, store };
}

export function runInput(
  text: string,
  request: Partial<Omit<RunRequest, 'messages'>> = {},
  opts: { signal?: AbortSignal; history?: ChatMessage[]; mode?: 'standard' | 'cognitive' } = {},
) {
  const events: RunEvent[] = [];
  let seq = 0;
  const mode = opts.mode ?? request.mode ?? 'standard';
  return {
    events,
    input: {
      run: { id: 'run-1', workspaceId: 'ws', userId: 'u', conversationId: 'c', mode },
      request: { mode, agentStrategy: 'auto', modelStrategy: 'auto', ...request } as Omit<RunRequest, 'messages'>,
      history: [...(opts.history ?? []), { role: 'user' as const, content: text }],
      scopes: [...ALL_SCOPES],
      signal: opts.signal ?? new AbortController().signal,
      emit: (type: RunEventType, data: unknown) =>
        events.push({ runId: 'run-1', seq: ++seq, ts: new Date().toISOString(), type, data } as RunEvent),
    },
  };
}

export const types = (events: RunEvent[]) => events.map((e) => e.type);
export const streamed = (events: RunEvent[]) => {
  let text = '';
  for (const e of events) {
    if (e.type === 'response.delta') text += e.data.text;
    if (e.type === 'response.reset') text = '';
  }
  return text;
};

/** A routed plan for context-building tests (two local models, standard mode). */
export function planFor(lastUserMessage = 'hello') {
  const model = (ref: string, tier: 'fast' | 'balanced' | 'strong') => ({
    ref,
    provider: ref.split('/')[0]!,
    model: ref.split('/').slice(1).join('/'),
    displayName: ref,
    tier,
    contextWindow: 32_768,
    capabilities: { tools: true, reasoning: false, streaming: true },
    available: true,
  });
  const plan = planExecution({
    mode: 'standard',
    request: { agentStrategy: 'auto', modelStrategy: 'auto' },
    models: [model('qwen/qwen3:8b', 'balanced'), model('groq/openai/gpt-oss-120b', 'strong')],
    defaultModel: 'qwen/qwen3:8b',
    availableTools: ['calculator'],
    lastUserMessage,
  });
  return { plan };
}
