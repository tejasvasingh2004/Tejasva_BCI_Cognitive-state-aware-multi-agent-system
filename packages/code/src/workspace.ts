import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectProject, type ProjectProfile } from './detect';
import { Git, type GitStatusEntry } from './git';
import { normalizeRepoPath, PathPolicyError, resolveInside } from './paths';
import { buildRepoMap, INSTRUCTIONS_PATH, renderRepoMap, type RepoMap } from './repo-index';

export const FILE_LIMITS = {
  /** Largest file the editor or agent may open. */
  maxReadBytes: 1024 * 1024,
  /** Largest file the agent may write in one operation. */
  maxWriteBytes: 1024 * 1024,
  /** Upper bound on files listed in a tree. */
  maxTreeFiles: 20_000,
};

export class FileTooLargeError extends Error {
  constructor(p: string, size: number) {
    super(`${p} is too large (${Math.round(size / 1024)} KB)`);
    this.name = 'FileTooLargeError';
  }
}

export type TreeEntry = { path: string; status?: GitStatusEntry['kind'] };

export type ReadResult = { path: string; content: string; size: number; binary: false } | { path: string; size: number; binary: true };

/**
 * A repository checkout owned by one code workspace. Every path is confined to the checkout
 * (no `..`, no absolute paths, no `.git`, no symlink escapes).
 */
export class RepoCheckout {
  readonly git: Git;
  private profileCache?: { head: string; profile: ProjectProfile; map: RepoMap };

  constructor(
    readonly root: string,
    readonly cacheDir: string,
    author?: { name: string; email: string },
  ) {
    this.git = new Git(root, { author });
  }

  /** Lays out `<base>/<id>/repo` (checkout) and `<base>/<id>/cache` (sandbox tool caches). */
  static paths(baseDir: string, codeWorkspaceId: string) {
    const dir = path.join(baseDir, codeWorkspaceId);
    return { dir, root: path.join(dir, 'repo'), cacheDir: path.join(dir, 'cache') };
  }

  async exists(): Promise<boolean> {
    return stat(path.join(this.root, '.git')).then(
      () => true,
      () => false,
    );
  }

  async tree(): Promise<{ files: TreeEntry[]; truncated: boolean }> {
    const [files, status] = await Promise.all([this.git.lsFiles(), this.git.status()]);
    const byPath = new Map(status.map((s) => [s.path, s.kind]));
    // Deleted files are no longer on disk but should remain visible as changes.
    for (const s of status) if (s.kind === 'deleted' && !files.includes(s.path)) files.push(s.path);
    const sorted = [...new Set(files)].sort();
    return {
      files: sorted.slice(0, FILE_LIMITS.maxTreeFiles).map((p) => ({ path: p, ...(byPath.get(p) ? { status: byPath.get(p) } : {}) })),
      truncated: sorted.length > FILE_LIMITS.maxTreeFiles,
    };
  }

  async read(repoPath: string): Promise<ReadResult> {
    const p = normalizeRepoPath(repoPath);
    const abs = await resolveInside(this.root, p);
    const info = await stat(abs);
    if (!info.isFile()) throw new PathPolicyError(`${p} is not a file`);
    if (info.size > FILE_LIMITS.maxReadBytes) throw new FileTooLargeError(p, info.size);
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { path: p, size: info.size, binary: true };
    return { path: p, content: buf.toString('utf8'), size: info.size, binary: false };
  }

  /** Reads text or returns null when the file does not exist. */
  async readText(repoPath: string): Promise<string | null> {
    try {
      const r = await this.read(repoPath);
      return r.binary ? null : r.content;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(repoPath: string, content: string): Promise<void> {
    const p = normalizeRepoPath(repoPath);
    if (Buffer.byteLength(content) > FILE_LIMITS.maxWriteBytes) throw new FileTooLargeError(p, Buffer.byteLength(content));
    const abs = await resolveInside(this.root, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  async remove(repoPath: string): Promise<void> {
    const abs = await resolveInside(this.root, repoPath);
    await rm(abs);
  }

  async move(from: string, to: string): Promise<void> {
    const a = await resolveInside(this.root, from);
    const b = await resolveInside(this.root, to);
    await mkdir(path.dirname(b), { recursive: true });
    await rename(a, b);
  }

  /** Project profile + repository map, cached per HEAD commit. */
  async understand(): Promise<{ profile: ProjectProfile; map: RepoMap; head: string }> {
    const head = await this.git.head().catch(() => 'unborn');
    if (this.profileCache?.head === head) return this.profileCache;
    const files = await this.git.lsFiles();
    const profile = await detectProject(files, (f) => this.readText(f));
    const instructions = files.includes(INSTRUCTIONS_PATH) ? await this.readText(INSTRUCTIONS_PATH) : null;
    const map = buildRepoMap(files, profile, instructions);
    this.profileCache = { head, profile, map };
    return this.profileCache;
  }

  async summary(meta: { repository: string; branch: string }): Promise<string> {
    const { profile, map, head } = await this.understand();
    return renderRepoMap(map, profile, { ...meta, commit: head });
  }
}
