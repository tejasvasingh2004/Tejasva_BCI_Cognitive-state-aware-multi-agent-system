import { z } from 'zod';
import type { AgentStrategy, ChatMessage } from '@neuroflow/contracts';
import { callModel, runAgent, throwIfCancelled, type RunContext } from './execution';
import { buildContext } from './context';
import { heuristicEvaluation, modelEvaluation, parseJsonObject, recordEvaluation } from './evaluation';

export type StrategyResult = {
  /** True when the strategy already evaluated its output (evaluator/optimizer). */
  evaluated?: boolean;
};

type Strategy = (ctx: RunContext, task: string) => Promise<StrategyResult>;

const note = (from: string, content: string): ChatMessage => ({
  role: 'user',
  content: `[Notes from ${from}]\n${content.trim() || '(no output)'}`,
});

/** DIRECT: one model call, no tools. */
const direct: Strategy = async (ctx) => {
  ctx.stage = 'model';
  const { messages, report } = buildContext({ plan: ctx.plan, history: ctx.history });
  ctx.emit('context.built', report);
  await callModel(ctx, { role: 'primary', messages, streamToUser: true });
  return {};
};

/** SINGLE_AGENT: one agent owns the task and may call tools. */
const singleAgent: Strategy = async (ctx) => {
  await runAgent(ctx, { agent: ctx.agents.get('assistant'), streamToUser: true });
  return {};
};

/** SEQUENTIAL: research → analysis → synthesis; each stage receives earlier outputs. */
const sequential: Strategy = async (ctx) => {
  const research = await runAgent(ctx, { agent: ctx.agents.get('researcher'), streamToUser: false });
  const analysis = await runAgent(ctx, {
    agent: ctx.agents.get('analyst'),
    notes: [note('research', research.text)],
    streamToUser: false,
  });
  await runAgent(ctx, {
    agent: ctx.agents.get('writer'),
    notes: [note('research', research.text), note('analysis', analysis.text)],
    streamToUser: true,
  });
  return {};
};

/** PARALLEL: independent research and analysis run concurrently, then synthesis. */
const parallel: Strategy = async (ctx) => {
  const workers = ['researcher', 'analyst'] as const;
  const results = await Promise.allSettled(
    workers.map((id) => runAgent(ctx, { agent: ctx.agents.get(id), streamToUser: false })),
  );
  throwIfCancelled(ctx.signal);
  const notes = results.flatMap((r, i) => (r.status === 'fulfilled' ? [note(workers[i]!, r.value.text)] : []));
  if (notes.length === 0) throw (results[0] as PromiseRejectedResult).reason;
  await runAgent(ctx, { agent: ctx.agents.get('writer'), notes, streamToUser: true });
  return {};
};

const SupervisorPlan = z.object({
  subtasks: z
    .array(z.object({ agent: z.string(), task: z.string().min(3).max(2000) }))
    .min(1)
    .max(4),
});

/** SUPERVISOR: decompose → delegate (bounded concurrency) → synthesise. One delegation round. */
const supervisor: Strategy = async (ctx, task) => {
  const specialists = ctx.agents.specialists();
  const roster = specialists.map((a) => `- ${a.id}: ${a.description}`).join('\n');
  ctx.stage = 'agent:supervisor';
  const supervisorAgent = ctx.agents.get('supervisor');
  const planRes = await callModel(ctx, {
    role: 'supervisor',
    streamToUser: false,
    responseFormat: 'json',
    maxOutputTokens: 800,
    messages: [
      {
        role: 'system',
        content: `${supervisorAgent.instructions}\nAvailable specialists:\n${roster}\nRespond with only JSON: {"subtasks":[{"agent":"<id>","task":"<self-contained instruction>"}]}`,
      },
      { role: 'user', content: task },
    ],
  });
  const parsed = SupervisorPlan.safeParse(parseJsonObject(planRes.text));
  const subtasks = (parsed.success ? parsed.data.subtasks : [])
    .filter((s) => ctx.agents.has(s.agent) && specialists.some((a) => a.id === s.agent))
    .slice(0, 4);
  if (subtasks.length === 0) {
    subtasks.push({ agent: 'researcher', task }, { agent: 'analyst', task });
  }

  const outputs: ChatMessage[] = [];
  const concurrency = 2;
  for (let i = 0; i < subtasks.length; i += concurrency) {
    const batch = subtasks.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((s) => runAgent(ctx, { agent: ctx.agents.get(s.agent), task: s.task, streamToUser: false })),
    );
    throwIfCancelled(ctx.signal);
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled') outputs.push(note(`${batch[j]!.agent} (${batch[j]!.task.slice(0, 80)})`, r.value.text));
    });
  }
  if (outputs.length === 0) throw new Error('All delegated subtasks failed');

  await runAgent(ctx, { agent: ctx.agents.get('writer'), notes: outputs, streamToUser: true, role: 'synthesis' });
  return {};
};

/** EVALUATOR_OPTIMIZER: generate → evaluate → refine (bounded iterations). */
const evaluatorOptimizer: Strategy = async (ctx, task) => {
  // Workspace clients see the draft stream live and a reset before refinement. Append-only
  // clients (OpenAI protocol) receive only the final answer once evaluation is done.
  const live = !ctx.appendOnly;
  let current = (await runAgent(ctx, { agent: ctx.agents.get('assistant'), streamToUser: live })).text;
  const max = ctx.plan.evaluationPolicy.maxIterations;
  for (let iteration = 0; iteration <= max; iteration++) {
    throwIfCancelled(ctx.signal);
    ctx.stage = 'evaluation';
    ctx.emit('evaluation.started', { kind: 'model', iteration });
    const heuristic = heuristicEvaluation(ctx, current);
    const verdict = heuristic.verdict === 'failed' ? heuristic : await modelEvaluation(ctx, task, current);
    await recordEvaluation(ctx, verdict, iteration);
    if (verdict.verdict === 'passed' || iteration === max) break;

    if (live) ctx.response.reset(`Refining after evaluation: ${verdict.issues.slice(0, 2).join('; ') || verdict.verdict}`);
    current = (
      await runAgent(ctx, {
        agent: ctx.agents.get('refiner'),
        notes: [
          { role: 'user', content: `[Previous answer]\n${current}` },
          { role: 'user', content: `[Evaluator feedback]\n${verdict.issues.map((i) => `- ${i}`).join('\n') || '- Improve accuracy and completeness.'}` },
        ],
        streamToUser: live,
      })
    ).text;
  }
  if (!live) ctx.response.write(current);
  return { evaluated: true };
};

export const STRATEGIES: Record<AgentStrategy, Strategy> = {
  direct,
  single_agent: singleAgent,
  sequential,
  parallel,
  supervisor,
  evaluator_optimizer: evaluatorOptimizer,
};
