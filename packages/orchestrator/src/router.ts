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
  request: Pick<RunRequest, 'agentStrategy' | 'modelStrategy' | 'selectedModel' | 'reasoningBudget' | 'tools'>;
  lastUserMessage: string;
  models: ModelInfo[];
  defaultModel?: string;
  availableTools: string[];
  cognitive?: CognitivePolicy;
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
  const available = input.models.filter((m) => m.available);
  if (available.length === 0) {
    throw new RoutingError('No model provider is configured or reachable. Configure Qwen or Groq and try again.');
  }

  const selected = input.request.selectedModel
    ? available.find((m) => m.ref === input.request.selectedModel)
    : undefined;
  if (input.request.selectedModel && !selected) {
    throw new RoutingError(`The selected model "${input.request.selectedModel}" is not available.`);
  }
  const primary =
    selected ?? available.find((m) => m.ref === input.defaultModel) ?? available[0]!;

  const allowedTools = input.request.tools
    ? input.availableTools.filter((t) => input.request.tools!.includes(t))
    : input.availableTools;
  const toolsUsable = allowedTools.length > 0 && primary.capabilities.tools;

  // --- agent strategy ---
  let agentStrategy: AgentStrategy;
  if (input.request.agentStrategy !== 'auto') {
    agentStrategy = input.request.agentStrategy;
    rationale.push(`Strategy "${agentStrategy}" requested explicitly`);
  } else {
    agentStrategy = autoStrategy(signals, toolsUsable, rationale);
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
  const maxInputTokens = Math.max(2_000, Math.min(Math.floor(primary.contextWindow * 0.6), 24_000));

  const wantsModelEval =
    agentStrategy === 'evaluator_optimizer' ||
    input.cognitive?.evaluation === 'model' ||
    (signals.wantsVerification && agentStrategy !== 'direct');
  const evaluationPolicy = {
    kind: wantsModelEval ? ('model' as const) : ('heuristic' as const),
    maxIterations: agentStrategy === 'evaluator_optimizer' ? 2 : 0,
  };

  return {
    mode: input.mode,
    taskClass: signals.taskClass,
    complexity: signals.complexity,
    agentStrategy,
    modelStrategy,
    models,
    agents: AGENTS_BY_STRATEGY[agentStrategy],
    toolPolicy: {
      allowed: agentStrategy === 'direct' ? [] : allowedTools,
      maxToolCalls: agentStrategy === 'direct' ? 0 : agentStrategy === 'single_agent' ? 6 : 4,
    },
    contextPolicy: { maxInputTokens, recentMessages, density },
    reasoningBudget,
    evaluationPolicy,
    budgets: { maxModelCalls: MODEL_CALL_BUDGET[agentStrategy], maxDurationMs: 10 * 60_000 },
    ...(input.cognitive ? { cognitive: input.cognitive } : {}),
    rationale,
  };
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
  const fallbacksFor = (ref: string) =>
    available
      .filter((m) => m.ref !== ref)
      .sort((a, b) => Number(b.provider !== parseProvider(ref)) - Number(a.provider !== parseProvider(ref)))
      .map((m) => m.ref)
      .slice(0, 2);

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
