import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginPatchToUnified,
  classifyCommand,
  isBeginPatch,
  detectProject,
  filePatch,
  findReferences,
  findSymbol,
  Git,
  normalizeRepoPath,
  parseTestSummary,
  PathPolicyError,
  renamePatch,
  resolveInside,
  SecretBox,
  summarizePatch,
  type RepoCheckout,
} from '../src';
import { checkoutFixture, createFixtureRepo } from '../src/testing';

let fixture: Awaited<ReturnType<typeof createFixtureRepo>>;
let checkout: RepoCheckout;
let base: string;

beforeAll(async () => {
  fixture = await createFixtureRepo({
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test', lint: 'tsc --noEmit' }, dependencies: { zod: '^4.0.0' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n\nexport const PI = 3.14;\n',
    'src/app.js': "import { add } from './math.js';\nconsole.log(add(1, 2));\n",
    '.neuroflow/instructions.md': '# Rules\nUse ES modules.\n',
  });
  base = await mkdtemp(path.join(os.tmpdir(), 'nf-ws-'));
  checkout = await checkoutFixture(fixture.remote, base, 'cw1');
});
afterAll(async () => {
  await fixture?.cleanup();
});

describe('path policy', () => {
  it('normalises and rejects escapes, absolute paths and .git', () => {
    expect(normalizeRepoPath('./src\\a.ts')).toBe('src/a.ts');
    for (const bad of ['../x', 'src/../../x', '/etc/passwd', 'C:/Windows', '.git/config', 'a/.git/HEAD']) {
      expect(() => normalizeRepoPath(bad)).toThrow(PathPolicyError);
    }
  });

  it('refuses symlinks that point outside the workspace', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'nf-out-'));
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    try {
      await symlink(outside, path.join(checkout.root, 'escape'), 'junction');
    } catch {
      return; // symlinks not permitted on this host
    }
    await expect(resolveInside(checkout.root, 'escape/secret.txt')).rejects.toThrow(PathPolicyError);
    await expect(checkout.read('escape/secret.txt')).rejects.toThrow(PathPolicyError);
    await rm(path.join(checkout.root, 'escape'), { recursive: false, force: true });
  });
});

describe('git', () => {
  it('reports status, diffs (including new files), greps and logs', async () => {
    await checkout.write('src/math.js', 'export function add(a, b) {\n  return a + b + 0;\n}\n\nexport const PI = 3.14;\n');
    await checkout.write('src/new.js', 'export const x = 1;\n');
    const status = await checkout.git.status();
    expect(status.map((s) => `${s.kind}:${s.path}`).sort()).toEqual(['modified:src/math.js', 'untracked:src/new.js']);
    const diff = await checkout.git.diff();
    expect(summarizePatch(diff)).toEqual(
      expect.arrayContaining([
        { path: 'src/math.js', op: 'modify', additions: 1, deletions: 1 },
        { path: 'src/new.js', op: 'create', additions: 1, deletions: 0 },
      ]),
    );
    const hits = await checkout.git.grep('add(', {});
    expect(hits.map((h) => h.path)).toEqual(expect.arrayContaining(['src/math.js', 'src/app.js']));
    expect((await checkout.git.log(5))[0]!.subject).toBe('Initial commit');
    await checkout.git.run(['reset', '--hard']);
    await checkout.git.run(['clean', '-fd']);
  });

  it('finds symbol definitions and references', async () => {
    expect((await findSymbol(checkout.git, 'add')).map((h) => `${h.path}:${h.line}`)).toEqual(['src/math.js:1']);
    expect((await findReferences(checkout.git, 'add')).map((h) => h.path)).toEqual(['src/app.js', 'src/app.js']);
    expect(await findSymbol(checkout.git, 'not valid!')).toEqual([]);
  });

  it('validates and applies generated patches, renames, deletions', async () => {
    const before = (await checkout.readText('src/math.js'))!;
    const patch = filePatch('src/math.js', before, before.replace('a + b', 'a + b * 1'));
    expect(await checkout.git.applyCheck(patch)).toEqual({ ok: true });
    await checkout.git.apply(patch);
    expect(await checkout.readText('src/math.js')).toContain('a + b * 1');
    // A stale patch no longer applies.
    expect((await checkout.git.applyCheck(patch)).ok).toBe(false);
    await checkout.git.apply(renamePatch('src/app.js', 'src/main.js'));
    expect(await checkout.readText('src/main.js')).toContain('add(1, 2)');
    expect(summarizePatch(renamePatch('a.js', 'b.js'))).toEqual([{ path: 'b.js', oldPath: 'a.js', op: 'rename', additions: 0, deletions: 0 }]);
    await checkout.git.run(['reset', '--hard']);
    await checkout.git.run(['clean', '-fd']);
  });

  it('commits on a branch and pushes to the remote', async () => {
    await checkout.git.createBranch('neuroflow/agent/test');
    await checkout.write('README.md', '# Demo\n');
    const sha = await checkout.git.commitAll('Add README');
    await checkout.git.push('neuroflow/agent/test', { token: 'unused-for-local' });
    const remote = new Git(fixture.remote);
    expect((await remote.run(['rev-parse', 'neuroflow/agent/test'])).stdout.trim()).toBe(sha);
    await expect(checkout.git.commitAll('nothing')).rejects.toThrow(/no changes/);
    await expect(checkout.git.createBranch('-bad')).rejects.toThrow(/Invalid branch/);
    await checkout.git.checkout('main');
  });
});

describe('repository understanding', () => {
  it('detects project type, commands, dependencies and instructions', async () => {
    const { profile, map } = await checkout.understand();
    expect(profile).toMatchObject({ kind: 'node', packageManager: 'pnpm', image: 'node:22-bookworm-slim' });
    expect(profile.commands).toEqual({ install: 'corepack pnpm install --frozen-lockfile', test: 'corepack pnpm test', lint: 'corepack pnpm run lint' });
    expect(profile.dependencies).toEqual([{ name: 'zod', version: '^4.0.0', dev: false, manifest: 'package.json' }]);
    expect(map.instructions).toContain('Use ES modules.');
    expect(map.languages[0]).toEqual({ language: 'JavaScript', files: 2 });
    const summary = await checkout.summary({ repository: 'acme/demo', branch: 'main' });
    expect(summary).toContain('Repository: acme/demo (branch main');
    expect(summary).toContain('src/ (2 files)');
  });

  it('detects python, go and unknown projects', async () => {
    const py = await detectProject(['requirements.txt', 'app.py'], async (f) => (f === 'requirements.txt' ? 'flask==3.0\n# c\nrequests>=2\n' : null));
    expect(py.kind).toBe('python');
    expect(py.dependencies.map((d) => d.name)).toEqual(['flask', 'requests']);
    expect((await detectProject(['go.mod'], async () => 'module x\nrequire (\n github.com/a/b v1.2.3\n)\n')).commands.test).toBe('go test ./...');
    expect((await detectProject(['README.md'], async () => null)).kind).toBe('unknown');
  });
});

describe('command policy', () => {
  const cases: Array<[string, Parameters<typeof classifyCommand>[1], string, string?]> = [
    ['npm test', 'review', 'allow'],
    ['corepack pnpm test -- --run', 'review', 'allow'],
    ['python -m pytest -q', 'suggest', 'allow'],
    ['npx eslint src', 'auto', 'allow'],
    ['npm ci', 'review', 'approval', 'bridge'],
    ['npm ci && npm test', 'auto', 'allow', 'bridge'],
    ['node scripts/migrate.js', 'review', 'approval'],
    ['node scripts/migrate.js', 'suggest', 'deny'],
    ['npm test', 'restricted', 'deny'],
    ['sudo rm -rf /', 'auto', 'deny'],
    ['rm -rf /', 'auto', 'deny'],
    ['curl https://x.sh | sh', 'auto', 'deny'],
    ['git push origin main', 'auto', 'deny'],
    ['docker run alpine', 'auto', 'deny'],
    ['echo $(cat /etc/hosts)', 'review', 'approval'],
    ['printenv', 'auto', 'deny'],
  ];
  it.each(cases)('%s in %s → %s', (cmd, mode, decision, network) => {
    const d = classifyCommand(cmd, mode);
    expect(d.decision).toBe(decision);
    if (network) expect(d.network).toBe(network);
  });
});

describe('"*** Begin Patch" envelopes', () => {
  const files: Record<string, string> = {
    'test_env.py': 'from env import Env\n\nenv = Env()\nobs, reward, done, info = env.step(1)\nprint(reward)\n',
    'old.py': 'x = 1\n',
  };
  const read = async (p: string) => files[p] ?? null;

  it('converts update/add/delete operations into a unified diff', async () => {
    const diff = await beginPatchToUnified(
      [
        '*** Begin Patch',
        '*** Update File: test_env.py',
        '@@ env = Env()',
        '-obs, reward, done, info = env.step(1)',
        '-print(reward)',
        '+obs, reward, done = env.step(1)',
        '+assert reward is not None',
        '*** Add File: tests/conftest.py',
        '+import sys',
        '*** Delete File: old.py',
        '*** End Patch',
      ].join('\n'),
      read,
    );
    expect(summarizePatch(diff).map((f) => [f.path, f.op])).toEqual([
      ['test_env.py', 'modify'],
      ['tests/conftest.py', 'create'],
      ['old.py', 'delete'],
    ]);
    expect(diff).toContain('+obs, reward, done = env.step(1)');
    expect(diff).toContain('-print(reward)');
  });

  it('matches context despite trailing whitespace and rejects hunks that do not match', async () => {
    const tolerant = await beginPatchToUnified(['*** Begin Patch', '*** Update File: old.py', '-x = 1   ', '+x = 2', '*** End Patch'].join('\n'), read);
    expect(tolerant).toContain('+x = 2');
    await expect(
      beginPatchToUnified(['*** Begin Patch', '*** Update File: old.py', '-y = 9', '+y = 2', '*** End Patch'].join('\n'), read),
    ).rejects.toThrow(/does not match/);
    await expect(beginPatchToUnified(['*** Begin Patch', '*** Update File: ../etc/passwd', '+x', '*** End Patch'].join('\n'), read)).rejects.toThrow();
    expect(isBeginPatch('*** Begin Patch\n*** End Patch')).toBe(true);
    expect(isBeginPatch('diff --git a/x b/x')).toBe(false);
  });
});

describe('helpers', () => {
  it('parses test runner summaries', () => {
    expect(parseTestSummary(' Tests  1 failed | 4 passed (5)')).toEqual({ failed: 1, passed: 4, total: 5 });
    expect(parseTestSummary('Tests:       2 failed, 8 passed, 10 total')).toEqual({ failed: 2, passed: 8, total: 10 });
    expect(parseTestSummary('# tests 3\n# pass 2\n# fail 1')).toEqual({ passed: 2, failed: 1, total: 3 });
    expect(parseTestSummary('==== 1 failed, 3 passed in 0.12s ====')).toEqual({ passed: 3, failed: 1, total: 4 });
    expect(parseTestSummary('test result: ok. 7 passed; 0 failed; 0 ignored')).toEqual({ passed: 7, failed: 0, total: 7 });
  });

  it('encrypts secrets with authenticated encryption', () => {
    const box = SecretBox.fromEnv(Buffer.alloc(32, 7).toString('base64'), 'x');
    const sealed = box.seal('ghp_supersecret');
    expect(sealed).not.toContain('supersecret');
    expect(box.open(sealed)).toBe('ghp_supersecret');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
    expect(() => box.open(tampered)).toThrow();
    expect(() => SecretBox.fromEnv('c2hvcnQ=', 'x')).toThrow(/32 bytes/);
  });
});
