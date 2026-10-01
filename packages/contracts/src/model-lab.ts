import { z } from 'zod';
import { ReasoningBudget, RequestedAgentStrategy } from './common';

/**
 * Model Lab (Product Phase 2): configures the existing Model Gateway. React never calls provider
 * SDKs; every model call still goes through the Gateway and the runtime.
 */

/** Surfaces whose defaults can be configured. */
export const ModelLabScope = z.enum(['default', 'code_agent']);
export type ModelLabScope = z.infer<typeof ModelLabScope>;

export const ModelLabConfig = z.object({
  /** "auto", a model ref (`qwen/qwen3:8b`) or a deployment (`deployment/<name>`). */
  model: z.string().max(200).default('auto'),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().max(32_768).optional(),
  reasoningBudget: ReasoningBudget.optional(),
  agentStrategy: RequestedAgentStrategy.optional(),
  /** Tool allow-list for this surface (null = every permitted tool). */
  tools: z.array(z.string()).max(64).nullable().default(null),
  /** Context strategy: how many recent messages to keep. */
  recentMessages: z.number().int().min(2).max(100).optional(),
});
export type ModelLabConfig = z.infer<typeof ModelLabConfig>;

export const ModelDeployment = z.object({
  id: z.string().uuid(),
  name: z.string(),
  model: z.string(),
  parameters: z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().max(32_768).optional(),
    reasoningBudget: ReasoningBudget.optional(),
    systemPrompt: z.string().max(4000).optional(),
  }),
  description: z.string(),
  status: z.enum(['active', 'disabled']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelDeployment = z.infer<typeof ModelDeployment>;

export const UpsertDeploymentBody = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'lowercase letters, digits and dashes'),
  model: z.string().regex(/^[a-z0-9_-]+\/.+$/, 'expected "<provider>/<model>"'),
  parameters: ModelDeployment.shape.parameters.default({}),
  description: z.string().max(500).default(''),
  status: z.enum(['active', 'disabled']).default('active'),
});

export const DatasetExampleSource = z.enum(['manual', 'import', 'agent_interaction', 'accepted_patch', 'rejected_patch', 'test_failure', 'successful_fix', 'conversation']);

export const DatasetExample = z.object({
  id: z.string().uuid(),
  source: DatasetExampleSource,
  sourceRunId: z.string().uuid().nullable(),
  task: z.string(),
  context: z.string().nullable(),
  output: z.string(),
  expected: z.string().nullable(),
  outcome: z.enum(['accepted', 'rejected', 'neutral']).nullable(),
  reviewed: z.boolean(),
  createdAt: z.string(),
});
export type DatasetExample = z.infer<typeof DatasetExample>;

export const Dataset = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  examples: z.number().int(),
  reviewed: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Dataset = z.infer<typeof Dataset>;

export const CreateDatasetBody = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).default('') });

export const AddExampleBody = z.object({
  task: z.string().trim().min(1).max(20_000),
  context: z.string().max(40_000).optional(),
  output: z.string().max(40_000).default(''),
  expected: z.string().max(20_000).optional(),
  outcome: z.enum(['accepted', 'rejected', 'neutral']).optional(),
});

/** Explicit user action: turn one recorded run into a candidate example. */
export const ExampleFromRunBody = z.object({
  runId: z.string().uuid(),
  outcome: z.enum(['accepted', 'rejected', 'neutral']).default('neutral'),
  expected: z.string().max(20_000).optional(),
});

export const ImportExamplesBody = z.object({ jsonl: z.string().min(1).max(5_000_000) });

export const EvaluationScorer = z.enum(['contains', 'exact', 'judge']);

export const ModelEvaluationResult = z.object({
  model: z.string(),
  passed: z.number().int(),
  total: z.number().int(),
  score: z.number(),
  avgLatencyMs: z.number(),
  costUsd: z.number().nullable(),
  errors: z.number().int(),
  samples: z.array(z.object({ exampleId: z.string(), passed: z.boolean(), latencyMs: z.number(), output: z.string(), error: z.string().optional() })),
});
export type ModelEvaluationResult = z.infer<typeof ModelEvaluationResult>;

export const ModelEvaluation = z.object({
  id: z.string().uuid(),
  name: z.string(),
  datasetId: z.string().uuid(),
  models: z.array(z.string()),
  scorer: EvaluationScorer,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  results: z.array(ModelEvaluationResult),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ModelEvaluation = z.infer<typeof ModelEvaluation>;

export const CreateEvaluationBody = z.object({
  name: z.string().trim().min(1).max(100),
  datasetId: z.string().uuid(),
  models: z.array(z.string().regex(/^[a-z0-9_-]+\/.+$/)).min(1).max(4),
  scorer: EvaluationScorer.default('contains'),
});

export const FineTuningJob = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: z.string(),
  baseModel: z.string(),
  datasetId: z.string().uuid(),
  status: z.enum(['queued', 'validating', 'running', 'succeeded', 'failed', 'cancelled']),
  progress: z.number().nullable(),
  metrics: z.record(z.string(), z.unknown()),
  resultModel: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FineTuningJob = z.infer<typeof FineTuningJob>;

export const CreateFineTuningJobBody = z.object({
  name: z.string().trim().min(1).max(100),
  baseModel: z.string().regex(/^[a-z0-9_-]+\/.+$/),
  datasetId: z.string().uuid(),
  config: z.object({ epochs: z.number().int().min(1).max(20).optional(), learningRateMultiplier: z.number().positive().max(10).optional() }).default({}),
});
