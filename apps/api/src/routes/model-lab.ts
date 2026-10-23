import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AddExampleBody,
  CreateDatasetBody,
  CreateEvaluationBody,
  CreateFineTuningJobBody,
  ExampleFromRunBody,
  ImportExamplesBody,
  ModelLabConfig,
  ModelLabScope,
  Scopes,
  UpsertDeploymentBody,
} from '@neuroflow/contracts';
import { modelLabRepo, patchesRepo, runsRepo, sandboxRepo, codeRunsRepo } from '@neuroflow/db';
import { requireScope } from '../auth';
import { type AppDeps, modelScope } from '../deps';
import { HttpError, notFound } from '../errors';

const IdParams = z.object({ id: z.string().uuid() });
const NameParams = z.object({ name: z.string().min(1).max(50) });
const ExampleParams = z.object({ id: z.string().uuid(), exampleId: z.string().uuid() });
const MAX_EVAL_EXAMPLES = 50;

/** Model Lab: Models · Providers · Parameters · Datasets · Fine-tuning · Evaluations · Deployments. */
export async function modelLabRoutes(app: FastifyInstance, deps: AppDeps) {
  // The workspace's own view: models of providers it has keys for are known too (BYOK).
  const workspaceModels = async (workspaceId: string) => deps.gateway.listModels(await modelScope(deps, workspaceId));
  const knownModel = async (workspaceId: string, ref: string) => (await workspaceModels(workspaceId)).some((m) => m.ref === ref);

  // ---- Models & Providers (read-only views of the Gateway) ----
  app.get('/v1/model-lab/providers', async (req) => {
    requireScope(req, Scopes.runsRead);
    return { providers: deps.gateway.listProviders() };
  });

  app.get('/v1/model-lab/models', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const [deployments, scope] = await Promise.all([modelLabRepo.listDeployments(deps.pool, p.workspaceId), modelScope(deps, p.workspaceId)]);
    return { models: deps.gateway.listModels(scope), default: deps.gateway.defaultModel(scope) ?? null, deployments };
  });

  // ---- Parameters (per-surface defaults applied by the runtime) ----
  app.get('/v1/model-lab/configs/:scope', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const { scope } = z.object({ scope: ModelLabScope }).parse(req.params);
    const config = (await modelLabRepo.getConfig(deps.pool, p.workspaceId, scope)) ?? ModelLabConfig.parse({});
    return { scope, config, canEdit: p.scopes.includes(Scopes.admin) };
  });

  app.put('/v1/model-lab/configs/:scope', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const { scope } = z.object({ scope: ModelLabScope }).parse(req.params);
    const config = ModelLabConfig.parse(req.body);
    if (config.model !== 'auto' && !config.model.startsWith('deployment/') && !(await knownModel(p.workspaceId, config.model))) {
      throw new HttpError('bad_request', `Unknown model "${config.model}"`);
    }
    if (config.tools) {
      const unknown = config.tools.filter((t) => !deps.tools.names().includes(t));
      if (unknown.length) throw new HttpError('bad_request', `Unknown tools: ${unknown.join(', ')}`);
    }
    await modelLabRepo.setConfig(deps.pool, p.workspaceId, scope, config, p.userId);
    return { scope, config, canEdit: true };
  });

  // ---- Deployments (named model configurations: model = "deployment/<name>") ----
  app.get('/v1/model-lab/deployments', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    return { deployments: await modelLabRepo.listDeployments(deps.pool, p.workspaceId) };
  });

  app.post('/v1/model-lab/deployments', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const body = UpsertDeploymentBody.parse(req.body);
    const info = (await workspaceModels(p.workspaceId)).find((m) => m.ref === body.model);
    if (!info) throw new HttpError('bad_request', `Unknown model "${body.model}"`);
    if (body.parameters.reasoningBudget && !info.supportedParameters?.includes('reasoningBudget')) {
      throw new HttpError('bad_request', `${body.model} does not support a reasoning budget`);
    }
    return reply.code(201).send({ deployment: await modelLabRepo.upsertDeployment(deps.pool, p.workspaceId, body, p.userId) });
  });

  app.delete('/v1/model-lab/deployments/:name', async (req, reply) => {
    const p = requireScope(req, Scopes.admin);
    const { name } = NameParams.parse(req.params);
    if (!(await modelLabRepo.deleteDeployment(deps.pool, p.workspaceId, name))) throw notFound('Deployment');
    return reply.code(204).send();
  });

  // ---- Datasets (examples are only added by explicit user action) ----
  app.get('/v1/model-lab/datasets', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    return { datasets: await modelLabRepo.listDatasets(deps.pool, p.workspaceId) };
  });

  app.post('/v1/model-lab/datasets', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const body = CreateDatasetBody.parse(req.body);
    const id = await modelLabRepo.createDataset(deps.pool, p.workspaceId, body, p.userId);
    return reply.code(201).send({ id });
  });

  const datasetOf = async (workspaceId: string, id: string) => {
    if (!(await modelLabRepo.datasetExists(deps.pool, workspaceId, id))) throw notFound('Dataset');
  };

  app.get('/v1/model-lab/datasets/:id', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const { id } = IdParams.parse(req.params);
    await datasetOf(p.workspaceId, id);
    const dataset = (await modelLabRepo.listDatasets(deps.pool, p.workspaceId)).find((d) => d.id === id)!;
    return { dataset, examples: await modelLabRepo.listExamples(deps.pool, id) };
  });

  app.delete('/v1/model-lab/datasets/:id', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    if (!(await modelLabRepo.deleteDataset(deps.pool, p.workspaceId, id))) throw notFound('Dataset');
    return reply.code(204).send();
  });

  app.post('/v1/model-lab/datasets/:id/examples', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    await datasetOf(p.workspaceId, id);
    const body = AddExampleBody.parse(req.body);
    return reply.code(201).send({ example: await modelLabRepo.addExample(deps.pool, id, { ...body, source: 'manual', addedBy: p.userId }) });
  });

  /** JSONL lines: {"task","expected"?,"context"?,"output"?} or chat {"messages":[…]} (last assistant = expected). */
  app.post('/v1/model-lab/datasets/:id/import', async (req) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    await datasetOf(p.workspaceId, id);
    const { jsonl } = ImportExamplesBody.parse(req.body);
    let imported = 0;
    const errors: string[] = [];
    for (const [i, line] of jsonl.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { task?: string; expected?: string; context?: string; output?: string; messages?: Array<{ role: string; content: string }> };
        let task = row.task;
        let expected = row.expected;
        if (!task && Array.isArray(row.messages)) {
          task = row.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
          expected = row.messages.filter((m) => m.role === 'assistant').at(-1)?.content;
        }
        if (!task) throw new Error('missing task');
        await modelLabRepo.addExample(deps.pool, id, { source: 'import', task: task.slice(0, 20_000), expected: expected?.slice(0, 20_000), context: row.context?.slice(0, 40_000), output: row.output?.slice(0, 40_000) ?? '', addedBy: p.userId });
        imported++;
        if (imported >= 2000) break;
      } catch (err) {
        if (errors.length < 10) errors.push(`line ${i + 1}: ${(err as Error).message}`);
      }
    }
    return { imported, errors };
  });

  /** Explicit user action: candidate example from a recorded run (task, context, output, outcome). */
  app.post('/v1/model-lab/datasets/:id/examples/from-run', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id } = IdParams.parse(req.params);
    await datasetOf(p.workspaceId, id);
    const body = ExampleFromRunBody.parse(req.body);
    const run = await runsRepo.get(deps.pool, body.runId, p.workspaceId);
    if (!run) throw notFound('Run');
    const { rows } = await deps.pool.query(`SELECT content FROM messages WHERE run_id = $1 AND role = 'user' ORDER BY position LIMIT 1`, [run.id]);
    const task = (rows[0]?.content as string | undefined) ?? '';
    const codeRun = await codeRunsRepo.get(deps.pool, run.id);
    let context: string | undefined;
    let output = run.output ?? '';
    let source: 'agent_interaction' | 'accepted_patch' | 'rejected_patch' | 'test_failure' | 'successful_fix' = 'agent_interaction';
    if (codeRun) {
      const patches = await patchesRepo.listForRun(deps.pool, run.id);
      const tests = await sandboxRepo.list(deps.pool, codeRun.codeWorkspaceId, { runId: run.id });
      const applied = patches.filter((x) => x.status === 'applied');
      context = run.request.workspaceContext?.activeFile ? `Active file: ${run.request.workspaceContext.activeFile}` : undefined;
      if (applied.length) output = `${output}\n\n${applied.map((x) => x.diff).join('\n')}`.slice(0, 40_000);
      const lastTest = tests.find((t) => t.kind === 'test');
      source =
        body.outcome === 'rejected'
          ? 'rejected_patch'
          : lastTest?.status === 'failed'
            ? 'test_failure'
            : lastTest?.status === 'passed' && applied.length
              ? 'successful_fix'
              : applied.length
                ? 'accepted_patch'
                : 'agent_interaction';
    }
    const example = await modelLabRepo.addExample(deps.pool, id, {
      source,
      sourceRunId: run.id,
      task: task.slice(0, 20_000),
      ...(context ? { context } : {}),
      output: output.slice(0, 40_000),
      ...(body.expected ? { expected: body.expected } : {}),
      outcome: body.outcome,
      addedBy: p.userId,
    });
    return reply.code(201).send({ example });
  });

  app.patch('/v1/model-lab/datasets/:id/examples/:exampleId', async (req) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id, exampleId } = ExampleParams.parse(req.params);
    await datasetOf(p.workspaceId, id);
    const { reviewed } = z.object({ reviewed: z.boolean() }).parse(req.body);
    if (!(await modelLabRepo.setReviewed(deps.pool, id, exampleId, reviewed))) throw notFound('Example');
    return { ok: true };
  });

  app.delete('/v1/model-lab/datasets/:id/examples/:exampleId', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const { id, exampleId } = ExampleParams.parse(req.params);
    await datasetOf(p.workspaceId, id);
    if (!(await modelLabRepo.deleteExample(deps.pool, id, exampleId))) throw notFound('Example');
    return reply.code(204).send();
  });

  /** Chat-format JSONL export of reviewed examples (the user decides what leaves NeuroFlow). */
  app.get('/v1/model-lab/datasets/:id/export', async (req, reply) => {
    const p = requireScope(req, Scopes.runsRead);
    const { id } = IdParams.parse(req.params);
    await datasetOf(p.workspaceId, id);
    const { all } = z.object({ all: z.coerce.boolean().default(false) }).parse(req.query);
    const examples = (await modelLabRepo.listExamples(deps.pool, id, 10_000)).filter((e) => all || e.reviewed);
    const body = examples
      .map((e) =>
        JSON.stringify({
          messages: [
            ...(e.context ? [{ role: 'system', content: e.context }] : []),
            { role: 'user', content: e.task },
            { role: 'assistant', content: e.expected ?? e.output },
          ],
        }),
      )
      .join('\n');
    return reply.header('content-type', 'application/jsonl').header('content-disposition', `attachment; filename="dataset-${id}.jsonl"`).send(body);
  });

  // ---- Fine-tuning (provider-dependent; never implied when unsupported) ----
  app.get('/v1/model-lab/fine-tuning', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const providers = deps.gateway.listProviders().map((x) => ({ provider: x.id, displayName: x.displayName, ...x.fineTuning }));
    return { providers, jobs: await modelLabRepo.listJobs(deps.pool, p.workspaceId) };
  });

  app.post('/v1/model-lab/fine-tuning/jobs', async (req) => {
    const p = requireScope(req, Scopes.admin);
    const body = CreateFineTuningJobBody.parse(req.body);
    await datasetOf(p.workspaceId, body.datasetId);
    const provider = body.baseModel.split('/')[0]!;
    const capability = deps.gateway.listProviders().find((x) => x.id === provider)?.fineTuning;
    // No configured provider currently supports fine-tuning through NeuroFlow: say so explicitly.
    throw new HttpError('conflict', `Fine-tuning is not available for ${provider}: ${capability?.reason ?? 'unknown provider'}`);
  });

  // ---- Evaluations (dataset × models through the Gateway, executed in the worker) ----
  app.get('/v1/model-lab/evaluations', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    return { evaluations: await modelLabRepo.listEvaluations(deps.pool, p.workspaceId) };
  });

  app.get('/v1/model-lab/evaluations/:id', async (req) => {
    const p = requireScope(req, Scopes.runsRead);
    const { id } = IdParams.parse(req.params);
    const evaluation = await modelLabRepo.getEvaluation(deps.pool, id, p.workspaceId);
    if (!evaluation) throw notFound('Evaluation');
    return { evaluation };
  });

  app.post('/v1/model-lab/evaluations', async (req, reply) => {
    const p = requireScope(req, Scopes.runsWrite);
    const body = CreateEvaluationBody.parse(req.body);
    await datasetOf(p.workspaceId, body.datasetId);
    const known = new Set((await workspaceModels(p.workspaceId)).map((m) => m.ref));
    const unknown = body.models.filter((m) => !known.has(m));
    if (unknown.length) throw new HttpError('bad_request', `Unknown models: ${unknown.join(', ')}`);
    const examples = await modelLabRepo.listExamples(deps.pool, body.datasetId, MAX_EVAL_EXAMPLES + 1);
    if (examples.length === 0) throw new HttpError('bad_request', 'The dataset has no examples');
    if (body.scorer !== 'judge' && !examples.some((e) => e.expected)) throw new HttpError('bad_request', 'Examples need an expected answer for this scorer');
    const id = await modelLabRepo.createEvaluation(deps.pool, p.workspaceId, body, p.userId);
    await deps.queue.enqueueWorkspaceJob({ kind: 'model.evaluate', evaluationId: id, workspaceId: p.workspaceId }, `model-eval-${id}`);
    return reply.code(202).send({ id });
  });
}
