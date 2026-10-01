import { Ajv, type ValidateFunction } from 'ajv';
import { z } from 'zod';
import { runtimeMetrics, withSpan } from '@neuroflow/observability';
import { callModel, wantsJson, type RunContext } from './execution';

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

/** Strict parse of a structured answer: the whole output must be JSON (fences tolerated). */
export function parseStructuredOutput(text: string): { ok: true; value: unknown } | { ok: false } {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text);
  try {
    return { ok: true, value: JSON.parse((fenced ? fenced[1]! : text).trim()) };
  } catch {
    return { ok: false };
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCache = new WeakMap<object, ValidateFunction | null>();

function compileSchema(schema: Record<string, unknown>): ValidateFunction | null {
  if (!schemaCache.has(schema)) {
    try {
      schemaCache.set(schema, ajv.compile(schema));
    } catch {
      schemaCache.set(schema, null);
    }
  }
  return schemaCache.get(schema) ?? null;
}

/** Structured output validity: JSON response formats must parse and match their schema. */
export function structuredOutputIssues(ctx: RunContext, output: string): string[] {
  const fmt = ctx.request.responseFormat;
  if (!wantsJson(fmt) || !output.trim()) return [];
  const parsed = parseStructuredOutput(output);
  if (!parsed.ok) return ['The response is not valid JSON, but a JSON response was requested.'];
  if (typeof fmt === 'object' && fmt.type === 'json_schema') {
    const validate = compileSchema(fmt.schema);
    if (!validate) return ['The requested JSON Schema is invalid and could not be checked.'];
    if (!validate(parsed.value)) {
      const errs = (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
      return [`The JSON response does not match the requested schema: ${errs.join('; ')}.`];
    }
  }
  return [];
}

/** Execution trajectory: loops, repeated identical calls, limits, retries and fallbacks. */
export function trajectoryIssues(ctx: RunContext): string[] {
  const issues: string[] = [];
  const seen = new Map<string, number>();
  for (const s of ctx.trajectory) seen.set(s.argsKey, (seen.get(s.argsKey) ?? 0) + 1);
  const repeated = [...seen.entries()].filter(([, n]) => n >= 3);
  if (repeated.length) {
    issues.push(`The same tool call was repeated ${Math.max(...repeated.map(([, n]) => n))} times (possible loop).`);
  }
  if (ctx.toolLimitHit) issues.push('A tool-call or iteration limit was reached before the agent finished.');
  if (ctx.budget.used >= ctx.plan.budgets.maxModelCalls) issues.push('The run used its entire model-call budget.');
  return issues;
}

/** Policy compliance: tools the run was not allowed or authorised to use, and declined actions. */
export function policyIssues(ctx: RunContext): string[] {
  const issues: string[] = [];
  const by = (codes: string[]) => ctx.trajectory.filter((s) => s.errorCode && codes.includes(s.errorCode));
  const outside = by(['unauthorized', 'unknown_tool']);
  if (outside.length) {
    issues.push(`The model attempted ${outside.length} tool call(s) outside its allowed or authorised tools (${[...new Set(outside.map((s) => s.tool))].join(', ')}).`);
  }
  const declined = by(['approval_denied', 'approval_timeout']);
  if (declined.length) issues.push(`${declined.length} action(s) were not approved and did not run.`);
  const invalid = by(['invalid_arguments']);
  if (invalid.length) issues.push(`${invalid.length} tool call(s) had invalid arguments.`);
  return issues;
}

/** Coding signals from real tool events: test results, validation, user decisions on patches. */
export function codeIssues(ctx: RunContext): string[] {
  const s = ctx.code;
  if (!s) return [];
  const issues: string[] = [];
  if (s.lastTestPassed === false) issues.push('Tests are failing after the changes.');
  if (s.filesModified > 0 && s.testsRun === 0 && ctx.plan.toolPolicy.allowed.includes('run_tests')) {
    issues.push('The changes were not validated by tests.');
  }
  if (s.patchesRejected > 0) issues.push(`${s.patchesRejected} proposed change(s) were rejected by the user.`);
  if (s.patchesInvalid > 0) issues.push(`${s.patchesInvalid} generated patch(es) did not apply cleanly.`);
  return issues;
}

/** Always-on, zero-cost checks. Evaluation does not automatically mean another model call. */
export function heuristicEvaluation(ctx: RunContext, output: string): EvaluationVerdict {
  const issues: string[] = [];
  const empty = output.trim().length === 0 && !ctx.clientToolCalls?.length;
  if (empty) issues.push('The response is empty.');
  if (ctx.lastFinishReason === 'length') issues.push('The response was cut off by the output token limit.');
  if (ctx.lastFinishReason === 'content_filter') issues.push('The provider filtered part of the response.');
  if (ctx.toolFailures > 0) issues.push(`${ctx.toolFailures} tool call(s) did not succeed.`);
  const structured = structuredOutputIssues(ctx, output);
  issues.push(...structured, ...trajectoryIssues(ctx), ...policyIssues(ctx), ...codeIssues(ctx));
  return {
    kind: 'heuristic',
    verdict: empty ? 'failed' : issues.length > 0 ? 'needs_refinement' : 'passed',
    score: empty ? 0 : Math.max(0, 1 - issues.length * 0.2 - structured.length * 0.2),
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

/**
 * Heuristic checks plus, when requested, a model evaluation. Deterministic failures (empty output,
 * invalid structured output) are never overridden by the model evaluator.
 */
export async function evaluate(
  ctx: RunContext,
  task: string,
  output: string,
  kind: 'heuristic' | 'model',
  iteration: number,
): Promise<EvaluationVerdict> {
  return withSpan('evaluation.run', { 'evaluation.kind': kind, 'evaluation.iteration': iteration }, async (span) => {
    const heuristic = heuristicEvaluation(ctx, output);
    let verdict = heuristic;
    if (kind === 'model' && heuristic.verdict !== 'failed' && structuredOutputIssues(ctx, output).length === 0) {
      const model = await modelEvaluation(ctx, task, output);
      verdict = { ...model, issues: [...new Set([...model.issues, ...heuristic.issues])] };
      if (model.verdict === 'passed' && heuristic.verdict === 'needs_refinement') verdict.verdict = 'needs_refinement';
    }
    span.setAttributes({ 'evaluation.verdict': verdict.verdict, 'evaluation.issues': verdict.issues.length });
    return verdict;
  });
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
