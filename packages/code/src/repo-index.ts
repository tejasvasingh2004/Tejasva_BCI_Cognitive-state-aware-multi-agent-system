import type { Git } from './git';
import type { ProjectProfile } from './detect';

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP',
  cs: 'C#', cpp: 'C++', cc: 'C++', c: 'C', h: 'C', hpp: 'C++', swift: 'Swift',
  css: 'CSS', scss: 'SCSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte',
  sql: 'SQL', sh: 'Shell', md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
};

export function languageOf(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANGUAGE_BY_EXT[ext];
}

export type RepoMap = {
  fileCount: number;
  languages: Array<{ language: string; files: number }>;
  /** Top-level entries with file counts, e.g. `src/ (42 files)`. */
  structure: string[];
  manifests: string[];
  instructions: string | null;
};

export const INSTRUCTIONS_PATH = '.neuroflow/instructions.md';

/** Bounded repository overview used as Code Agent context (never the whole repository). */
export function buildRepoMap(files: string[], profile: ProjectProfile, instructions: string | null): RepoMap {
  const langs = new Map<string, number>();
  const top = new Map<string, number>();
  for (const f of files) {
    const lang = languageOf(f);
    if (lang) langs.set(lang, (langs.get(lang) ?? 0) + 1);
    const slash = f.indexOf('/');
    const key = slash === -1 ? f : `${f.slice(0, slash)}/`;
    top.set(key, (top.get(key) ?? 0) + 1);
  }
  return {
    fileCount: files.length,
    languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([language, n]) => ({ language, files: n })),
    structure: [...top.entries()]
      .sort((a, b) => Number(b[0].endsWith('/')) - Number(a[0].endsWith('/')) || a[0].localeCompare(b[0]))
      .slice(0, 40)
      .map(([k, n]) => (k.endsWith('/') ? `${k} (${n} file${n === 1 ? '' : 's'})` : k)),
    manifests: profile.manifests,
    instructions: instructions ? instructions.slice(0, 6000) : null,
  };
}

export function renderRepoMap(map: RepoMap, profile: ProjectProfile, meta: { repository: string; branch: string; commit?: string }): string {
  const lines = [
    `Repository: ${meta.repository} (branch ${meta.branch}${meta.commit ? ` @ ${meta.commit.slice(0, 8)}` : ''})`,
    `Files: ${map.fileCount}. Languages: ${map.languages.map((l) => `${l.language} (${l.files})`).join(', ') || 'unknown'}.`,
    `Project: ${profile.kind}${profile.packageManager ? ` (${profile.packageManager})` : ''}. Manifests: ${map.manifests.join(', ') || 'none'}.`,
    `Commands: ${Object.entries(profile.commands).map(([k, v]) => `${k}=\`${v}\``).join(', ') || 'none detected'}.`,
    `Top-level structure:\n${map.structure.map((s) => `  ${s}`).join('\n')}`,
  ];
  const deps = profile.dependencies.filter((d) => !d.dev).slice(0, 30);
  if (deps.length) lines.push(`Main dependencies: ${deps.map((d) => `${d.name}@${d.version}`).join(', ')}`);
  return lines.join('\n');
}

/** Definition patterns per language family; `NAME` is replaced by the escaped identifier. */
const DEFINITION_PATTERNS = [
  // TS/JS
  '(export\\s+)?(default\\s+)?(async\\s+)?function\\*?\\s+NAME\\b',
  '(export\\s+)?(abstract\\s+)?class\\s+NAME\\b',
  '(export\\s+)?(interface|type|enum)\\s+NAME\\b',
  '(export\\s+)?(const|let|var)\\s+NAME\\s*[:=]',
  // Python
  '^\\s*(async\\s+)?def\\s+NAME\\s*\\(',
  '^\\s*class\\s+NAME\\b',
  // Go
  'func\\s+(\\([^)]*\\)\\s*)?NAME\\s*\\(',
  'type\\s+NAME\\s+(struct|interface)',
  // Rust
  '(pub\\s+)?(fn|struct|enum|trait|type)\\s+NAME\\b',
  // Java/C#/Kotlin methods (approximate)
  '(public|private|protected|static)[^=;]*\\s+NAME\\s*\\(',
];

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,120}$/;

export type SymbolHit = { path: string; line: number; text: string; kind: 'definition' | 'reference' };

/** Finds definitions of an identifier (regex based; works without a language server). */
export async function findSymbol(git: Git, name: string, max = 20): Promise<SymbolHit[]> {
  if (!IDENT.test(name)) return [];
  const escaped = name.replace(/\$/g, '\\$');
  const pattern = DEFINITION_PATTERNS.map((p) => p.replace('NAME', escaped)).join('|');
  const hits = await git.grep(pattern, { regex: true, max });
  return hits.map((h) => ({ ...h, kind: 'definition' as const }));
}

/** Finds whole-word references to an identifier, excluding its definition lines. */
export async function findReferences(git: Git, name: string, max = 100): Promise<SymbolHit[]> {
  if (!IDENT.test(name)) return [];
  const defs = new Set((await findSymbol(git, name, 50)).map((d) => `${d.path}:${d.line}`));
  const escaped = name.replace(/[$]/g, '\\$');
  const hits = await git.grep(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, { regex: true, max: max + defs.size });
  return hits
    .filter((h) => !defs.has(`${h.path}:${h.line}`))
    .slice(0, max)
    .map((h) => ({ ...h, kind: 'reference' as const }));
}
