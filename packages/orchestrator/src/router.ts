import { learnedPrimary, type LearnedRouting } from './learned-routing';
import type {
  AgentStrategy,
  CognitivePolicy,
  ExecutionPlan,
  ModelAssignment,
  ModelInfo,
  ModelRole,
  ModelStrategy,
  ReasoningBudget,
  RunMode,
  RunRequest,
  TaskClass,
} from '@neuroflow/contracts';
import { capStrategy } from '@neuroflow/cognitive';
import { RoutingError } from './errors';

export type TaskSignals = {
  taskClass: TaskClass;
  complexity: number;
  wantsVerification: boolean;
  independentParts: number;
};

const RE = {
  conversational: /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|good (morning|evening|night))\b[\s!.?]*$/i,
  memory: /\b(remember|recall|forget|what did i|did i (say|decide|mention|tell)|my (preferences?|decisions?)|last time|previously|we decided|i decided|i told you)\b/i,
  tool: /\b(calculate|compute|how much is|what time|current time|today'?s date|what day)\b|\d+\s*[-+*/^%]\s*\d+/i,
  code: /```|\b(function|class|bug|stack trace|exception|refactor|typescript|javascript|python|sql|regex|compile|api endpoint)\b/i,
  analysis: /\b(analy[sz]e|analysis|compare|comparison|evaluate|assess|pros and cons|trade-?offs?|review|investigate|diagnose|root cause)\b/i,
  creative: /\b(write|draft|compose|brainstorm)\b.*\b(story|poem|email|post|essay|tweet|letter|slogan|ideas?)\b/i,
  depth: /\b(in[- ]depth|comprehensive|thorough|detailed|step[- ]by[- ]step|end[- ]to[- ]end|full plan|strategy|roadmap|architecture)\b/i,
  verify: /\b(double[- ]check|verify|carefully|make sure|be accurate|high quality|proofread)\b/i,
};

/** Cheap, deterministic task classification used for routing (no model call). */
export function classifyTask(text: string): TaskSignals {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  const questions = (t.match(/\?/g) ?? []).length;
  const listItems = (t.match(/^\s*(\d+[.)]|[-*•])\s+/gm) ?? []).length;
  const andParts = (t.match(/\b(and|also|plus|as well as)\b/gi) ?? []).length;

  let taskClass: TaskClass = 'question';
  if (RE.conversational.test(t)) taskClass = 'conversational';
  else if (RE.memory.test(t)) taskClass = 'memory';
  else if (RE.tool.test(t)) taskClass = 'tool';
  else if (RE.code.test(t)) taskClass = 'code';
  else if (RE.analysis.test(t)) taskClass = 'analysis';
  else if (RE.creative.test(t)) taskClass = 'creative';

  let complexity = Math.min(words / 250, 0.35);
  if (RE.depth.test(t)) complexity += 0.3;
  if (taskClass === 'analysis' || taskClass === 'code') complexity += 0.15;
  complexity += Math.min((Math.max(questions - 1, 0) + listItems) * 0.1, 0.3);
  complexity = Math.min(1, Math.round(complexity * 100) / 100);
  if (complexity >= 0.75 && taskClass !== 'memory' && taskClass !== 'tool') taskClass = 'complex';

  return {
    taskClass,
    complexity,
    wantsVerification: RE.verify.test(t),
    independentParts: Math.max(questions, listItems, andParts >= 2 ? andParts : 0),
  };
}

export type RouterInput = {
  mode: RunMode;
  request: Pick<
    RunRequest,
    | 'agentStrategy'
    | 'modelStrategy'
    | 'selectedModel'
    | 'reasoningBudget'
    | 'tools'
    | 'agent'
    | 'budget'
    | 'clientTools'
    | 'workspaceContext'
  >;
  lastUserMessage: string;
  models: ModelInfo[];
  defaultModel?: string;
  availableTools: string[];
  /** Agent ids that may be requested by name (built-in + workspace agents). */
  availableAgents?: string[];
  cognitive?: CognitivePolicy;
  /** Measured model outcomes per task class (learned routing); rules apply without it. */
  learned?: LearnedRouting;
};

const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
/** Code runs (understand → edit → test → repair) get larger, still bounded, budgets. */
export const CODE_RUN_BUDGETS = { maxDurationMs: 30 * 60_000, maxModelCalls: 60, maxToolCalls: 80, perAgentToolCalls: 60 };
/** Below this latency budget the router avoids multi-agent graphs. */
const TIGHT_LATENCY_MS = 60_000;

const TOOL_CALL_BUDGET: Record<AgentStrategy, number> = {
  direct: 0,
  single_agent: 8,
  sequential: 12,
  parallel: 12,
  supervisor: 16,
  evaluator_optimizer: 8,
};

const MODEL_CALL_BUDGET: Record<AgentStrategy, number> = {
  direct: 2,
  single_agent: 8,
  sequential: 14,
  parallel: 14,
  supervisor: 18,
  evaluator_optimizer: 12,
};

const ROLES_BY_STRATEGY: Record<AgentStrategy, ModelRole[]> = {
  direct: ['primary'],
  single_agent: ['agent'],
  sequential: ['research', 'analysis', 'synthesis'],
  parallel: ['research', 'analysis', 'synthesis'],
  supervisor: ['supervisor', 'research', 'analysis', 'agent', 'synthesis'],
  evaluator_optimizer: ['agent', 'evaluator', 'refiner'],
};

const AGENTS_BY_STRATEGY: Record<AgentStrategy, string[]> = {
  direct: [],
  single_agent: ['assistant'],
  sequential: ['researcher', 'analyst', 'writer'],
  parallel: ['researcher', 'analyst', 'writer'],
  supervisor: ['supervisor', 'researcher', 'analyst', 'assistant'],
  evaluator_optimizer: ['assistant', 'critic', 'refiner'],
};

/**
 * Produces the smallest reliable execution graph for the task. Agent strategy and model strategy
 * are chosen independently; explicit user choices always win over automatic selection.
 */
export function planExecution(input: RouterInput): ExecutionPlan {
  const signals = classifyTask(input.lastUserMessage);
  const rationale: string[] = [];
  let available = input.models.filter((m) => m.available);
  if (available.length === 0) {
    throw new RoutingError('No model provider is configured or reachable. Configure Qwen or Groq and try again.');
  }
  const budget = input.request.budget;
  const code = input.request.workspaceContext;
  const durationCap = code ? CODE_RUN_BUDGETS.maxDurationMs : DEFAULT_MAX_DURATION_MS;
  const maxDurationMs = Math.min(budget?.maxDurationMs ?? durationCap, durationCap);
  const tightLatency = maxDurationMs < TIGHT_LATENCY_MS;

  // Cost budget: only models with known pricing can be held to it.
  if (budget?.maxCostUsd !== undefined && !input.request.selectedModel) {
    const priced = available.filter((m) => m.pricing);
    if (priced.length) {
      available = priced;
      rationale.push(`Cost budget $${budget.maxCostUsd}: restricted to models with known pricing`);
    } else {
      rationale.push('Cost budget set, but no model has known pricing; cost is tracked where reported');
    }
  }
  if (input.request.agent && input.availableAgents && !input.availableAgents.includes(input.request.agent)) {
    throw new RoutingError(`The agent "${input.request.agent}" does not exist in this workspace.`);
  }

  const selected = input.request.selectedModel
    ? available.find((m) => m.ref === input.request.selectedModel)
    : undefined;
  if (input.request.selectedModel && !selected) {
    throw new RoutingError(`The selected model "${input.request.selectedModel}" is not available.`);
  }
  const primary = selected ?? choosePrimary(available, input, tightLatency, rationale, signals.taskClass);

  const allowedTools = input.request.tools
    ? input.availableTools.filter((t) => input.request.tools!.includes(t))
    : input.availableTools;
  const toolsUsable = allowedTools.length > 0 && primary.capabilities.tools;

  // --- agent strategy ---
  let agentStrategy: AgentStrategy;
  const clientTools = (input.request.clientTools?.length ?? 0) > 0;
  if (code) {
    // A code run is a specialised run: one Code Agent (or a named agent) with repository tools.
    agentStrategy = 'single_agent';
    rationale.push(
      `Code run (${code.approvalMode} mode): ${input.request.agent ?? 'Code Agent'} with repository tools${code.approvalMode === 'restricted' ? ' (read-only)' : ''}`,
    );
  } else if (clientTools) {
    agentStrategy = 'direct';
    rationale.push('Client-defined tools: one model call; tool calls are returned to the client');
  } else if (input.request.agent && input.request.agentStrategy === 'auto') {
    agentStrategy = 'single_agent';
    rationale.push(`Agent "${input.request.agent}" requested: single agent`);
  } else if (input.request.agentStrategy !== 'auto') {
    agentStrategy = input.request.agentStrategy;
    rationale.push(`Strategy "${agentStrategy}" requested explicitly`);
  } else {
    agentStrategy = autoStrategy(signals, toolsUsable, rationale);
    if (tightLatency) {
      const capped = capStrategy(agentStrategy, 'single_agent');
      if (capped !== agentStrategy) {
        rationale.push(`Latency budget ${Math.round(maxDurationMs / 1000)}s: capped strategy at "${capped}"`);
        agentStrategy = capped;
      }
    }
    if (input.cognitive) {
      const capped = capStrategy(agentStrategy, input.cognitive.maxAutoStrategy);
      if (capped !== agentStrategy) {
        rationale.push(`Cognitive policy (${input.cognitive.workload} workload) capped strategy at "${capped}"`);
        agentStrategy = capped;
      }
    }
  }

  // --- model strategy (independent of agent strategy) ---
  const roles = ROLES_BY_STRATEGY[agentStrategy];
  let modelStrategy: ModelStrategy;
  if (input.request.modelStrategy !== 'auto') {
    modelStrategy = input.request.modelStrategy;
  } else {
    modelStrategy = roles.length > 1 && available.length > 1 && !selected ? 'multi' : 'single';
  }
  if (modelStrategy === 'multi' && available.length < 2) {
    rationale.push('Only one model available; using a single model');
    modelStrategy = 'single';
  }
  const models = assignModels(roles, modelStrategy, primary, available, Boolean(selected));
  rationale.push(
    modelStrategy === 'multi'
      ? `Multi-model: ${[...new Set(models.map((m) => m.model))].join(', ')}`
      : `Single model: ${primary.ref}`,
  );

  // --- reasoning, context, evaluation, budgets ---
  const reasoningBudget: ReasoningBudget =
    input.request.reasoningBudget ??
    (signals.complexity >= 0.6 ? 'medium' : signals.complexity >= 0.35 || signals.taskClass === 'code' ? 'low' : 'off');

  const density = input.cognitive?.contextDensity ?? 'medium';
  const recentMessages = density === 'low' ? 8 : density === 'high' ? 40 : 20;
  const maxInputTokens = Math.max(2_000, Math.min(Math.floor(primary.contextWindow * (code ? 0.75 : 0.6)), code ? 48_000 : 24_000));

  const wantsModelEval =
    agentStrategy === 'evaluator_optimizer' ||
    input.cognitive?.evaluation === 'model' ||
    (signals.wantsVerification && agentStrategy !== 'direct');
  const evaluationPolicy = {
    kind: wantsModelEval ? ('model' as const) : ('heuristic' as const),
    maxIterations: agentStrategy === 'evaluator_optimizer' ? 2 : 0,
  };

  const agents =
    agentStrategy === 'single_agent' && input.request.agent
      ? [input.request.agent]
      : code
        ? ['code']
        : AGENTS_BY_STRATEGY[agentStrategy];
  return {
    mode: input.mode,
    taskClass: signals.taskClass,
    complexity: signals.complexity,
    agentStrategy,
    modelStrategy,
    models,
    agents,
    toolPolicy: {
      allowed: agentStrategy === 'direct' ? [] : allowedTools,
      maxToolCalls: agentStrategy === 'direct' ? 0 : code ? CODE_RUN_BUDGETS.perAgentToolCalls : agentStrategy === 'single_agent' ? 6 : 4,
    },
    contextPolicy: { maxInputTokens, recentMessages, density },
    reasoningBudget,
    evaluationPolicy,
    budgets: {
      maxModelCalls: code ? CODE_RUN_BUDGETS.maxModelCalls : MODEL_CALL_BUDGET[agentStrategy],
      maxToolCalls: code ? CODE_RUN_BUDGETS.maxToolCalls : TOOL_CALL_BUDGET[agentStrategy],
      maxDurationMs,
      ...(budget?.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
    },
    ...(input.cognitive ? { cognitive: input.cognitive } : {}),
    rationale,
  };
}

const TIER_ORDER = { fast: 0, balanced: 1, strong: 2 } as const;

/**
 * Primary model when the user did not pick one: tight latency budgets and a "fast" cognitive
 * preference favour the fastest tier, "quality" favours the strongest, a cost budget favours the
 * cheapest priced model; otherwise the configured default.
 */
function choosePrimary(available: ModelInfo[], input: RouterInput, tightLatency: boolean, rationale: string[], taskClass: TaskSignals['taskClass']): ModelInfo {
  const byTier = (dir: 1 | -1) => [...available].sort((a, b) => dir * (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]))[0]!;
  const preference = input.cognitive?.modelPreference;
  if (tightLatency || preference === 'fast') {
    const m = byTier(1);
    rationale.push(`${tightLatency ? 'Tight latency budget' : 'Cognitive policy'}: fastest model ${m.ref}`);
    return m;
  }
  if (input.request.budget?.maxCostUsd !== undefined && available.every((m) => m.pricing)) {
    const m = [...available].sort((a, b) => a.pricing!.outputPerMTok - b.pricing!.outputPerMTok)[0]!;
    rationale.push(`Cost budget: cheapest model ${m.ref}`);
    return m;
  }
  if (preference === 'quality') {
    const m = byTier(-1);
    rationale.push(`Cognitive policy: strongest model ${m.ref}`);
    return m;
  }
  const fallback = available.find((m) => m.ref === input.defaultModel) ?? available[0]!;
  // Explicit constraints above win; otherwise measured outcomes choose among available models.
  return (input.learned ? learnedPrimary(available, taskClass, fallback, input.learned, rationale) : undefined) ?? fallback;
}

function autoStrategy(s: TaskSignals, toolsUsable: boolean, rationale: string[]): AgentStrategy {
  if (s.taskClass === 'conversational') {
    rationale.push('Conversational message: direct model response');
    return 'direct';
  }
  if (s.independentParts >= 3 && s.complexity >= 0.55 && s.taskClass !== 'memory' && s.taskClass !== 'tool') {
    rationale.push(`Complex task with ${s.independentParts} parts: supervisor delegation`);
    return 'supervisor';
  }
  if (s.taskClass === 'complex' || ((s.taskClass === 'analysis' || s.taskClass === 'code') && s.complexity >= 0.6)) {
    if (s.independentParts >= 2) {
      rationale.push('Independent sub-questions: parallel research and analysis');
      return 'parallel';
    }
    rationale.push('Deep analysis: sequential research → analysis → synthesis');
    return 'sequential';
  }
  if (s.wantsVerification) {
    rationale.push('Accuracy requested: generate, evaluate, refine');
    return 'evaluator_optimizer';
  }
  if (toolsUsable && s.taskClass !== 'creative') {
    rationale.push('Single agent with tools available (the model decides whether to use them)');
    return 'single_agent';
  }
  rationale.push('Simple task: direct model response');
  return 'direct';
}

const TIER_RANK = { fast: 0, balanced: 1, strong: 2 } as const;

/**
 * Assigns a model to every role. With `single`, every role uses the primary model. With `multi`,
 * roles are spread across available models by capability tier — never by hardcoded provider.
 */
export function assignModels(
  roles: ModelRole[],
  strategy: ModelStrategy,
  primary: ModelInfo,
  available: ModelInfo[],
  pinPrimary = false,
): ModelAssignment[] {
  // Fallbacks keep capability first (no silent downgrade to a much weaker model), then prefer
  // another provider so one outage or quota does not take out the whole chain.
  const fallbacksFor = (ref: string) => {
    const self = available.find((m) => m.ref === ref);
    const rank = self ? TIER_RANK[self.tier] : TIER_RANK.balanced;
    const key = (m: ModelInfo) => [Math.max(0, rank - TIER_RANK[m.tier]), Math.abs(rank - TIER_RANK[m.tier]), Number(m.provider === parseProvider(ref))];
    return available
      .filter((m) => m.ref !== ref)
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka[0]! - kb[0]! || ka[1]! - kb[1]! || ka[2]! - kb[2]!;
      })
      .map((m) => m.ref)
      .slice(0, 2);
  };

  if (strategy === 'single') {
    return roles.map((role) => ({ role, model: primary.ref, fallbacks: fallbacksFor(primary.ref) }));
  }

  const byStrength = [...available].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  // An explicitly selected model keeps the user-facing (synthesis) roles.
  const strongest = pinPrimary ? primary : byStrength[0]!;
  const fastest = byStrength[byStrength.length - 1]!;
  const others = byStrength.filter((m) => m.ref !== strongest.ref);
  let rr = 0;
  return roles.map((role) => {
    let pick: ModelInfo;
    if (role === 'synthesis' || role === 'supervisor' || role === 'refiner') pick = strongest;
    else if (role === 'evaluator') pick = fastest.ref === strongest.ref ? others[0] ?? strongest : fastest;
    else pick = others.length ? others[rr++ % others.length]! : strongest;
    return { role, model: pick.ref, fallbacks: fallbacksFor(pick.ref) };
  });
}

function parseProvider(ref: string) {
  return ref.slice(0, ref.indexOf('/'));
}
