import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_LIMITS, DockerSandbox, SandboxUnavailableError } from '../src';

const probe = (runtimes: Record<string, unknown> | null) => async (args: string[]) => {
  expect(args.slice(0, 2)).toEqual(['info', '--format']);
  return runtimes ? { code: 0, stdout: JSON.stringify(runtimes) } : { code: 1, stdout: '' };
};
const req = { workspacePath: '/w', command: 'npm test', image: 'node:22-bookworm-slim', network: 'none' as const };

describe('sandbox isolation runtime', () => {
  it('runs every container under the configured runtime (gVisor, Kata microVMs) with the same hardening', async () => {
    const gvisor = new DockerSandbox({ runtime: 'runsc', exec: probe({ runc: {}, runsc: { path: '/usr/bin/runsc' } }) });
    expect(await gvisor.isolation()).toEqual({ runtime: 'runsc', kind: 'user-space kernel', available: true });
    const args = gvisor.runArgs(req, 'nf-sbx-1', DEFAULT_SANDBOX_LIMITS, []);
    expect(args.slice(0, 6)).toEqual(['run', '--rm', '--name', 'nf-sbx-1', '--runtime', 'runsc']);
    for (const flag of ['--read-only', 'no-new-privileges', 'ALL']) expect(args).toContain(flag);
    expect(args[args.indexOf('--network') + 1]).toBe('none');

    const kata = new DockerSandbox({ runtime: 'kata-fc', exec: probe({ runc: {}, 'kata-fc': {} }) });
    expect(await kata.isolation()).toMatchObject({ runtime: 'kata-fc', kind: 'microVM', available: true });

    const plain = new DockerSandbox({ exec: probe({ runc: {} }) });
    expect(await plain.isolation()).toEqual({ runtime: 'runc', kind: 'container', available: true });
    expect(plain.runArgs(req, 'n', DEFAULT_SANDBOX_LIMITS, [])).not.toContain('--runtime');
  });

  it('fails closed: a configured runtime that Docker does not have means no commands run', async () => {
    const missing = new DockerSandbox({ runtime: 'runsc', exec: probe({ runc: {} }) });
    const iso = await missing.isolation();
    expect(iso).toMatchObject({ available: false });
    expect(iso.reason).toMatch(/runsc" is not registered with Docker/);
    expect(await missing.available()).toBe(false);
    await expect(missing.run(req)).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(missing.run(req)).rejects.toThrow(/not registered/);

    const down = new DockerSandbox({ exec: probe(null) });
    expect(await down.available()).toBe(false);
    expect(() => new DockerSandbox({ runtime: 'runsc; rm -rf /' })).toThrow(/Invalid sandbox runtime/);
  });
});
