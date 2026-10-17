import type { AgentOutputContract, AgentSpec, ModelRole } from '@neuroflow/contracts';

/**
 * Agents are execution roles, not models. Which model an agent uses is decided per run by the
 * router (via `modelRole`), so agent topology and model topology stay independent.
 */
export type AgentDefinition = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Tools this agent may request (intersected with the run's tool policy). `*` = all allowed. */
  tools: string[] | '*';
  modelRole: ModelRole;
  maxIterations: number;
  /** What the agent is good at; shown to the supervisor when it delegates. */
  capabilities?: string[];
  /** Shape of the agent's output, enforced through instructions and checked by evaluation. */
  outputContract?: AgentOutputContract;
  /** True for workspace-defined agents. */
  custom?: boolean;
};

/** Converts a stored workspace agent into a runtime definition. */
export function agentFromSpec(spec: AgentSpec): AgentDefinition {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    instructions: spec.instructions,
    tools: spec.tools,
    modelRole: spec.modelRole,
    maxIterations: spec.maxIterations,
    capabilities: spec.capabilities,
    ...(spec.outputContract ? { outputContract: spec.outputContract } : {}),
    custom: true,
  };
}

/** Instruction text that enforces an output contract. */
export function outputContractInstructions(c: AgentOutputContract | undefined): string | undefined {
  if (!c) return undefined;
  const base =
    c.format === 'json'
      ? 'Respond with a single valid JSON value and nothing else (no code fences, no prose).'
      : c.format === 'text'
        ? 'Respond in plain text without Markdown formatting.'
        : 'Respond in well-structured Markdown.';
  return c.description ? `Output contract: ${base} ${c.description}` : `Output contract: ${base}`;
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'assistant',
    name: 'Assistant',
    description: 'General purpose agent that answers directly and uses tools when they help.',
    instructions:
      'Solve the user\'s task. Use a tool only when it clearly helps (for example to recall something the user told you before, do exact arithmetic, or get the current time). Never invent tool results. When you have enough information, answer the user directly.',
    tools: '*',
    modelRole: 'agent',
    maxIterations: 6,
    capabilities: ['general', 'tools', 'memory'],
  },
  {
    id: 'code',
    name: 'Code Agent',
    description: 'Understands a repository, plans and makes targeted changes, runs tests and fixes failures.',
    instructions: [
      'You are the NeuroFlow Code Agent working inside the user\'s repository through tools. You never see the whole repository: use targeted search and reads.',
      'Workflow: (1) understand — use the repository context, list_files, search_code, find_symbol, find_references and read_file to find only the relevant code and its dependencies; (2) follow the plan you were given (adjust it if you learn something new); (3) change code with small, targeted edits (edit_file with exact `find` text copied from read_file, or apply_patch) — never rewrite whole files unnecessarily, never invent file contents you have not read; (4) validate with run_tests / run_linter / run_build when the change affects behaviour; (5) if validation fails, read the failure, fix the cause and validate again; (6) finish with a concise summary of what changed, why, and the validation result.',
      'Every edit is shown to the user as a diff and may need their approval; if a change is rejected, do not retry the same change: follow the user’s feedback and continue the task; only stop to ask when there is no feedback and the next step is genuinely unclear. Respect the repository instructions. Do not commit, push or open pull requests unless the user asked for it. Only answer questions (no edits) when the user asks for an explanation or review.',
      'Never print secrets. Never claim tests passed unless a tool result shows it.',
    ].join('\n'),
    tools: '*',
    modelRole: 'agent',
    maxIterations: 24,
    capabilities: ['code', 'repository', 'tests', 'git'],
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Gathers the facts, context and prior decisions relevant to the task.',
    instructions:
      'You are the research stage of a team. Collect the facts, definitions, constraints and relevant prior user decisions needed for the task. Use tools where useful. Output concise bullet-point notes and clearly mark anything uncertain. Do not write the final answer.',
    tools: ['search_memory', 'get_current_time', 'calculator'],
    modelRole: 'research',
    maxIterations: 4,
    capabilities: ['research', 'facts', 'memory'],
  },
  {
    id: 'analyst',
    name: 'Analyst',
    description: 'Reasons about trade-offs, risks and implications.',
    instructions:
      'You are the analysis stage of a team. Using the task and any notes provided, analyse options, trade-offs, risks and implications. Check any numbers with the calculator. Output a compact structured analysis. Do not write the final answer.',
    tools: ['calculator'],
    modelRole: 'analysis',
    maxIterations: 3,
    capabilities: ['analysis', 'trade-offs', 'calculation'],
  },
  {
    id: 'writer',
    name: 'Writer',
    description: 'Synthesises the final user-facing answer from prior stages.',
    instructions:
      'You write the final answer for the user using the notes and analysis provided by your team. Be accurate and well organised. Do not mention the team, stages or notes; just answer.',
    tools: [],
    modelRole: 'synthesis',
    maxIterations: 1,
  },
  {
    id: 'supervisor',
    name: 'Supervisor',
    description: 'Decomposes complex tasks, delegates to specialists and synthesises the result.',
    instructions:
      'You coordinate specialist agents. Break the task into at most four independent subtasks and assign each to the most suitable specialist.',
    tools: [],
    modelRole: 'supervisor',
    maxIterations: 1,
  },
  {
    id: 'critic',
    name: 'Critic',
    description: 'Evaluates answers for correctness, completeness and instruction following.',
    instructions: 'You evaluate an answer written by another assistant.',
    tools: [],
    modelRole: 'evaluator',
    maxIterations: 1,
  },
  {
    id: 'refiner',
    name: 'Refiner',
    description: 'Improves an answer using evaluator feedback.',
    instructions:
      'Rewrite the previous answer so it fully addresses the feedback while keeping everything that was already correct. Output only the improved answer.',
    tools: [],
    modelRole: 'refiner',
    maxIterations: 1,
  },
];

export class AgentCatalog {
  private readonly agents = new Map<string, AgentDefinition>();

  constructor(custom: AgentDefinition[] = []) {
    for (const a of [...BUILTIN_AGENTS, ...custom]) this.agents.set(a.id, a);
  }

  get(id: string): AgentDefinition {
    const a = this.agents.get(id);
    if (!a) throw new Error(`Unknown agent "${id}"`);
    return a;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  ids(): string[] {
    return [...this.agents.keys()];
  }

  /** Specialists the supervisor may delegate to. */
  specialists(): AgentDefinition[] {
    return [...this.agents.values()].filter((a) => !['supervisor', 'critic', 'refiner', 'writer', 'code'].includes(a.id));
  }

  /** Roster line per specialist, including capabilities, for supervisor delegation. */
  roster(): string {
    return this.specialists()
      .map((a) => `- ${a.id}: ${a.description}${a.capabilities?.length ? ` [capabilities: ${a.capabilities.join(', ')}]` : ''}`)
      .join('\n');
  }
}
