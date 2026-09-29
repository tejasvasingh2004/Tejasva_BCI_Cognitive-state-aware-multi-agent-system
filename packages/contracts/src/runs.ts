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
import { ChatMessage, Usage } from './messages';
import { ModelRef, ModelRole } from './models';
import { CognitivePolicy } from './cognitive';

export const MAX_INPUT_CHARS = 32_000;
export const MAX_MESSAGES_PER_REQUEST = 200;

/**
 * Normalised run request. Every entry point (workspace UI, internal API, OpenAI-compatible API)
 * is converted into this shape before a run is created.
 *
 * With `conversationId`, `messages` are *new* messages appended to that conversation and history
 * is loaded server side. Without it, a conversation is created from `messages`.
 */
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
  metadata: z.record(z.string(), z.unknown()).optional(),
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
    maxDurationMs: z.number().int().positive(),
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
