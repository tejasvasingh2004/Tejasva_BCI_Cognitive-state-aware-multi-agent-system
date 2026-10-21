import { z } from 'zod';
import type { AgentStrategy, ChatMessage } from '@neuroflow/contracts';
import { callModel, modelFor, outputInstructions, runAgent, throwIfCancelled, wantsJson, type RunContext } from './execution';
import { buildContext } from './context';
import { evaluate, parseJsonObject, recordEvaluation } from './evaluation';

export type StrategyResult = {
  /** True when the strategy already evaluated its output (evaluator/optimizer). */
  evaluated?: boolean;
};

type Strategy = (ctx: RunContext, task: string) => Promise<StrategyResult>;

const note = (from: string, content: string): ChatMessage => ({
  role: 'user',
  content: `[Notes from ${from}]\n${content.trim() || '(no output)'}`,
});

/**
 * DIRECT: one model call, no server tools. When an API client supplied its own tools, they are
 * offered to the model and any calls are returned to the client (never executed here).
 */
const direct: Strategy = async (ctx) => {
  ctx.stage = 'model';
  const outputReq = outputInstructions(ctx);
  const { messages, report } = buildContext({
    plan: ctx.plan,
    model: modelFor(ctx, 'primary').model,
    history: ctx.history,
    ...ctx.extras,
    ...(outputReq ? { outputInstructions: outputReq } : {}),
  });
  ctx.emit('context.built', report);
  const clientTools = ctx.request.clientTools ?? [];
  const choice = ctx.request.clientToolChoice;
  const res = await callModel(ctx, {
    role: 'primary',
    messages,
    streamToUser: true,
    ...(wantsJson(ctx.request.responseFormat) ? { responseFormat: 'json' as const } : {}),
    ...(clientTools.length && choice !== 'none'
      ? {
          tools: clientTools
            .filter((t) => typeof choice !== 'object' || t.name === choice.name)
            .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
          toolChoice: choice === 'required' || typeof choice === 'object' ? ('required' as const) : ('auto' as const),
        }
      : {}),
  });
  if (res.toolCalls.length) ctx.clientToolCalls = res.toolCalls;
  return {};
};

/** SINGLE_AGENT: one agent owns the task and may call tools (a named agent when requested). */
const singleAgent: Strategy = async (ctx, task) => {
  if (ctx.request.workspaceContext) return codeAgent(ctx, task);
  const id = ctx.plan.agents[0] && ctx.agents.has(ctx.plan.agents[0]) ? ctx.plan.agents[0] : 'assistant';
  await runAgent(ctx, { agent: ctx.agents.get(id), streamToUser: true });
  return {};
};

/** Maximum automatic test → fix iterations after the agent's own work (bounded repair loop). */
export const MAX_REPAIR_ITERATIONS = 2;

const CodePlan = z.object({ summary: z.string().max(500).optional(), steps: z.array(z.string().min(3).max(300)).min(1).max(8) });

const PLAN_PROMPT = `You plan a coding task for an engineer who will use repository tools (search, read, edit, run tests).
Write 2-7 concrete steps (which files/symbols to inspect, what to change, how to validate). Do not write code.
Respond with only JSON: {"summary":"one sentence","steps":["..."]}`;

/** Plan revisions the user can request before the run stops. */
export const MAX_PLAN_REVISIONS = 3;
const PlanEdit = z.object({ steps: z.array(z.string().trim().min(3).max(300)).min(1).max(12).optional(), summary: z.string().max(500).optional(), decision: z.string().optional() });

/** Asks the model for a plan (optionally revising a previous one with the user's feedback). */
async function proposePlan(ctx: RunContext, task: string, revise?: { previous: string[]; feedback: string }): Promise<z.infer<typeof CodePlan> | null> {
  const code = ctx.extras.code;
  const res = await callModel(ctx, {
    role: 'agent',
    streamToUser: false,
    responseFormat: 'json',
    maxOutputTokens: 600,
    messages: [
      { role: 'system', content: [PLAN_PROMPT, code?.repository, code?.instructions && `Repository instructions:
${code.instructions.slice(0, 3000)}`, code?.editor && `Editor context:
${code.editor.slice(0, 4000)}`].filter(Boolean).join('\n\n') },
      { role: 'user', content: task.slice(0, 8000) },
      ...(revise
        ? [
            { role: 'assistant' as const, content: JSON.stringify({ steps: revise.previous }) },
            { role: 'user' as const, content: `The user asked for changes to this plan:
${revise.feedback.slice(0, 2000)}
Write the revised plan as JSON in the same format.` },
          ]
        : []),
    ],
  });
  const parsed = CodePlan.safeParse(parseJsonObject(res.text));
  return parsed.success ? parsed.data : null;
}

/**
 * Plan Review: the plan waits for the user, who can approve it (optionally edited), ask for a
 * revised plan with feedback, or stop the run. Returns the approved plan, or null when stopped.
 */
async function reviewPlan(ctx: RunContext, task: string, first: z.infer<typeof CodePlan>): Promise<z.infer<typeof CodePlan> | null> {
  const gate = ctx.deps.approvals!;
  const timeoutMs = ctx.deps.planReviewTimeoutMs ?? 15 * 60_000;
  let plan = first;
  for (let revision = 1; ; revision++) {
    const planId = `plan-${revision}`;
    ctx.stage = 'plan_review';
    ctx.emit('plan.review_required', {
      planId,
      steps: plan.steps,
      ...(plan.summary ? { summary: plan.summary } : {}),
      revision,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
    const decision = await gate.wait(ctx.run.id, planId, timeoutMs, ctx.signal).catch((err: unknown) => {
      throwIfCancelled(ctx.signal);
      throw err;
    });
    throwIfCancelled(ctx.signal);
    if (decision === 'timeout') {
      ctx.emit('plan.rejected', { planId, feedback: 'No decision before the review expired', willRevise: false });
      ctx.response.write('The plan was not reviewed in time, so nothing was changed. Ask again when you are ready.');
      return null;
    }
    const edit = PlanEdit.safeParse(decision.data ?? {});
    if (decision.approved) {
      const steps = edit.success && edit.data.steps ? edit.data.steps : plan.steps;
      const edited = JSON.stringify(steps) !== JSON.stringify(plan.steps);
      plan = { steps, ...(edit.success && edit.data.summary ? { summary: edit.data.summary } : plan.summary ? { summary: plan.summary } : {}) };
      ctx.emit('plan.approved', { planId, steps, edited });
      return plan;
    }
    const feedback = decision.reason?.trim();
    const wantsRevision = edit.success && edit.data.decision === 'revise' && Boolean(feedback) && revision < MAX_PLAN_REVISIONS;
    ctx.emit('plan.rejected', { planId, ...(feedback ? { feedback } : {}), willRevise: wantsRevision });
    if (!wantsRevision) {
      ctx.response.write(feedback ? `Stopped before making any changes. Your note: “${feedback}”` : 'Stopped before making any changes.');
      return null;
    }
    ctx.stage = 'planning';
    const next = await proposePlan(ctx, task, { previous: plan.steps, feedback: feedback! });
    if (!next) {
      ctx.response.write('I could not produce a revised plan, so nothing was changed.');
      return null;
    }
    plan = next;
    ctx.emit('agent.plan.created', { steps: plan.steps, ...(plan.summary ? { summary: plan.summary } : {}) });
  }
}

/**
 * Code runs: repository understanding (context) → plan (optionally reviewed and edited by the
 * user) → Code Agent with tools (search, read, patch, validate) → bounded validation/repair loop.
 */
async function codeAgent(ctx: RunContext, task: string): Promise<StrategyResult> {
  const wc = ctx.request.workspaceContext!;
  const id = ctx.plan.agents[0] && ctx.agents.has(ctx.plan.agents[0]) ? ctx.plan.agents[0] : 'code';
  const agent = ctx.agents.get(id);
  const notes: ChatMessage[] = [];

  const informational = wc.action === 'explain' || wc.action === 'search' || ctx.plan.taskClass === 'conversational';
  if (!informational && wc.approvalMode !== 'restricted') {
    ctx.stage = 'planning';
    let plan = await proposePlan(ctx, task);
    if (plan) {
      ctx.emit('agent.plan.created', { steps: plan.steps, ...(plan.summary ? { summary: plan.summary } : {}) });
      if (wc.planReview && ctx.deps.approvals) {
        plan = await reviewPlan(ctx, task, plan);
        // Stopped at plan review: no repository work happens.
        if (!plan) return { evaluated: true };
      }
      notes.push({ role: 'user', content: `[${wc.planReview ? 'Plan approved by the user — follow it' : 'Plan'}]
${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` });
    }
  }

  const first = await runAgent(ctx, { agent, notes, streamToUser: true });

  // Validation and bounded repair: only after real file modifications, never in Suggest/Restricted.
  const state = ctx.code;
  const canExecute = wc.approvalMode === 'review' || wc.approvalMode === 'auto';
  let previous = first.text;
  while (state && canExecute && state.modifiedSinceTest > 0 && ctx.plan.toolPolicy.allowed.includes('run_tests')) {
    throwIfCancelled(ctx.signal);
    ctx.stage = 'validation';
    const result = await ctx.deps.tools.execute(
      { id: `auto_validate_${state.repairIterations + 1}`, name: 'run_tests', arguments: '{}' },
      {
        runId: ctx.run.id,
        workspaceId: ctx.run.workspaceId,
        userId: ctx.run.userId,
        scopes: ctx.scopes,
        signal: ctx.signal,
        emit: ctx.emit,
        allowedTools: ctx.plan.toolPolicy.allowed,
        workspaceContext: wc,
      },
    );
    throwIfCancelled(ctx.signal);
    // No test command, sandbox unavailable or approval declined: stop validating, do not loop.
    if (result.status !== 'success') break;
    const data = result.data as { passed?: boolean; output?: string };
    if (data.passed || state.repairIterations >= MAX_REPAIR_ITERATIONS) break;
    state.repairIterations++;
    ctx.response.write('\n\n');
    const repair = await runAgent(ctx, {
      agent,
      notes: [
        ...notes,
        { role: 'user', content: `[Your previous summary]
${previous.slice(0, 4000)}` },
        {
          role: 'user',
          content: `[Validation failed — repair attempt ${state.repairIterations} of ${MAX_REPAIR_ITERATIONS}]
The tests fail after your changes. Output:
${(data.output ?? '').slice(0, 8000)}
Find the cause, fix it with targeted edits, run the tests again, then summarize what you changed.`,
        },
      ],
      streamToUser: true,
    });
    previous = repair.text;
  }
  return {};
}

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

const SupervisorReview = z.union([
  z.object({ done: z.literal(true) }),
  z.object({ subtasks: SupervisorPlan.shape.subtasks.max(2) }),
]);

const MAX_SUPERVISOR_ROUNDS = 2;

/**
 * SUPERVISOR: decompose → delegate (bounded concurrency) → review → optional follow-up round
 * (decide next action / request refinement) → synthesise. At most two delegation rounds.
 */
const supervisor: Strategy = async (ctx, task) => {
  const specialists = ctx.agents.specialists();
  const roster = ctx.agents.roster();
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
  const delegate = async (round: Array<{ agent: string; task: string }>) => {
    const concurrency = 2;
    for (let i = 0; i < round.length; i += concurrency) {
      const batch = round.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map((s) => runAgent(ctx, { agent: ctx.agents.get(s.agent), task: s.task, streamToUser: false })),
      );
      throwIfCancelled(ctx.signal);
      settled.forEach((r, j) => {
        if (r.status === 'fulfilled') outputs.push(note(`${batch[j]!.agent} (${batch[j]!.task.slice(0, 80)})`, r.value.text));
      });
    }
  };
  await delegate(subtasks);
  if (outputs.length === 0) throw new Error('All delegated subtasks failed');

  // Review: the supervisor decides whether the results suffice or one follow-up round is needed.
  // Skipped when the remaining model-call budget could not cover another round plus synthesis.
  for (let round = 2; round <= MAX_SUPERVISOR_ROUNDS; round++) {
    if (ctx.plan.budgets.maxModelCalls - ctx.budget.used < 6) break;
    const review = await callModel(ctx, {
      role: 'supervisor',
      streamToUser: false,
      responseFormat: 'json',
      maxOutputTokens: 600,
      messages: [
        {
          role: 'system',
          content: `${supervisorAgent.instructions}\nAvailable specialists:\n${roster}\nReview the specialists' results. If they are sufficient to fully answer the task respond with only {"done":true}. Otherwise request at most two follow-up subtasks (e.g. to fill a gap or refine a weak result) as only JSON: {"subtasks":[{"agent":"<id>","task":"<self-contained instruction>"}]}`,
        },
        { role: 'user', content: `TASK:\n${task}\n\nRESULTS:\n${outputs.map((o) => o.content).join('\n\n').slice(0, 12000)}` },
      ],
    });
    const decision = SupervisorReview.safeParse(parseJsonObject(review.text));
    if (!decision.success || 'done' in decision.data) break;
    const followUps = decision.data.subtasks.filter((s) => specialists.some((a) => a.id === s.agent));
    if (followUps.length === 0) break;
    await delegate(followUps);
  }

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
    const verdict = await evaluate(ctx, task, current, 'model', iteration);
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
