import type { RunEventPayload, RunEventType, WorkspaceContext } from '@neuroflow/contracts';
import { summarizePatch, type CodeWorkspaceService } from '@neuroflow/code';
import { codeRunsRepo, type Pool } from '@neuroflow/db';
import type { CodeContext } from '@neuroflow/orchestrator';

type Emit = <T extends RunEventType>(type: T, data: RunEventPayload<T>) => void;

const EDITOR_SURROUNDING_LINES = 20;
const EDITOR_MAX_LINES = 300;
const PINNED_MAX_CHARS = 12_000;

const numbered = (lines: string[], start: number) => lines.map((l, i) => `${String(start + i).padStart(4)}| ${l}`).join('\n');

/**
 * Prepares a code run: verifies the code workspace, records the code run, emits
 * `code.run.created` / `repository.loaded`, and assembles bounded code context (repository map,
 * repository instructions, editor selection with surrounding code, pinned files).
 */
export async function prepareCodeRun(input: {
  pool: Pool;
  code: CodeWorkspaceService;
  runId: string;
  workspaceId: string;
  wc: WorkspaceContext;
  emit: Emit;
}): Promise<CodeContext> {
  const { pool, code, runId, wc, emit } = input;
  const ws = await code.open(wc.codeWorkspaceId, input.workspaceId);
  const checkout = ws.checkout;
  const [branch, head, { profile, map }] = await Promise.all([checkout.git.currentBranch(), checkout.git.head(), checkout.understand()]);

  await codeRunsRepo.create(pool, { runId, codeWorkspaceId: ws.id, approvalMode: wc.approvalMode, baseCommit: head });
  emit('code.run.created', { codeWorkspaceId: ws.id, repository: ws.repository.fullName, branch, approvalMode: wc.approvalMode, baseCommit: head });
  emit('repository.loaded', {
    repository: ws.repository.fullName,
    branch,
    commit: head,
    fileCount: map.fileCount,
    languages: map.languages.map((l) => l.language),
    projectKind: profile.kind,
    instructions: Boolean(map.instructions),
  });

  const commands = { ...profile.commands, ...ws.commands };
  const repository = [
    await checkout.summary({ repository: ws.repository.fullName, branch }),
    `Commands: ${Object.entries(commands).map(([k, v]) => `${k}=\`${v}\``).join(', ') || 'none detected'}`,
    `Base branch: ${ws.baseBranch}. Approval mode: ${wc.approvalMode}${wc.approvalMode === 'suggest' ? ' (changes are proposed, not applied)' : wc.approvalMode === 'restricted' ? ' (read-only)' : ''}.`,
  ].join('\n');
  await codeRunsRepo.addContext(pool, runId, { kind: 'repository_map', detail: `${map.fileCount} files` });
  if (map.instructions) await codeRunsRepo.addContext(pool, runId, { kind: 'instructions', path: '.neuroflow/instructions.md' });

  let editor: string | undefined;
  if (wc.activeFile) {
    const text = await checkout.readText(wc.activeFile).catch(() => null);
    if (text !== null) {
      const lines = text.split('\n');
      if (wc.selectedLines) {
        const s = Math.min(wc.selectedLines.start, lines.length);
        const e = Math.min(wc.selectedLines.end, lines.length, s + EDITOR_MAX_LINES - 1);
        const from = Math.max(1, s - EDITOR_SURROUNDING_LINES);
        const to = Math.min(lines.length, e + EDITOR_SURROUNDING_LINES);
        editor = [
          `Active file: ${wc.activeFile} (${lines.length} lines)`,
          `Selected lines ${s}-${e}:`,
          numbered(lines.slice(s - 1, e), s),
          `Surrounding code (lines ${from}-${to}):`,
          numbered(lines.slice(from - 1, to), from),
        ].join('\n');
        await codeRunsRepo.addContext(pool, runId, { kind: 'selection', path: wc.activeFile, startLine: s, endLine: e });
      } else {
        editor = `Active file: ${wc.activeFile} (${lines.length} lines)\n${numbered(lines.slice(0, EDITOR_MAX_LINES), 1)}${lines.length > EDITOR_MAX_LINES ? '\n…[more lines — use read_file]' : ''}`;
        await codeRunsRepo.addContext(pool, runId, { kind: 'active_file', path: wc.activeFile });
      }
    }
  }

  let pinned: string | undefined;
  if (wc.relatedFiles?.length) {
    const parts: string[] = [];
    let used = 0;
    for (const f of wc.relatedFiles) {
      if (used > PINNED_MAX_CHARS) break;
      const text = await checkout.readText(f).catch(() => null);
      if (text === null) continue;
      const chunk = `--- ${f}\n${text.slice(0, PINNED_MAX_CHARS - used)}`;
      parts.push(chunk);
      used += chunk.length;
      await codeRunsRepo.addContext(pool, runId, { kind: 'related_file', path: f });
    }
    if (parts.length) pinned = parts.join('\n\n');
  }

  return { repository, ...(map.instructions ? { instructions: map.instructions } : {}), ...(editor ? { editor } : {}), ...(pinned ? { pinned } : {}) };
}

/** Emits `code.run.completed` with the run's change and validation summary. */
export async function finishCodeRun(input: {
  pool: Pool;
  code: CodeWorkspaceService;
  runId: string;
  workspaceId: string;
  wc: WorkspaceContext;
  status: 'completed' | 'failed' | 'cancelled';
  emit: Emit;
}) {
  const diff = await input.code
    .checkout(input.wc.codeWorkspaceId)
    .git.diff()
    .catch(() => '');
  const files = summarizePatch(diff);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const row = await codeRunsRepo.get(input.pool, input.runId);
  // Committed changes are no longer in the working diff; keep the larger of the two counts.
  const filesChanged = Math.max(files.length, row?.filesChanged ?? 0);
  await codeRunsRepo.update(input.pool, input.runId, { filesChanged, additions: Math.max(additions, row?.additions ?? 0), deletions: Math.max(deletions, row?.deletions ?? 0) });
  input.emit('code.run.completed', {
    status: input.status,
    filesChanged,
    additions: Math.max(additions, row?.additions ?? 0),
    deletions: Math.max(deletions, row?.deletions ?? 0),
    testsPassed: row?.testsPassed ?? null,
  });
}
