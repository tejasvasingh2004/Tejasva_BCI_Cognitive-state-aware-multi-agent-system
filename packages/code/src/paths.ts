import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

/** Thrown when a path would escape the workspace or touch protected locations. */
export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

/** Directories the agent may never read or write (VCS internals, dependency caches). */
const DENIED_SEGMENTS = new Set(['.git']);

/** Normalises a repository-relative path (forward slashes, no leading ./). */
export function normalizeRepoPath(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!cleaned || cleaned === '.') return '';
  if (cleaned.includes('\0')) throw new PathPolicyError('Invalid path');
  if (path.posix.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new PathPolicyError(`Absolute paths are not allowed: ${p}`);
  }
  const normalized = path.posix.normalize(cleaned);
  if (normalized === '..' || normalized.startsWith('../')) throw new PathPolicyError(`Path escapes the repository: ${p}`);
  if (normalized.split('/').some((seg) => DENIED_SEGMENTS.has(seg))) {
    throw new PathPolicyError(`Access to ${p} is not allowed`);
  }
  return normalized;
}

/**
 * Resolves a repository-relative path to an absolute path inside `root`, following symlinks of
 * existing ancestors so a link cannot point outside the workspace.
 */
export async function resolveInside(root: string, repoPath: string): Promise<string> {
  const rel = normalizeRepoPath(repoPath);
  const rootReal = await realpath(root);
  const target = path.resolve(rootReal, ...rel.split('/').filter(Boolean));
  // Walk up to the deepest existing ancestor and check its real location.
  let probe = target;
  while (true) {
    try {
      await lstat(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const probeReal = await realpath(probe).catch(() => probe);
  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + path.sep);
  if (!inside(probeReal) || !inside(target)) throw new PathPolicyError(`Path escapes the repository: ${repoPath}`);
  return target;
}
