import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'auth' | 'network' | 'invalid' | 'failed',
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Credentials for remote operations. Passed through the environment, never argv or .git/config. */
export type GitAuth = { token: string; username?: string };

export type GitStatusEntry = {
  path: string;
  /** Index/worktree status in porcelain v1 terms, e.g. " M", "A ", "??". */
  code: string;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  oldPath?: string;
};

export type GitCommit = { sha: string; author: string; date: string; subject: string };

const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Empty file used as the global git config, so a server's ~/.gitconfig (credential helpers,
 * hooks, aliases) never applies. (os.devNull is not readable as a config file by git on Windows.)
 */
const EMPTY_GLOBAL_CONFIG = path.join(os.tmpdir(), 'neuroflow-empty.gitconfig');
writeFileSync(EMPTY_GLOBAL_CONFIG, '', { flag: 'a' });

/**
 * Thin, safe wrapper over the git CLI. Arguments are passed as an array (no shell), prompts are
 * disabled and system/global configuration is ignored so a server's git setup cannot leak in.
 */
export class Git {
  constructor(
    readonly dir: string,
    private readonly opts: { timeoutMs?: number; author?: { name: string; email: string } } = {},
  ) {}

  async run(args: string[], options: { auth?: GitAuth; timeoutMs?: number; input?: string; allowFail?: boolean } = {}) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: process.env.HOME ?? os.tmpdir(),
      USERPROFILE: process.env.USERPROFILE,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: EMPTY_GLOBAL_CONFIG,
      GCM_INTERACTIVE: 'never',
      LC_ALL: 'C',
    };
    const config: Array<[string, string]> = [
      ['core.autocrlf', 'false'],
      ['core.quotepath', 'false'],
      ['credential.helper', ''],
    ];
    if (options.auth) {
      const basic = Buffer.from(`${options.auth.username ?? 'x-access-token'}:${options.auth.token}`).toString('base64');
      config.push(['http.extraHeader', `Authorization: Basic ${basic}`]);
    }
    if (this.opts.author) {
      config.push(['user.name', this.opts.author.name], ['user.email', this.opts.author.email]);
    }
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });

    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        { cwd: this.dir, env, timeout: options.timeoutMs ?? this.opts.timeoutMs ?? 120_000, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) ?? 1 : 0;
          if (err && !options.allowFail) {
            reject(classify(err, String(stderr), options.auth?.token));
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof code === 'number' ? code : 1 });
        },
      );
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    });
  }

  static async clone(url: string, dir: string, opts: { branch?: string; auth?: GitAuth; depth?: number } = {}) {
    await mkdir(path.dirname(dir), { recursive: true });
    const git = new Git(path.dirname(dir));
    const args = ['clone', '--no-tags', '--single-branch'];
    if (opts.branch) args.push('--branch', opts.branch);
    if (opts.depth) args.push('--depth', String(opts.depth));
    args.push('--', url, dir);
    await git.run(args, { auth: opts.auth, timeoutMs: 10 * 60_000 });
    return new Git(dir);
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  }

  async head(): Promise<string> {
    return (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async status(): Promise<GitStatusEntry[]> {
    const { stdout } = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = stdout.split('\0').filter(Boolean);
    const out: GitStatusEntry[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      let oldPath: string | undefined;
      if (code.includes('R')) oldPath = parts[++i];
      out.push({ path: file, code, kind: kindOf(code), ...(oldPath ? { oldPath } : {}) });
    }
    return out;
  }

  /** Unified diff of the working tree against HEAD (including untracked files), optionally per path. */
  async diff(paths: string[] = []): Promise<string> {
    // Intent-to-add makes untracked files show up in `git diff` without staging their content.
    const untracked = (await this.status()).filter((s) => s.kind === 'untracked').map((s) => s.path);
    const scoped = paths.length ? untracked.filter((u) => paths.includes(u)) : untracked;
    if (scoped.length) await this.run(['add', '--intent-to-add', '--', ...scoped]);
    const { stdout } = await this.run(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', ...paths]);
    return stdout;
  }

  async log(limit = 20, ref = 'HEAD'): Promise<GitCommit[]> {
    const { stdout } = await this.run(['log', `-n${Math.min(limit, 200)}`, '--format=%H%x1f%an%x1f%aI%x1f%s', ref, '--'], { allowFail: true });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha = '', author = '', date = '', subject = ''] = l.split('\x1f');
        return { sha, author, date, subject };
      });
  }

  async branches(): Promise<string[]> {
    const { stdout } = await this.run(['branch', '--format=%(refname:short)']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async createBranch(name: string, from = 'HEAD'): Promise<void> {
    assertBranchName(name);
    await this.run(['checkout', '-b', name, from]);
  }

  async checkout(name: string): Promise<void> {
    assertBranchName(name);
    await this.run(['checkout', name]);
  }

  async lsFiles(): Promise<string[]> {
    const { stdout } = await this.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return stdout.split('\0').filter(Boolean);
  }

  /** Content of a file at a revision (null when it does not exist there). */
  async show(ref: string, repoPath: string): Promise<string | null> {
    const res = await this.run(['show', `${ref}:${repoPath}`], { allowFail: true });
    return res.code === 0 ? res.stdout : null;
  }

  /** `git grep` with fixed strings or a regex; returns path:line:text hits. */
  async grep(pattern: string, opts: { regex?: boolean; ignoreCase?: boolean; paths?: string[]; max?: number } = {}) {
    const args = ['grep', '-n', '-I', '--no-color', '--untracked', '--full-name'];
    args.push(opts.regex ? '-E' : '-F');
    if (opts.ignoreCase) args.push('-i');
    args.push('-e', pattern, '--', ...(opts.paths ?? []));
    const { stdout } = await this.run(args, { allowFail: true });
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const l of stdout.split('\n')) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      if (m) hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) });
      if (hits.length >= (opts.max ?? 200)) break;
    }
    return hits;
  }

  /** Validates a unified diff against the working tree without applying it. */
  async applyCheck(patch: string): Promise<{ ok: boolean; error?: string }> {
    const file = await tempPatch(patch);
    try {
      const res = await this.run(['apply', '--check', '--whitespace=nowarn', '--recount', file], { allowFail: true });
      return res.code === 0 ? { ok: true } : { ok: false, error: res.stderr.trim().slice(0, 1000) };
    } finally {
      await rm(file, { force: true });
    }
  }

  async apply(patch: string): Promise<void> {
    const file = await tempPatch(patch);
    try {
      await this.run(['apply', '--whitespace=nowarn', '--recount', file]);
    } finally {
      await rm(file, { force: true });
    }
  }

  async commitAll(message: string): Promise<string> {
    await this.run(['add', '--all']);
    const staged = await this.run(['diff', '--cached', '--quiet'], { allowFail: true });
    if (staged.code === 0) throw new GitError('There are no changes to commit', 'conflict');
    await this.run(['commit', '--no-verify', '-m', message]);
    return this.head();
  }

  async push(branch: string, auth: GitAuth, remote = 'origin'): Promise<void> {
    assertBranchName(branch);
    await this.run(['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], { auth, timeoutMs: 5 * 60_000 });
  }

  async fetch(auth?: GitAuth, remote = 'origin'): Promise<void> {
    await this.run(['fetch', '--no-tags', remote], { auth, timeoutMs: 5 * 60_000 });
  }

  async remoteUrl(remote = 'origin'): Promise<string | null> {
    const res = await this.run(['remote', 'get-url', remote], { allowFail: true });
    return res.code === 0 ? res.stdout.trim() : null;
  }
}

/** Conservative branch-name validation (subset of git check-ref-format). */
export function assertBranchName(name: string) {
  if (!/^[A-Za-z0-9._\-/]{1,200}$/.test(name) || name.includes('..') || name.startsWith('-') || name.endsWith('/') || name.endsWith('.lock')) {
    throw new GitError(`Invalid branch name: ${name}`, 'invalid');
  }
}

function kindOf(code: string): GitStatusEntry['kind'] {
  if (code === '??') return 'untracked';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

function classify(err: unknown, stderr: string, token?: string): GitError {
  // Never surface credentials, even if git echoed them.
  const clean = token ? stderr.split(token).join('***') : stderr;
  const msg = clean.trim().split('\n').slice(-3).join(' ').slice(0, 500) || (err instanceof Error ? err.message : 'git failed');
  if (/authentication failed|could not read username|403|401|permission denied/i.test(clean)) return new GitError('Git authentication failed', 'auth', msg);
  if (/could not resolve host|unable to access|timed out|connection/i.test(clean)) return new GitError('Git could not reach the remote', 'network', msg);
  if (/not found|does not exist|did not match any|unknown revision|pathspec/i.test(clean)) return new GitError(msg, 'not_found', msg);
  if (/conflict|rejected|non-fast-forward|already exists/i.test(clean)) return new GitError(msg, 'conflict', msg);
  return new GitError(msg, 'failed', msg);
}

async function tempPatch(patch: string): Promise<string> {
  const file = path.join(os.tmpdir(), `nf-patch-${randomUUID()}.diff`);
  await writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8');
  return file;
}
