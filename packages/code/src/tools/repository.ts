import { z } from 'zod';
import { Scopes } from '@neuroflow/contracts';
import { defineTool, ToolExecutionError, type ToolDefinition } from '@neuroflow/tools';
import { FileTooLargeError } from '../workspace';
import { PathPolicyError } from '../paths';
import { findReferences, findSymbol } from '../repo-index';
import { openFor, type CodeServices } from '../services';

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 40_000;

const pathArg = z.string().trim().min(1).max(500).describe('Repository-relative path, e.g. src/index.ts');

export function wrapFsError(err: unknown): never {
  if (err instanceof PathPolicyError || err instanceof FileTooLargeError) throw new ToolExecutionError(err.message);
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new ToolExecutionError('File not found');
  throw err;
}

export function repositoryTools(services: CodeServices): ToolDefinition[] {
  const listFiles = defineTool({
    name: 'list_files',
    description:
      'List files in the repository (tracked and new files, respecting .gitignore). Filter by directory prefix and/or a substring. Use this to understand structure before reading files.',
    input: z.object({
      directory: z.string().max(500).optional().describe('Only files under this directory, e.g. src/auth'),
      contains: z.string().max(200).optional().describe('Only paths containing this text, e.g. "test" or ".tsx"'),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: false,
    permissions: [Scopes.codeRead],
    timeoutMs: 30_000,
    maxResultChars: 20_000,
    async execute({ directory, contains, limit }, ctx) {
      const { ws } = await openFor(services, ctx);
      const { files } = await ws.checkout.tree();
      const dir = directory?.replace(/\\/g, '/').replace(/^\.?\/*/, '').replace(/\/*$/, '');
      const matched = files.filter((f) => (!dir || f.path === dir || f.path.startsWith(`${dir}/`)) && (!contains || f.path.toLowerCase().includes(contains.toLowerCase())));
      const max = limit ?? 200;
      return {
        total: matched.length,
        files: matched.slice(0, max).map((f) => (f.status ? `${f.path} [${f.status}]` : f.path)),
        ...(matched.length > max ? { note: `Showing ${max} of ${matched.length}; narrow with directory/contains.` } : {}),
      };
    },
    summarize: (o) => `${o.total} file${o.total === 1 ? '' : 's'}`,
  });

  const readFile = defineTool({
    name: 'read_file',
    description: `Read a file (with line numbers). Read only what you need: pass startLine/endLine for large files (max ${MAX_READ_LINES} lines per call).`,
    input: z.object({
      path: pathArg,
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: false,
    permissions: [Scopes.codeRead],
    timeoutMs: 15_000,
    maxResultChars: MAX_READ_CHARS + 2_000,
    async execute({ path, startLine, endLine }, ctx) {
      const { ws } = await openFor(services, ctx);
      const file = await ws.checkout.read(path).catch(wrapFsError);
      if (file.binary) return { path: file.path, binary: true, size: file.size };
      const lines = file.content.split('\n');
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
      let content = lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
        .join('\n');
      if (content.length > MAX_READ_CHARS) content = `${content.slice(0, MAX_READ_CHARS)}\n…[truncated]`;
      ctx.emit('file.read', { path: file.path, startLine: start, endLine: end, bytes: file.size });
      await services.store.addContext(ctx.runId, { kind: 'file_read', path: file.path, startLine: start, endLine: end }).catch(() => {});
      return {
        path: file.path,
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        content,
        ...(end < lines.length ? { more: `Lines ${end + 1}-${lines.length} not shown` } : {}),
      };
    },
    summarize: (o) => ('binary' in o ? `${o.path} (binary)` : `${o.path}:${o.startLine}-${o.endLine}`),
  });

  const searchCode = defineTool({
    name: 'search_code',
    description:
      'Search file contents (like grep). Use a plain string, or regex=true for a regular expression. Restrict with paths (directories or files). Returns path:line matches.',
    input: z.object({
      query: z.string().min(1).max(300),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      paths: z.array(z.string().max(500)).max(10).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    riskLevel: 'low',
    requiresApproval: false,
    sideEffects: false,
    permissions: [Scopes.codeRead],
    timeoutMs: 30_000,
    maxResultChars: 16_000,
    async execute({ query, regex, caseSensitive, paths, limit }, ctx) {
      const { ws } = await openFor(services, ctx);
      const kind = regex ? 'regex' : 'text';
      ctx.emit('file.search.started', { query, kind });
      const hits = await ws.checkout.git.grep(query, { regex, ignoreCase: !caseSensitive, paths, max: limit ?? 80 });
      const files = [...new Set(hits.map((h) => h.path))];
      ctx.emit('file.search.completed', { query, kind, matches: hits.length, files: files.slice(0, 20) });
      await services.store.addContext(ctx.runId, { kind: 'search', detail: `${kind}: ${query} (${hits.length})` }).catch(() => {});
      return { matches: hits.length, files: files.length, results: hits.map((h) => `${h.path}:${h.line}: ${h.text.trim()}`) };
    },
    summarize: (o) => `${o.matches} match${o.matches === 1 ? '' : 'es'} in ${o.files} file${o.files === 1 ? '' : 's'}`,
  });

  const symbolTool = (name: 'find_symbol' | 'find_references') =>
    defineTool({
      name,
      description:
        name === 'find_symbol'
          ? 'Find where a function, class, type, interface or variable is defined.'
          : 'Find usages of an identifier across the repository (excluding its definitions).',
      input: z.object({ name: z.string().min(1).max(120).describe('Identifier, e.g. createUser'), limit: z.number().int().min(1).max(200).optional() }),
      riskLevel: 'low',
      requiresApproval: false,
      sideEffects: false,
      permissions: [Scopes.codeRead],
      timeoutMs: 30_000,
      maxResultChars: 12_000,
      async execute({ name: ident, limit }, ctx) {
        const { ws } = await openFor(services, ctx);
        const kind = name === 'find_symbol' ? 'symbol' : 'references';
        ctx.emit('file.search.started', { query: ident, kind });
        const hits = name === 'find_symbol' ? await findSymbol(ws.checkout.git, ident, limit ?? 20) : await findReferences(ws.checkout.git, ident, limit ?? 60);
        const files = [...new Set(hits.map((h) => h.path))];
        ctx.emit('file.search.completed', { query: ident, kind, matches: hits.length, files: files.slice(0, 20) });
        return { name: ident, count: hits.length, results: hits.map((h) => `${h.path}:${h.line}: ${h.text.trim()}`) };
      },
      summarize: (o) => `${o.count} ${name === 'find_symbol' ? 'definition' : 'reference'}${o.count === 1 ? '' : 's'}`,
    });

  return [listFiles, readFile, searchCode, symbolTool('find_symbol'), symbolTool('find_references')] as ToolDefinition[];
}
