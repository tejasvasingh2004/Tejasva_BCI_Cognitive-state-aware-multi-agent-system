import { z } from 'zod';
import {
  AgentStrategy,
  Density,
  ModelStrategy,
  ReasoningBudget,
  RequestedAgentStrategy,
  RequestedModelStrategy,
  RunMode,
  RunStatus,
} from './common';
import { ChatMessage, ToolCall, Usage } from './messages';
import { ModelRef, ModelRole } from './models';
import { CognitivePolicy } from './cognitive';
import { WorkspaceContext } from './code';

export const MAX_INPUT_CHARS = 32_000;
export const MAX_MESSAGES_PER_REQUEST = 200;

/**
 * Normalised run request. Every entry point (workspace UI, internal API, OpenAI-compatible API)
 * is converted into this shape before a run is created.
 *
 * With `conversationId`, `messages` are *new* messages appended to that conversation and history
 * is loaded server side. Without it, a conversation is created from `messages`.
 */
/** Requested output shape. JSON formats are validated by the evaluator (structured output validity). */
export const ResponseFormat = z.union([
  z.literal('text'),
  z.literal('json'),
  z.object({
    type: z.literal('json_schema'),
    name: z.string().max(64).optional(),
    schema: z.record(z.string(), z.unknown()),
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormat>;

/**
 * Tools defined and executed by an API client (OpenAI-compatible `tools`). NeuroFlow never executes
 * them: the model's calls are returned to the client, which sends results back as `tool` messages.
 */
export const ClientTool = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().max(2000).default(''),
  parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
});
export type ClientTool = z.infer<typeof ClientTool>;

export const ClientToolChoice = z.union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string() })]);
export type ClientToolChoice = z.infer<typeof ClientToolChoice>;

/** Optional per-run limits supplied by the caller (tighten, never loosen, server limits). */
export const RunBudgetRequest = z.object({
  maxCostUsd: z.number().positive().max(100).optional(),
  maxDurationMs: z.number().int().min(5_000).max(30 * 60_000).optional(),
});
export type RunBudgetRequest = z.infer<typeof RunBudgetRequest>;

export const RunRequest = z.object({
  conversationId: z.string().uuid().optional(),
  messages: z
    .array(ChatMessage.extend({ content: z.string().max(MAX_INPUT_CHARS) }))
    .min(1)
    .max(MAX_MESSAGES_PER_REQUEST),
  mode: RunMode.default('standard'),
  selectedModel: ModelRef.optional(),
  modelStrategy: RequestedModelStrategy.default('auto'),
  agentStrategy: RequestedAgentStrategy.default('auto'),
  /** Restricts the tools available to this run. Omitted = every tool the principal may use. */
  tools: z.array(z.string()).max(64).optional(),
  reasoningBudget: ReasoningBudget.optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().max(32_768).optional(),
  /** Run a specific (built-in or workspace) agent as the single agent. */
  agent: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional(),
  responseFormat: ResponseFormat.optional(),
  budget: RunBudgetRequest.optional(),
  clientTools: z.array(ClientTool).max(64).optional(),
  clientToolChoice: ClientToolChoice.optional(),
  /** Repository / code workspace context (Product Phase 2 code runs). */
  workspaceContext: WorkspaceContext.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * Async runs: when the run finishes (or waits for an approval) NeuroFlow posts a signed
   * `run.*` webhook here, in addition to the workspace's webhook endpoints.
   */
  webhookUrl: z.string().trim().url().max(2048).optional(),
  /**
   * Hedged first token: if a model call has produced no output after this many ms, the same call
   * also goes to the next model (usually the same model on another provider); the first to answer
   * wins. Lowers tail latency at the cost of extra prompt tokens.
   */
  hedgeAfterMs: z.number().int().min(100).max(60_000).optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;
export type RunRequestInput = z.input<typeof RunRequest>;

export const ModelAssignment = z.object({
  role: ModelRole,
  model: ModelRef,
  fallbacks: z.array(ModelRef),
});
export type ModelAssignment = z.infer<typeof ModelAssignment>;

export const TaskClass = z.enum([
  'conversational',
  'question',
  'memory',
  'tool',
  'analysis',
  'creative',
  'code',
  'complex',
]);
export type TaskClass = z.infer<typeof TaskClass>;

export const ExecutionPlan = z.object({
  mode: RunMode,
  taskClass: TaskClass,
  complexity: z.number().min(0).max(1),
  agentStrategy: AgentStrategy,
  modelStrategy: ModelStrategy,
  models: z.array(ModelAssignment).min(1),
  agents: z.array(z.string()),
  toolPolicy: z.object({
    allowed: z.array(z.string()),
    maxToolCalls: z.number().int().nonnegative(),
  }),
  contextPolicy: z.object({
    maxInputTokens: z.number().int().positive(),
    recentMessages: z.number().int().positive(),
    density: Density,
  }),
  reasoningBudget: ReasoningBudget,
  evaluationPolicy: z.object({
    kind: z.enum(['heuristic', 'model']),
    maxIterations: z.number().int().min(0).max(5),
  }),
  budgets: z.object({
    maxModelCalls: z.number().int().positive(),
    /** Tool calls across the whole run (each agent is additionally bounded by toolPolicy). */
    maxToolCalls: z.number().int().nonnegative(),
    maxDurationMs: z.number().int().positive(),
    maxCostUsd: z.number().positive().optional(),
  }),
  cognitive: CognitivePolicy.optional(),
  /** Short, human readable reasons behind routing decisions (not model reasoning). */
  rationale: z.array(z.string()),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlan>;

export const RunError = z.object({
  code: z.string(),
  message: z.string(),
  stage: z.string().optional(),
});
export type RunError = z.infer<typeof RunError>;

export const Run = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid().nullable(),
  mode: RunMode,
  status: RunStatus,
  request: RunRequest.omit({ messages: true }),
  executionPlan: ExecutionPlan.nullable(),
  output: z.string().nullable(),
  error: RunError.nullable(),
  usage: Usage.nullable(),
  /** Client-tool calls the run ended with (OpenAI `finish_reason: tool_calls`). */
  toolCalls: z.array(ToolCall).nullable(),
  attempt: z.number().int(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const CreateRunResponse = z.object({
  run: Run,
  conversationId: z.string().uuid(),
  eventsUrl: z.string(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;
