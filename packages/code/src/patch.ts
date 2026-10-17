import { createTwoFilesPatch, parsePatch } from 'diff';

export type FileChange = {
  path: string;
  op: 'create' | 'modify' | 'delete' | 'rename';
  oldPath?: string;
  additions: number;
  deletions: number;
};

/** Git-style unified diff for one file (create/modify/delete). */
export function filePatch(path: string, before: string | null, after: string | null): string {
  const oldName = before === null ? '/dev/null' : `a/${path}`;
  const newName = after === null ? '/dev/null' : `b/${path}`;
  const body = createTwoFilesPatch(oldName, newName, before ?? '', after ?? '', '', '', { context: 3 });
  // createTwoFilesPatch emits "Index:" + "====" headers; git apply wants a diff --git header.
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.startsWith('--- '));
  const header = [`diff --git a/${path} b/${path}`];
  if (before === null) header.push('new file mode 100644');
  if (after === null) header.push('deleted file mode 100644');
  const rest = lines.slice(start);
  // A file with no textual change still yields headers only; return empty to signal "no change".
  if (!rest.some((l) => l.startsWith('@@'))) return '';
  return `${[...header, ...rest].join('\n').trimEnd()}\n`;
}

/** Rename expressed as a git patch (pure rename, content unchanged). */
export function renamePatch(oldPath: string, newPath: string): string {
  return `diff --git a/${oldPath} b/${newPath}\nsimilarity index 100%\nrename from ${oldPath}\nrename to ${newPath}\n`;
}

/** Per-file summary (+/-) of a unified diff, e.g. `src/auth/login.ts +12 -4`. */
export function summarizePatch(patch: string): FileChange[] {
  const out: FileChange[] = [];
  // Pure renames have no hunks; detect them from git headers.
  for (const m of patch.matchAll(/^diff --git a\/(.+?) b\/(.+?)\n(?:similarity index \d+%\n)?rename from .+\nrename to .+$/gm)) {
    out.push({ path: m[2]!, oldPath: m[1]!, op: 'rename', additions: 0, deletions: 0 });
  }
  for (const file of parsePatch(patch)) {
    const oldName = strip(file.oldFileName);
    const newName = strip(file.newFileName);
    if (!oldName && !newName) continue;
    let additions = 0;
    let deletions = 0;
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.startsWith('+')) additions++;
        else if (l.startsWith('-')) deletions++;
      }
    }
    const op: FileChange['op'] = oldName === null ? 'create' : newName === null ? 'delete' : oldName !== newName ? 'rename' : 'modify';
    const path = (newName ?? oldName)!;
    const existing = out.find((c) => c.path === path);
    if (existing) {
      existing.additions += additions;
      existing.deletions += deletions;
    } else {
      out.push({ path, op, additions, deletions, ...(op === 'rename' ? { oldPath: oldName! } : {}) });
    }
  }
  return out;
}

function strip(name: string | undefined): string | null {
  if (!name || name === '/dev/null') return null;
  return name.replace(/^[ab]\//, '').replace(/\t.*$/, '');
}
