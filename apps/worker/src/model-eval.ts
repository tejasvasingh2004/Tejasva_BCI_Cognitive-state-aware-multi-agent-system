import type { DatasetExample, ModelEvaluationResult } from '@neuroflow/contracts';
import { modelLabRepo, type Pool } from '@neuroflow/db';
import type { ModelGateway } from '@neuroflow/models';
import type { Logger } from '@neuroflow/observability';

const MAX_EXAMPLES = 50;
const PER_CALL_TIMEOUT_MS = 120_000;

const JUDGE_PROMPT = `You grade an answer against a reference. Respond with only JSON {"pass": true|false}.
Pass when the answer is correct and covers the reference's key points; wording may differ.`;

function score(scorer: string, output: string, expected: string | null): boolean | null {
  if (expected === null) return null;
  const a = output.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  return scorer === 'exact' ? a === b : a.includes(b);
}

/**
 * Runs a Model Lab evaluation: every example against every selected model through the Model
 * Gateway (never provider SDKs), scored by containment, exact match or an LLM judge. Results are
 * persisted as they complete so the UI can show progress.
 */
export async function runModelEvaluation(deps: { pool: Pool; gateway: ModelGateway; logger: Logger; signal: AbortSignal }, evaluationId: string) {
  const evaluation = await modelLabRepo.getEvaluation(deps.pool, evaluationId);
  if (!evaluation || evaluation.status !== 'queued') return;
  await modelLabRepo.updateEvaluation(deps.pool, evaluationId, { status: 'running' });
  try {
    const examples: DatasetExample[] = (await modelLabRepo.listExamples(deps.pool, evaluation.datasetId, MAX_EXAMPLES));
    const judge = deps.gateway.defaultModel();
    const results: ModelEvaluationResult[] = [];
    for (const model of evaluation.models) {
      const samples: ModelEvaluationResult['samples'] = [];
      let cost: number | null = 0;
      for (const ex of examples) {
        if (deps.signal.aborted) throw new Error('Worker shutting down');
        const started = Date.now();
        try {
          const res = await deps.gateway.complete({
            model,
            fallbacks: [],
            messages: [...(ex.context ? [{ role: 'system' as const, content: ex.context }] : []), { role: 'user', content: ex.task }],
            maxOutputTokens: 1024,
            reasoningBudget: 'off',
            signal: AbortSignal.any([deps.signal, AbortSignal.timeout(PER_CALL_TIMEOUT_MS)]),
          });
          if (res.usage?.costUsd !== undefined && cost !== null) cost += res.usage.costUsd;
          else cost = null;
          let passed = score(evaluation.scorer, res.text, ex.expected);
          if (evaluation.scorer === 'judge' && judge) {
            const verdict = await deps.gateway
              .complete({
                model: judge,
                responseFormat: 'json',
                reasoningBudget: 'off',
                maxOutputTokens: 50,
                messages: [
                  { role: 'system', content: JUDGE_PROMPT },
                  { role: 'user', content: `TASK:\n${ex.task.slice(0, 4000)}\n\nREFERENCE:\n${(ex.expected ?? ex.output).slice(0, 4000)}\n\nANSWER:\n${res.text.slice(0, 6000)}` },
                ],
                signal: AbortSignal.any([deps.signal, AbortSignal.timeout(PER_CALL_TIMEOUT_MS)]),
              })
              .catch(() => null);
            passed = verdict ? /"pass"\s*:\s*true/i.test(verdict.text) : null;
          }
          samples.push({ exampleId: ex.id, passed: passed === true, latencyMs: Date.now() - started, output: res.text.slice(0, 2000) });
        } catch (err) {
          samples.push({ exampleId: ex.id, passed: false, latencyMs: Date.now() - started, output: '', error: err instanceof Error ? err.message.slice(0, 300) : 'failed' });
        }
      }
      const passed = samples.filter((s) => s.passed).length;
      const ok = samples.filter((s) => !s.error);
      results.push({
        model,
        passed,
        total: samples.length,
        score: samples.length ? Math.round((passed / samples.length) * 1000) / 1000 : 0,
        avgLatencyMs: ok.length ? Math.round(ok.reduce((n, s) => n + s.latencyMs, 0) / ok.length) : 0,
        costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
        errors: samples.length - ok.length,
        samples,
      });
      await modelLabRepo.updateEvaluation(deps.pool, evaluationId, { status: 'running', results });
    }
    await modelLabRepo.updateEvaluation(deps.pool, evaluationId, { status: 'completed', results });
  } catch (err) {
    deps.logger.warn({ err, evaluationId }, 'model evaluation failed');
    await modelLabRepo.updateEvaluation(deps.pool, evaluationId, { status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : 'failed' });
  }
}
