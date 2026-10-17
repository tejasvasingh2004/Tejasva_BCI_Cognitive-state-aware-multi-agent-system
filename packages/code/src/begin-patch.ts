import { filePatch } from './patch';
import { normalizeRepoPath } from './paths';

/**
 * OpenAI-style "*** Begin Patch" envelopes (emitted by GPT-OSS and other OpenAI-trained models):
 *
 *   *** Begin Patch
 *   *** Update File: src/a.py
 *   @@ def add(a, b):
 *   -    return a - b
 *   +    return a + b
 *   *** Add File: notes.md
 *   +hello
 *   *** Delete File: old.py
 *   *** End Patch
 *
 * Hunks are located by their context/removed lines (not line numbers), then the result is turned
 * into an ordinary unified diff so validation, review and approval are unchanged.
 */
export function isBeginPatch(text: string): boolean {
  return /^\s*\*\*\* Begin Patch\s*$/m.test(text);
}

export class BeginPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BeginPatchError';
  }
}

type Op =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] };
type Hunk = { anchor?: string; lines: string[] };

function parse(text: string): Op[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const ops: Op[] = [];
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  if (i < 0) throw new BeginPatchError('Missing "*** Begin Patch"');
  i++;
  const header = (l: string, name: string) => (l.startsWith(`*** ${name}: `) ? l.slice(name.length + 6).trim() : null);
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '*** End Patch') return ops;
    let path: string | null;
    if ((path = header(line, 'Add File')) !== null) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!;
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l !== '') throw new BeginPatchError(`Add File ${path}: every line must start with "+"`);
        i++;
      }
      ops.push({ kind: 'add', path, lines: body });
    } else if ((path = header(line, 'Delete File')) !== null) {
      ops.push({ kind: 'delete', path });
      i++;
    } else if ((path = header(line, 'Update File')) !== null) {
      const op: Extract<Op, { kind: 'update' }> = { kind: 'update', path, hunks: [] };
      i++;
      const moveTo = lines[i] !== undefined ? header(lines[i]!, 'Move to') : null;
      if (moveTo !== null) {
        op.moveTo = moveTo;
        i++;
      }
      let hunk: Hunk | null = null;
      while (i < lines.length && !(lines[i]!.startsWith('*** ') && lines[i]!.trim() !== '*** End of File')) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          hunk = { lines: [], ...(l.slice(2).trim() ? { anchor: l.slice(2).trim() } : {}) };
          op.hunks.push(hunk);
        } else if (l.trim() === '*** End of File') {
          // Marker only; hunks are matched by content.
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (!hunk) {
            hunk = { lines: [] };
            op.hunks.push(hunk);
          }
          hunk.lines.push(l === '' ? ' ' : l);
        } else {
          throw new BeginPatchError(`Update File ${path}: unexpected line "${l.slice(0, 80)}"`);
        }
        i++;
      }
      // A trailing blank line before the next header is formatting, not a context line.
      for (const h of op.hunks) while (h.lines.length && h.lines.at(-1) === ' ') h.lines.pop();
      ops.push(op);
    } else if (line.trim() === '') {
      i++;
    } else {
      throw new BeginPatchError(`Unexpected line "${line.slice(0, 80)}"`);
    }
  }
  throw new BeginPatchError('Missing "*** End Patch"');
}

/** Finds `block` in `lines` at or after `from`: exact, then ignoring trailing, then all surrounding whitespace. */
function locate(lines: string[], block: string[], from: number): number {
  const norms = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()];
  for (const n of norms) {
    for (let start = from; start + block.length <= lines.length; start++) {
      if (block.every((b, k) => n(lines[start + k]!) === n(b))) return start;
    }
  }
  return -1;
}

function applyHunks(path: string, before: string, hunks: Hunk[]): string {
  const trailingNewline = before.endsWith('\n');
  const lines = (trailingNewline ? before.slice(0, -1) : before).split('\n');
  let cursor = 0;
  for (const [n, h] of hunks.entries()) {
    const oldBlock = h.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1));
    const newBlock = h.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
    let from = cursor;
    if (h.anchor) {
      const a = lines.findIndex((l, k) => k >= cursor && l.includes(h.anchor!.trim()));
      if (a >= 0) from = a;
    }
    let at: number;
    if (oldBlock.length === 0) {
      // Pure insertion: after the anchor when given, otherwise at the end of the file.
      at = h.anchor && from > cursor - 1 && lines[from]?.includes(h.anchor.trim()) ? from + 1 : lines.length;
    } else {
      at = locate(lines, oldBlock, from);
      if (at < 0 && from !== cursor) at = locate(lines, oldBlock, cursor);
      if (at < 0) {
        throw new BeginPatchError(`${path}: hunk ${n + 1} does not match the current file. Re-read the file and copy the context lines exactly.`);
      }
    }
    lines.splice(at, oldBlock.length, ...newBlock);
    cursor = at + newBlock.length;
  }
  return lines.join('\n') + (trailingNewline || before === '' ? '\n' : '');
}

/** Converts a "*** Begin Patch" envelope into a unified diff against the current files. */
export async function beginPatchToUnified(text: string, read: (path: string) => Promise<string | null>): Promise<string> {
  const ops = parse(text);
  if (ops.length === 0) throw new BeginPatchError('The patch contains no file operations');
  const parts: string[] = [];
  for (const op of ops) {
    const p = normalizeRepoPath(op.path);
    if (op.kind === 'add') {
      if ((await read(p)) !== null) throw new BeginPatchError(`${p} already exists (use "*** Update File")`);
      parts.push(filePatch(p, null, op.lines.join('\n') + '\n'));
    } else if (op.kind === 'delete') {
      const before = await read(p);
      if (before === null) throw new BeginPatchError(`${p} does not exist`);
      parts.push(filePatch(p, before, null));
    } else {
      const before = await read(p);
      if (before === null) throw new BeginPatchError(`${p} does not exist (use "*** Add File")`);
      const after = applyHunks(p, before, op.hunks);
      if (op.moveTo) {
        const q = normalizeRepoPath(op.moveTo);
        if ((await read(q)) !== null) throw new BeginPatchError(`${q} already exists`);
        parts.push(filePatch(p, before, null), filePatch(q, null, after));
      } else if (after !== before) {
        parts.push(filePatch(p, before, after));
      }
    }
  }
  return parts.join('');
}
