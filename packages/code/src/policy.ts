/**
 * Code Agent approval modes (PRD §56.13), persisted with the run and enforced by the Tool Runtime:
 * - suggest:    patches are proposed only; nothing in the repository is changed by the agent
 * - review:     patches and consequential actions are held for explicit approval
 * - auto:       low-risk changes and known dev commands run within policy; high-impact still asks
 * - restricted: read-only — editing, execution and Git write tools are unavailable
 */
export type ApprovalMode = 'suggest' | 'review' | 'auto' | 'restricted';
export const APPROVAL_MODES: readonly ApprovalMode[] = ['suggest', 'review', 'auto', 'restricted'];

export type CommandDecision = {
  decision: 'allow' | 'approval' | 'deny';
  reason: string;
  /** Network access is only granted to dependency installs. */
  network: 'none' | 'bridge';
  category: 'test' | 'lint' | 'build' | 'install' | 'inspect' | 'run' | 'unknown';
};

/** Always refused: system changes, privilege escalation, exfiltration, VCS remote ops, sandbox escape. */
const DENY: Array<[RegExp, string]> = [
  [/\b(sudo|su|doas)\b/, 'privilege escalation'],
  [/\b(mkfs|fdisk|mount|umount|shutdown|reboot|halt|poweroff|kill\s+-9\s+1|iptables|sysctl)\b/, 'system changes'],
  [/\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\s+(\/|~|\*|\.\.?\/?)(\s|$)/i, 'destructive filesystem action'],
  [/\b(dd)\s+if=/, 'raw device access'],
  [/:\(\)\s*\{.*\};\s*:/, 'fork bomb'],
  [/\b(docker|podman|kubectl|nsenter|chroot)\b/, 'container / host control'],
  [/\b(ssh|scp|sftp|nc|ncat|netcat|telnet|socat)\b/, 'remote shell / raw network'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python|node)\b/, 'downloading and executing code'],
  [/\bgit\s+(push|remote|config|credential|filter-branch|gc\s+--prune)\b/, 'git remote/config operations go through Git tools'],
  [/\/etc\/(shadow|passwd|sudoers)|\/proc\/\d+\/environ|\/var\/run\/docker\.sock/, 'sensitive system paths'],
  [/\b(printenv|env)\b\s*($|\|)/, 'environment dump'],
];

const INSTALL = /^(npm\s+(ci|install|i)\b|pnpm\s+(install|i)\b|corepack\s+pnpm\s+(install|i)\b|yarn(\s+install)?\s*($|--)|bun\s+install\b|pip3?\s+install\b|python3?\s+-m\s+pip\s+install\b|poetry\s+install\b|uv\s+(sync|pip\s+install)\b|go\s+mod\s+(download|tidy)\b|cargo\s+fetch\b|bundle\s+install\b)/;
const TEST = /^((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|corepack\s+pnpm\s+(run\s+)?test\b|npx\s+(vitest|jest|mocha)\b|vitest\b|jest\b|(python3?\s+-m\s+)?pytest\b|go\s+test\b|cargo\s+test\b|make\s+test\b|mvn\s+test\b|gradle\s+test\b|dotnet\s+test\b)/;
const LINT = /^((npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|check|format:check)\b|corepack\s+pnpm\s+(run\s+)?(lint|typecheck)\b|npx\s+(eslint|tsc|prettier\s+--check|biome\s+check)\b|eslint\b|tsc\b|ruff\s+(check|format\s+--check)\b|flake8\b|mypy\b|go\s+vet\b|cargo\s+(clippy|fmt\s+--check)\b|make\s+lint\b)/;
const BUILD = /^((npm|pnpm|yarn|bun)\s+(run\s+)?build\b|corepack\s+pnpm\s+(run\s+)?build\b|npx\s+(tsc|vite\s+build)\b|go\s+build\b|cargo\s+(build|check)\b|make(\s+build)?\s*$|mvn\s+(package|compile)\b|python3?\s+-m\s+build\b)/;
const INSPECT = /^(ls|cat|head|tail|wc|pwd|find|tree|grep|node\s+--version|npm\s+(ls|--version)|python3?\s+--version|go\s+version|git\s+(status|diff|log|show|branch)\b)/;

function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Classifies a command for the sandbox. Known development commands (tests, lint, build) are
 * low risk; dependency installs need network; anything unrecognised needs explicit approval.
 */
export function classifyCommand(command: string, mode: ApprovalMode): CommandDecision {
  const cmd = command.trim();
  if (!cmd) return { decision: 'deny', reason: 'empty command', network: 'none', category: 'unknown' };
  if (mode === 'restricted') {
    return { decision: 'deny', reason: 'command execution is disabled in Restricted mode', network: 'none', category: 'unknown' };
  }
  for (const [re, reason] of DENY) {
    if (re.test(cmd)) return { decision: 'deny', reason: `blocked: ${reason}`, network: 'none', category: 'unknown' };
  }
  if (/`|\$\(/.test(cmd)) {
    return { decision: mode === 'suggest' ? 'deny' : 'approval', reason: 'command substitution needs review', network: 'none', category: 'unknown' };
  }

  const segments = splitSegments(cmd);
  const categories = segments.map((s): CommandDecision['category'] =>
    INSTALL.test(s) ? 'install' : TEST.test(s) ? 'test' : LINT.test(s) ? 'lint' : BUILD.test(s) ? 'build' : INSPECT.test(s) ? 'inspect' : 'unknown',
  );
  const category = categories.includes('unknown') ? 'unknown' : categories.includes('install') ? 'install' : categories[0]!;
  const network = categories.includes('install') ? 'bridge' : 'none';

  if (category === 'unknown') {
    return {
      decision: mode === 'suggest' ? 'deny' : 'approval',
      reason: mode === 'suggest' ? 'unrecognised commands are not run in Suggest mode' : 'unrecognised command requires approval',
      network,
      category,
    };
  }
  if (category === 'install') {
    // Installs download third-party code with network access: approval unless running in Auto.
    return {
      decision: mode === 'auto' ? 'allow' : 'approval',
      reason: 'dependency install (network access)',
      network,
      category,
    };
  }
  return { decision: 'allow', reason: `known ${category} command`, network, category };
}
