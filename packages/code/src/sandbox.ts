import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type SandboxLimits = {
  cpus: number;
  memoryMb: number;
  pids: number;
  timeoutMs: number;
  /** Bytes of combined stdout/stderr kept for the result (streamed output is not limited). */
  maxOutputBytes: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  cpus: 2,
  memoryMb: 2048,
  pids: 512,
  timeoutMs: 10 * 60_000,
  maxOutputBytes: 256 * 1024,
};

export type SandboxRequest = {
  /** Absolute host path of the repository checkout (mounted read-write at /workspace). */
  workspacePath: string;
  /**
   * Host directory for tool caches (npm/pnpm/pip/go/cargo), mounted at /cache and used as HOME so
   * dependencies installed by one command are available to the next. Never inside the repository.
   */
  cachePath?: string;
  /** Shell command line, already approved by the command policy. */
  command: string;
  image: string;
  /** Network is off unless the policy allowed it (dependency installs). */
  network: 'none' | 'bridge';
  limits?: Partial<SandboxLimits>;
  /** Non-secret environment variables only. */
  env?: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
};

export type SandboxResult = {
  exitCode: number;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
};

export class SandboxUnavailableError extends Error {
  constructor(message = 'The command sandbox (Docker) is not available') {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

export interface Sandbox {
  available(): Promise<boolean>;
  run(req: SandboxRequest): Promise<SandboxResult>;
}

export type DockerSandboxOptions = {
  /** Docker CLI binary. */
  docker?: string;
  /**
   * OCI runtime for every sandbox container: `runsc` (gVisor, a user-space kernel between the
   * command and the host kernel), `kata-fc` / `kata-qemu` (Kata Containers microVMs on Firecracker or
   * QEMU). Unset = Docker's default (runc). When set, the sandbox refuses to run without it.
   */
  runtime?: string;
  /** Runs a Docker CLI probe (injectable for tests). */
  exec?: (args: string[]) => Promise<{ code: number; stdout: string }>;
};

export type SandboxIsolation = { runtime: string; kind: 'container' | 'user-space kernel' | 'microVM'; available: boolean; reason?: string };

const isolationKind = (runtime: string): SandboxIsolation['kind'] =>
  runtime === 'runsc' || runtime.startsWith('runsc-') ? 'user-space kernel' : runtime.startsWith('kata') || runtime.includes('firecracker') ? 'microVM' : 'container';

const execDocker =
  (docker: string) =>
  (args: string[]): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      const child = spawn(docker, args, { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
      child.on('error', () => resolve({ code: -1, stdout: '' }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
      setTimeout(() => {
        child.kill();
        resolve({ code: -1, stdout });
      }, 10_000);
    });

const SAFE_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BLOCKED_ENV = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH)/i;

/**
 * Runs commands in a throwaway Docker container: only the repository is mounted, the root
 * filesystem is read-only, capabilities are dropped, privilege escalation is blocked, network is
 * off by default and CPU / memory / process count / wall time are bounded. Nothing from the host
 * environment is inherited, so server secrets can never reach agent commands.
 */
export class DockerSandbox implements Sandbox {
  private probe?: Promise<SandboxIsolation>;
  private readonly docker: string;
  private readonly runtime?: string;
  private readonly exec: (args: string[]) => Promise<{ code: number; stdout: string }>;

  constructor(opts: string | DockerSandboxOptions = {}) {
    const o = typeof opts === 'string' ? { docker: opts } : opts;
    this.docker = o.docker ?? 'docker';
    if (o.runtime && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(o.runtime)) throw new Error(`Invalid sandbox runtime "${o.runtime}"`);
    this.runtime = o.runtime || undefined;
    this.exec = o.exec ?? execDocker(this.docker);
  }

  /**
   * Docker reachable, and — when a runtime is configured — registered with the daemon. The probe
   * is cached while healthy and repeated after a failure.
   */
  isolation(): Promise<SandboxIsolation> {
    this.probe ??= (async (): Promise<SandboxIsolation> => {
      const runtime = this.runtime ?? 'runc';
      const kind = isolationKind(runtime);
      const info = await this.exec(['info', '--format', '{{json .Runtimes}}']);
      if (info.code !== 0) return { runtime, kind, available: false, reason: 'The command sandbox (Docker) is not available' };
      if (!this.runtime) return { runtime, kind, available: true };
      let runtimes: Record<string, unknown> = {};
      try {
        runtimes = JSON.parse(info.stdout.trim() || '{}') as Record<string, unknown>;
      } catch {
        // Unparseable: treated as not registered.
      }
      return this.runtime in runtimes
        ? { runtime, kind, available: true }
        : {
            runtime,
            kind,
            available: false,
            reason: `The sandbox runtime "${this.runtime}" is not registered with Docker (install it, e.g. gVisor's runsc, or unset SANDBOX_RUNTIME); commands are not run without it`,
          };
    })();
    void this.probe.then((p) => {
      if (!p.available) this.probe = undefined;
    });
    return this.probe;
  }

  async available(): Promise<boolean> {
    return (await this.isolation()).available;
  }

  /** The `docker run` arguments for a request (pure; exported for tests). */
  runArgs(req: SandboxRequest, name: string, limits: SandboxLimits, envArgs: string[]): string[] {
    return [
      'run',
      '--rm',
      '--name',
      name,
      ...(this.runtime ? ['--runtime', this.runtime] : []),
      '--network',
      req.network,
      '--cpus',
      String(limits.cpus),
      '--memory',
      `${limits.memoryMb}m`,
      '--memory-swap',
      `${limits.memoryMb}m`,
      '--pids-limit',
      String(limits.pids),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,size=512m',
      '-v',
      `${req.workspacePath}:/workspace`,
      ...(req.cachePath ? ['-v', `${req.cachePath}:/cache`] : []),
      '-w',
      '/workspace',
      ...envArgs,
      req.image,
      'sh',
      '-c',
      // Tools installed into the user caches (pip --user, npm/go/cargo) are callable by name.
      `export PATH="$PYTHONUSERBASE/bin:$HOME/go/bin:$CARGO_HOME/bin:$PATH"; ${req.command}`,
    ];
  }

  async run(req: SandboxRequest): Promise<SandboxResult> {
    const isolation = await this.isolation();
    if (!isolation.available) throw new SandboxUnavailableError(isolation.reason);
    const limits = { ...DEFAULT_SANDBOX_LIMITS, ...req.limits };
    const name = `nf-sbx-${randomUUID().slice(0, 12)}`;
    const home = req.cachePath ? '/cache' : '/tmp';
    const env: Record<string, string> = {
      CI: 'true',
      HOME: home,
      npm_config_cache: `${home}/npm`,
      COREPACK_HOME: `${home}/corepack`,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      PIP_CACHE_DIR: `${home}/pip`,
      PYTHONUSERBASE: `${home}/python`,
      // Interpreter/test caches must not end up in the repository (and in commits).
      PYTHONDONTWRITEBYTECODE: '1',
      PYTEST_ADDOPTS: '-p no:cacheprovider',
      GOPATH: `${home}/go`,
      GOCACHE: `${home}/go-build`,
      CARGO_HOME: `${home}/cargo`,
      ...req.env,
    };
    const envArgs = Object.entries(env)
      .filter(([k]) => SAFE_ENV.test(k) && !BLOCKED_ENV.test(k))
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    const args = this.runArgs(req, name, limits, envArgs);

    const started = Date.now();
    return new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(this.docker, args, { windowsHide: true });
      let output = '';
      let truncated = false;
      let timedOut = false;
      let cancelled = false;
      const kill = () => spawn(this.docker, ['kill', name], { windowsHide: true }).on('error', () => {});

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, limits.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const collect = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
        const text = buf.toString('utf8');
        req.onOutput?.(text, stream);
        if (output.length < limits.maxOutputBytes) {
          output += text;
          if (output.length > limits.maxOutputBytes) {
            output = output.slice(0, limits.maxOutputBytes);
            truncated = true;
          }
        } else {
          truncated = true;
        }
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new SandboxUnavailableError(`Could not start the sandbox: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode: timedOut || cancelled ? 124 : (code ?? 1),
          output,
          truncated,
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
        });
      });
    });
  }
}
