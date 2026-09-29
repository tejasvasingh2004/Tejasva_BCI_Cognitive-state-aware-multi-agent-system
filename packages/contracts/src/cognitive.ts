import { z } from 'zod';
import { AgentStrategy, Density } from './common';

export const WorkloadLevel = z.enum(['low', 'medium', 'high']);
export type WorkloadLevel = z.infer<typeof WorkloadLevel>;

export const CognitiveSource = z.enum(['manual', 'bci', 'interaction']);
export type CognitiveSource = z.infer<typeof CognitiveSource>;

export const CognitiveState = z.object({
  workload: WorkloadLevel,
  confidence: z.number().min(0).max(1),
  source: CognitiveSource,
  observedAt: z.string(),
});
export type CognitiveState = z.infer<typeof CognitiveState>;

/** Bounded execution preferences derived from cognitive state. Never a direct model command. */
export const CognitivePolicy = z.object({
  workload: WorkloadLevel,
  contextDensity: Density,
  responseDensity: Density,
  taskChunking: Density,
  uiDensity: z.enum(['full', 'reduced', 'minimal']),
  notificationIntensity: Density,
  /** Upper bound for automatically selected strategies. Explicit user choices are respected. */
  maxAutoStrategy: AgentStrategy,
  evaluation: z.enum(['heuristic', 'model']),
  presentationInstructions: z.string(),
});
export type CognitivePolicy = z.infer<typeof CognitivePolicy>;

export const SetCognitiveStateBody = z.object({
  workload: WorkloadLevel,
  source: CognitiveSource.default('manual'),
  confidence: z.number().min(0).max(1).default(1),
});
export type SetCognitiveStateBody = z.infer<typeof SetCognitiveStateBody>;
