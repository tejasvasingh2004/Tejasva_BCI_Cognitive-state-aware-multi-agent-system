import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isPostgresReachable } from '@neuroflow/db/testing';
import { defaultScript } from '@neuroflow/models/testing';
import { api, runEvents, startHarness, type Harness } from './harness';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('Model Lab', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    h.qwen.setScript(defaultScript);
    h.qwen.requests.length = 0;
    h.groq.requests.length = 0;
  });

  it('lists providers and models with capabilities, and states fine-tuning availability honestly', async () => {
    const { providers } = await (await api(h, '/v1/model-lab/providers')).json();
    const qwen = providers.find((p: { id: string }) => p.id === 'qwen');
    expect(qwen).toMatchObject({ configured: true, kind: 'Ollama (local)', fineTuning: { status: 'not_available' } });
    expect(qwen.endpoint).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(providers.find((p: { id: string }) => p.id === 'groq').fineTuning.status).toBe('not_available');

    const { models } = await (await api(h, '/v1/model-lab/models')).json();
    const llama = models.find((m: { ref: string }) => m.ref === 'groq/llama-3.3-70b-versatile');
    expect(llama.supportedParameters).not.toContain('reasoningBudget');
    expect(models.find((m: { ref: string }) => m.ref === 'qwen/qwen3:8b').supportedParameters).toContain('reasoningBudget');

    const ft = await (await api(h, '/v1/model-lab/fine-tuning')).json();
    expect(ft.providers.every((p: { status: string }) => p.status !== 'available')).toBe(true);
    const job = await api(h, '/v1/model-lab/fine-tuning/jobs', {
      method: 'POST',
      json: { name: 'x', baseModel: 'groq/llama-3.3-70b-versatile', datasetId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(job.status).toBe(404);
  });

  it('applies parameter defaults and deployments to runs through the Gateway', async () => {
    const put = await api(h, '/v1/model-lab/configs/default', { method: 'PUT', json: { model: 'groq/llama-3.3-70b-versatile', temperature: 0.2 } });
    expect(put.status).toBe(200);
    const { run } = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'hello' }] } })).json();
    await runEvents(h, run.id);
    expect(h.groq.requests[0]).toMatchObject({ model: 'llama-3.3-70b-versatile', temperature: 0.2 });
    await api(h, '/v1/model-lab/configs/default', { method: 'PUT', json: { model: 'auto' } });

    const dep = await api(h, '/v1/model-lab/deployments', {
      method: 'POST',
      json: { name: 'support-bot', model: 'qwen/qwen3:8b', parameters: { temperature: 0.1, systemPrompt: 'You are the ACME support bot.' } },
    });
    expect(dep.status).toBe(201);
    expect((await api(h, '/v1/model-lab/deployments', { method: 'POST', json: { name: 'bad', model: 'groq/llama-3.3-70b-versatile', parameters: { reasoningBudget: 'high' } } })).status).toBe(400);
    h.qwen.requests.length = 0;
    const r2 = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'hi there' }], selectedModel: 'deployment/support-bot' } })).json();
    await runEvents(h, r2.run.id);
    expect(h.qwen.requests[0]).toMatchObject({ model: 'qwen3:8b', temperature: 0.1 });
    expect(String(h.qwen.requests[0]!.messages[0]!.content)).toContain('ACME support bot');
    expect((await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'x' }], selectedModel: 'deployment/nope' } })).status).toBe(404);
  });

  it('builds datasets only from explicit user actions and exports reviewed examples', async () => {
    const { id } = await (await api(h, '/v1/model-lab/datasets', { method: 'POST', json: { name: 'Support QA' } })).json();
    const imported = await (
      await api(h, `/v1/model-lab/datasets/${id}/import`, {
        method: 'POST',
        json: { jsonl: ['{"task":"capital of France","expected":"capital of france"}', '{"messages":[{"role":"user","content":"2+2"},{"role":"assistant","content":"2+2"}]}', 'not json'].join('\n') },
      })
    ).json();
    expect(imported.imported).toBe(2);
    expect(imported.errors[0]).toMatch(/line 3/);

    const { run } = await (await api(h, '/v1/runs', { method: 'POST', json: { messages: [{ role: 'user', content: 'what is dns?' }] } })).json();
    await runEvents(h, run.id);
    const fromRun = await (await api(h, `/v1/model-lab/datasets/${id}/examples/from-run`, { method: 'POST', json: { runId: run.id, outcome: 'accepted' } })).json();
    expect(fromRun.example).toMatchObject({ source: 'agent_interaction', task: 'what is dns?', outcome: 'accepted', reviewed: false });

    const detail = await (await api(h, `/v1/model-lab/datasets/${id}`)).json();
    expect(detail.dataset).toMatchObject({ examples: 3, reviewed: 0 });
    // Nothing is exported until a human reviewed it.
    expect(await (await api(h, `/v1/model-lab/datasets/${id}/export`)).text()).toBe('');
    await api(h, `/v1/model-lab/datasets/${id}/examples/${detail.examples[0].id}`, { method: 'PATCH', json: { reviewed: true } });
    const exported = (await (await api(h, `/v1/model-lab/datasets/${id}/export`)).text()).trim().split('\n');
    expect(exported).toHaveLength(1);
    expect(JSON.parse(exported[0]!).messages.at(-1)).toEqual({ role: 'assistant', content: 'capital of france' });
  });

  it('evaluates models on a dataset in the worker', async () => {
    const { id: datasetId } = await (await api(h, '/v1/model-lab/datasets', { method: 'POST', json: { name: 'Echo' } })).json();
    for (const task of ['alpha', 'beta']) {
      await api(h, `/v1/model-lab/datasets/${datasetId}/examples`, { method: 'POST', json: { task, expected: `answer to: ${task}` } });
    }
    const res = await api(h, '/v1/model-lab/evaluations', {
      method: 'POST',
      json: { name: 'Echo test', datasetId, models: ['qwen/qwen3:8b', 'groq/llama-3.3-70b-versatile'], scorer: 'contains' },
    });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    let evaluation;
    for (let i = 0; i < 100; i++) {
      evaluation = (await (await api(h, `/v1/model-lab/evaluations/${id}`)).json()).evaluation;
      if (evaluation.status === 'completed' || evaluation.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(evaluation.status).toBe('completed');
    expect(evaluation.results).toHaveLength(2);
    expect(evaluation.results[0]).toMatchObject({ model: 'qwen/qwen3:8b', passed: 2, total: 2, score: 1, costUsd: 0 });
    expect(evaluation.results[1].costUsd).toBeGreaterThan(0);
  });
});
