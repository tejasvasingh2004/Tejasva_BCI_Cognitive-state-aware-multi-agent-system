import { z } from 'zod';
import { runtimeMetrics } from '@neuroflow/observability';
import { callModel, type RunContext } from './execution';

export type EvaluationVerdict = {
  verdict: 'passed' | 'failed' | 'needs_refinement';
  score?: number;
  issues: string[];
  kind: 'heuristic' | 'model';
};

/** Extracts a JSON object from model output (tolerates code fences / surrounding prose). */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Always-on, zero-cost checks. Evaluation does not automatically mean another model call. */
export function heuristicEvaluation(ctx: RunContext, output: string): EvaluationVerdict {
  const issues: string[] = [];
  if (output.trim().length === 0) issues.push('The response is empty.');
  if (ctx.lastFinishReason === 'length') issues.push('The response was cut off by the output token limit.');
  if (ctx.lastFinishReason === 'content_filter') issues.push('The provider filtered part of the response.');
  if (ctx.toolFailures > 0) issues.push(`${ctx.toolFailures} tool call(s) did not succeed.`);
  const fatal = output.trim().length === 0;
  return {
    kind: 'heuristic',
    verdict: fatal ? 'failed' : issues.length > 0 ? 'needs_refinement' : 'passed',
    score: fatal ? 0 : Math.max(0, 1 - issues.length * 0.25),
    issues,
  };
}

const ModelVerdict = z.object({
  verdict: z.enum(['passed', 'failed', 'needs_refinement']),
  score: z.coerce.number().min(0).max(1).optional(),
  issues: z.array(z.string()).max(10).default([]),
});

const EVALUATOR_PROMPT = `You are an evaluator. Judge whether the ANSWER correctly and completely addresses the TASK and follows its instructions.
Respond with only a JSON object: {"verdict":"passed"|"needs_refinement"|"failed","score":0..1,"issues":["short, specific problems"]}.
Use "needs_refinement" when the answer is fixable, "failed" when it is wrong or off-topic.`;

export async function modelEvaluation(ctx: RunContext, task: string, answer: string): Promise<EvaluationVerdict> {
  const res = await callModel(ctx, {
    role: 'evaluator',
    streamToUser: false,
    responseFormat: 'json',
    maxOutputTokens: 400,
    messages: [
      { role: 'system', content: EVALUATOR_PROMPT },
      { role: 'user', content: `TASK:\n${task.slice(0, 6000)}\n\nANSWER:\n${answer.slice(0, 12000)}` },
    ],
  });
  const parsed = ModelVerdict.safeParse(parseJsonObject(res.text));
  if (!parsed.success) {
    // An unparseable evaluation must not fail the run; record it as inconclusive.
    return { kind: 'model', verdict: 'passed', issues: ['Evaluator output could not be parsed'] };
  }
  return { kind: 'model', ...parsed.data };
}

export async function recordEvaluation(ctx: RunContext, v: EvaluationVerdict, iteration: number) {
  runtimeMetrics.evaluations.add(1, { kind: v.kind, verdict: v.verdict });
  ctx.emit('evaluation.completed', {
    kind: v.kind,
    iteration,
    verdict: v.verdict,
    issues: v.issues,
    ...(v.score !== undefined ? { score: v.score } : {}),
  });
  await ctx.deps.store.recordEvaluation({
    runId: ctx.run.id,
    kind: v.kind,
    iteration,
    verdict: v.verdict,
    score: v.score,
    issues: v.issues,
  });
}
