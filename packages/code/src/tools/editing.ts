import { z } from 'zod';
import { Scopes, type ApprovalMode, type FileChange } from '@neuroflow/contracts';
import { defineTool, ToolExecutionError, type Prepared, type ToolContext, type ToolDefinition } from '@neuroflow/tools';
import { filePatch, renamePatch, summarizePatch } from '../patch';
import { normalizeRepoPath } from '../paths';
import { assertModeAllows, openFor, type CodeServices, type OpenCodeWorkspace } from '../services';
import { wrapFsError } from './repository';

/** Changes that require approval even in Auto mode. */
const SENSITIVE = /(^|\/)(\.github\/|\.gitlab-ci|\.env|Dockerfile|docker-compose|.*\.pem$|.*\.key$|id_rsa|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.npmrc$|\.neuroflow\/)/i;
const AUTO_MAX_FILES = 8;
const AUTO_MAX_LINES = 400;
const MAX_REVIEW_DIFF = 60_000;

type PatchState = { patchId: string; diff: string; files: FileChange[]; ws: OpenCodeWorkspace };

/** Why Auto mode still asks for approval for this change (undefined = low risk). */
export function highImpactReason(files: FileChange[]): string | undefined {
  if (files.some((f) => f.op === 'delete')) return 'deletes files';
  if (files.some((f) => f.op === 'rename')) return 'renames files';
  if (files.length > AUTO_MAX_FILES) return `changes ${files.length} files`;
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (lines > AUTO_MAX_LINES) return `changes ${lines} lines`;
  const sensitive = files.find((f) => SENSITIVE.test(f.path) || (f.oldPath && SENSITIVE.test(f.oldPath)));
  if (sensitive) return `touches ${sensitive.path}`;
  return undefined;
}

/**
 * Shared prepare step: validate the patch, persist it and apply the approval mode.
 * Generating a patch never mutates the repository.
 */
async function proposePatch(
  services: CodeServices,
  ctx: ToolContext,
  ws: OpenCodeWorkspace,
  mode: ApprovalMode,
  diff: string,
  summary: string | undefined,
): Promise<Prepared<PatchState>> {
  if (!diff.trim()) throw new ToolExecutionError('The change is empty (the file already has this content)');
  const files = summarizePatch(diff);
  if (files.length === 0) throw new ToolExecutionError('The patch contains no file changes');
  const check = await ws.checkout.git.applyCheck(diff);
  const highImpact = highImpactReason(files);
  const needsReview = mode === 'review' || (mode === 'auto' && highImpact !== undefined);
  const status = !check.ok ? 'failed' : mode === 'suggest' ? 'proposed' : needsReview ? 'review_required' : 'approved';
  const toolCallId = ctx.toolCallId ?? "";
  const patch = await services.store.createPatch({
    workspaceId: ctx.workspaceId,
    codeWorkspaceId: ws.id,
    runId: ctx.runId,
    toolCallId,
    baseCommit: await ws.checkout.git.head().catch(() => null),
    files,
    diff,
    summary,
    validation: check.ok ? 'valid' : 'invalid',
    validationError: check.error,
    status,
  });
  ctx.emit('patch.generated', { patchId: patch.id, toolCallId, files, valid: check.ok, ...(check.error ? { error: check.error } : {}) });
  if (!check.ok) throw new ToolExecutionError(`The patch does not apply to the current files: ${check.error}. Re-read the file and try again.`);

  const state: PatchState = { patchId: patch.id, diff, files, ws };
  if (mode === 'suggest') {
    return {
      output: { patchId: patch.id, status: 'proposed', applied: false, files, note: 'Suggest mode: the change was proposed to the user and not applied.' },
      state,
    };
  }
  if (needsReview) {
    ctx.emit('patch.review_required', { patchId: patch.id, toolCallId, files, diff: diff.slice(0, MAX_REVIEW_DIFF) });
    return {
      approval: {
        reason: mode === 'review' ? 'Review mode: changes are applied only after you approve them' : `Auto mode: approval needed because this change ${highImpact}`,
        preview: { patchId: patch.id, files },
      },
      state,
    };
  }
  return { state };
}

async function onPatchDecision(services: CodeServices, approved: boolean, prepared: Prepared, ctx: ToolContext) {
  const s = prepared.state as PatchState | undefined;
  if (!s) return;
  await services.store.setPatchStatus(s.patchId, approved ? 'approved' : 'rejected');
  if (approved) ctx.emit('patch.approved', { patchId: s.patchId });
  else ctx.emit('patch.rejected', { patchId: s.patchId });
}

/** Applies an approved patch, re-validating first (the tree may have changed while waiting). */
async function applyPatch(services: CodeServices, ctx: ToolContext, prepared: Prepared | undefined) {
  const s = prepared?.state as PatchState | undefined;
  if (!s) throw new ToolExecutionError('No prepared patch');
  const check = await s.ws.checkout.git.applyCheck(s.diff);
  if (!check.ok) {
    await services.store.setPatchStatus(s.patchId, 'failed');
    throw new ToolExecutionError(`The files changed since the patch was generated; it no longer applies: ${check.error}`);
  }
  await s.ws.checkout.git.apply(s.diff);
  await services.store.setPatchStatus(s.patchId, 'applied');
  for (const f of s.files) {
    ctx.emit('file.modified', { path: f.path, op: f.op, additions: f.additions, deletions: f.deletions, patchId: s.patchId });
  }
  await emitDiffUpdate(services, ctx, s.ws);
  return { patchId: s.patchId, applied: true, files: s.files.map((f) => `${f.path} +${f.additions} -${f.deletions}`) };
}

/** Publishes the working-tree diff summary and keeps the code run's change stats current. */
export async function emitDiffUpdate(services: CodeServices, ctx: ToolContext, ws: OpenCodeWorkspace) {
  const diff = await ws.checkout.git.diff();
  const files = summarizePatch(diff);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  ctx.emit('git.diff.updated', { files, additions, deletions });
  await services.store.updateCodeRun(ctx.runId, { filesChanged: files.length, additions, deletions }).catch(() => {});
  return { files, additions, deletions, diff };
}

const summaryArg = z.string().max(300).optional().describe('One line describing the change');

export function editingTools(services: CodeServices): ToolDefinition[] {
  const common = {
    riskLevel: 'medium' as const,
    requiresApproval: false,
    sideEffects: true,
    permissions: [Scopes.codeWrite],
    timeoutMs: 60_000,
  };
  const twoPhase = <I extends z.ZodType>(
    name: string,
    description: string,
    input: I,
    build: (args: z.infer<I>, ws: OpenCodeWorkspace) => Promise<{ diff: string; summary?: string }>,
    riskLevel: 'medium' | 'high' = 'medium',
  ) =>
    defineTool({
      ...common,
      riskLevel,
      name,
      description,
      input,
      async prepare(args, ctx) {
        const { ws, mode } = await openFor(services, ctx);
        assertModeAllows(mode, 'mutate');
        const { diff, summary } = await build(args, ws).catch(wrapFsError);
        return proposePatch(services, ctx, ws, mode, diff, summary);
      },
      onDecision: (approved, prepared, ctx) => onPatchDecision(services, approved, prepared, ctx),
      execute: (_args, ctx, prepared) => applyPatch(services, ctx, prepared),
      summarize: (o: { files?: unknown[]; applied?: boolean }) =>
        o.applied ? `Applied changes to ${o.files?.length ?? 0} file(s)` : 'Change proposed (not applied)',
    }) as ToolDefinition;

  const createFile = twoPhase(
    'create_file',
    'Create a new file with the given content. Fails if the file already exists (use edit_file instead).',
    z.object({ path: z.string().min(1).max(500), content: z.string().max(400_000), summary: summaryArg }),
    async ({ path, content, summary }, ws) => {
      const p = normalizeRepoPath(path);
      if ((await ws.checkout.readText(p)) !== null) throw new ToolExecutionError(`${p} already exists`);
      return { diff: filePatch(p, null, content.endsWith('\n') ? content : `${content}\n`), summary };
    },
  );

  const editFile = twoPhase(
    'edit_file',
    'Make targeted edits to an existing file. Each edit replaces one exact occurrence of `find` (copy it verbatim from read_file output, without line numbers) with `replace`. Prefer several small edits over rewriting the file. Use `content` only to replace a whole small file.',
    z
      .object({
        path: z.string().min(1).max(500),
        edits: z
          .array(z.object({ find: z.string().min(1).max(20_000), replace: z.string().max(40_000) }))
          .max(30)
          .optional(),
        content: z.string().max(400_000).optional(),
        summary: summaryArg,
      })
      .refine((v) => Boolean(v.edits?.length) !== (v.content !== undefined), 'Provide either edits or content'),
    async ({ path, edits, content, summary }, ws) => {
      const p = normalizeRepoPath(path);
      const before = await ws.checkout.readText(p);
      if (before === null) throw new ToolExecutionError(`${p} does not exist (use create_file)`);
      let after = before;
      if (content !== undefined) after = content;
      else {
        for (const [i, e] of (edits ?? []).entries()) {
          const count = after.split(e.find).length - 1;
          if (count === 0) throw new ToolExecutionError(`Edit ${i + 1}: the text to find was not found in ${p}. Re-read the file and copy it exactly.`);
          if (count > 1) throw new ToolExecutionError(`Edit ${i + 1}: the text to find occurs ${count} times in ${p}; include more surrounding lines so it is unique.`);
          after = after.split(e.find).join(e.replace);
        }
      }
      return { diff: filePatch(p, before, after), summary };
    },
  );

  const renameFile = twoPhase(
    'rename_file',
    'Rename or move a file.',
    z.object({ from: z.string().min(1).max(500), to: z.string().min(1).max(500), summary: summaryArg }),
    async ({ from, to, summary }, ws) => {
      const a = normalizeRepoPath(from);
      const b = normalizeRepoPath(to);
      if ((await ws.checkout.readText(a)) === null) throw new ToolExecutionError(`${a} does not exist`);
      if ((await ws.checkout.readText(b)) !== null) throw new ToolExecutionError(`${b} already exists`);
      return { diff: renamePatch(a, b), summary };
    },
    'high',
  );

  const deleteFile = twoPhase(
    'delete_file',
    'Delete a file. Always requires the user\'s approval unless they chose Suggest mode (then it is only proposed).',
    z.object({ path: z.string().min(1).max(500), summary: summaryArg }),
    async ({ path, summary }, ws) => {
      const p = normalizeRepoPath(path);
      const before = await ws.checkout.readText(p);
      if (before === null) throw new ToolExecutionError(`${p} does not exist`);
      return { diff: filePatch(p, before, null), summary };
    },
    'high',
  );

  const applyPatchTool = twoPhase(
    'apply_patch',
    'Apply a unified diff (git format, paths prefixed a/ and b/) that may touch several files. The patch is validated before anything changes.',
    z.object({ patch: z.string().min(10).max(400_000), summary: summaryArg }),
    async ({ patch, summary }) => {
      const files = summarizePatch(patch);
      for (const f of files) {
        normalizeRepoPath(f.path);
        if (f.oldPath) normalizeRepoPath(f.oldPath);
      }
      return { diff: patch.endsWith('\n') ? patch : `${patch}\n`, summary };
    },
  );

  return [createFile, editFile, renameFile, deleteFile, applyPatchTool];
}
