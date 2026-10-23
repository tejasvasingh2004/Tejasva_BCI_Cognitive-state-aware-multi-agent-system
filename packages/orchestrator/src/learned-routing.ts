import type { ModelInfo, TaskClass } from '@neuroflow/contracts';

/** Measured outcomes of one primary model on one task class (recent runs). */
export type ModelOutcome = {
  ref: string;
  /** Runs with a quality signal (evaluation score, or failure). */
  samples: number;
  /** Mean quality in [0, 1]: evaluation score; failed runs count as 0. */
  quality: number;
  /** Mean estimated cost per run (USD); undefined when unpriced. */
  costUsd?: number;
  /** Mean run duration (ms). */
  latencyMs?: number;
};

export type LearnedRouting = {
  byTask: Partial<Record<TaskClass, ModelOutcome[]>>;
  /** Minimum samples before a model's outcomes are trusted (default 20). */
  minSamples?: number;
  /** Quality a cheaper model may give up against the best measured one (default 0.05). */
  tolerance?: number;
  /** Share of eligible requests sent to an under-sampled model to keep learning (default 0.05). */
  exploration?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
};

const TIER = { fast: 0, balanced: 1, strong: 2 } as const;

/**
 * Learned routing (after RouteLLM: route to the cheapest model that keeps quality). Among
 * available models with enough measured runs for this task class, choose the cheapest whose mean
 * quality is within `tolerance` of the best; ties go to the faster one. A small exploration share
 * tries under-sampled models of comparable strength so the measurements keep coming. Returns
 * undefined when there is nothing to learn from yet.
 */
export function learnedPrimary(
  available: ModelInfo[],
  taskClass: TaskClass,
  fallback: ModelInfo,
  learned: LearnedRouting,
  rationale: string[],
): ModelInfo | undefined {
  const minSamples = learned.minSamples ?? 20;
  const byRef = new Map(available.map((m) => [m.ref, m]));
  const outcomes = (learned.byTask[taskClass] ?? []).filter((o) => byRef.has(o.ref));
  const trusted = outcomes.filter((o) => o.samples >= minSamples);

  let pick: ModelInfo | undefined;
  if (trusted.length > 0) {
    const best = Math.max(...trusted.map((o) => o.quality));
    const tolerance = learned.tolerance ?? 0.05;
    const good = trusted.filter((o) => o.quality >= best - tolerance);
    const cost = (o: ModelOutcome) => o.costUsd ?? Number.POSITIVE_INFINITY;
    good.sort((a, b) => cost(a) - cost(b) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || b.quality - a.quality);
    const chosen = good[0]!;
    pick = byRef.get(chosen.ref)!;
    const bestRef = trusted.find((o) => o.quality === best)!;
    rationale.push(
      chosen.ref === bestRef.ref
        ? `Learned routing: ${chosen.ref} has the best measured quality for ${taskClass} tasks (${chosen.quality.toFixed(2)} over ${chosen.samples} runs)`
        : `Learned routing: ${chosen.ref} matches the best measured quality for ${taskClass} tasks (${chosen.quality.toFixed(2)} vs ${best.toFixed(2)}) at lower cost`,
    );
  }

  // Exploration: occasionally try a comparable model with too few measurements.
  const anchor = pick ?? fallback;
  const sampled = new Map(outcomes.map((o) => [o.ref, o.samples]));
  const explore = learned.exploration ?? 0.05;
  if (explore > 0 && (learned.random ?? Math.random)() < explore) {
    const candidates = available
      .filter((m) => m.ref !== anchor.ref && (sampled.get(m.ref) ?? 0) < minSamples && Math.abs(TIER[m.tier] - TIER[anchor.tier]) <= 1)
      .sort((a, b) => (sampled.get(a.ref) ?? 0) - (sampled.get(b.ref) ?? 0));
    const trial = candidates[0];
    if (trial) {
      rationale.push(`Learned routing: exploring ${trial.ref} (${sampled.get(trial.ref) ?? 0} measured ${taskClass} runs so far)`);
      return trial;
    }
  }
  return pick;
}
