import type { AgentStrategy, CognitivePolicy, CognitiveState, WorkloadLevel } from '@neuroflow/contracts';

/**
 * Converts cognitive state into bounded execution preferences. Ported from the original
 * workload policies (LOW → verbose, MEDIUM → balanced + verification, HIGH → bullet points +
 * stricter verification), but expressed as policy rather than a hard-wired agent graph.
 * Policies never touch authentication, authorization, tool permissions or approvals.
 */
const POLICIES: Record<WorkloadLevel, Omit<CognitivePolicy, 'workload'>> = {
  low: {
    contextDensity: 'high',
    responseDensity: 'high',
    taskChunking: 'low',
    uiDensity: 'full',
    notificationIntensity: 'medium',
    maxAutoStrategy: 'supervisor',
    evaluation: 'heuristic',
    presentationInstructions:
      'The user currently has spare attention. A thorough, well-structured explanation is welcome: use headings where helpful and include relevant detail and examples.',
  },
  medium: {
    contextDensity: 'medium',
    responseDensity: 'medium',
    taskChunking: 'medium',
    uiDensity: 'reduced',
    notificationIntensity: 'low',
    maxAutoStrategy: 'sequential',
    evaluation: 'model',
    presentationInstructions:
      'The user is moderately busy. Give a balanced answer: lead with the key point, keep paragraphs short, and include only the most useful detail.',
  },
  high: {
    contextDensity: 'low',
    responseDensity: 'low',
    taskChunking: 'high',
    uiDensity: 'minimal',
    notificationIntensity: 'low',
    maxAutoStrategy: 'single_agent',
    evaluation: 'model',
    presentationInstructions:
      'The user is under high cognitive load. Start with a one or two sentence answer, then at most five short bullet points. No preamble, no repetition. If the task has several parts, handle only the first step and offer to continue.',
  },
};

export function derivePolicy(state: CognitiveState): CognitivePolicy {
  // Low-confidence estimates are softened toward the middle to avoid over-reacting to noise.
  const workload: WorkloadLevel = state.confidence < 0.4 && state.workload !== 'medium' ? 'medium' : state.workload;
  return { workload, ...POLICIES[workload] };
}

const STRATEGY_ORDER: AgentStrategy[] = [
  'direct',
  'single_agent',
  'sequential',
  'parallel',
  'evaluator_optimizer',
  'supervisor',
];

/** Caps an automatically chosen strategy at the policy's maximum. */
export function capStrategy(strategy: AgentStrategy, max: AgentStrategy): AgentStrategy {
  return STRATEGY_ORDER.indexOf(strategy) > STRATEGY_ORDER.indexOf(max) ? max : strategy;
}
