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

const SAFE_ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const BLOCKED_ENV = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH)/;

/**
 * Runs commands in a throwaway Docker container: only the repository is mounted, the root
 * filesystem is read-only, capabilities are dropped, privilege escalation is blocked, network is
 * off by default and CPU / memory / process count / wall time are bounded. Nothing from the host
 * environment is inherited, so server secrets can never reach agent commands.
 */
export class DockerSandbox implements Sandbox {
  private availability?: Promise<boolean>;

  constructor(private readonly docker = 'docker') {}

  available(): Promise<boolean> {
    this.availability ??= new Promise((resolve) => {
      const child = spawn(this.docker, ['info', '--format', '{{.ServerVersion}}'], { windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      setTimeout(() => {
        child.kill();
        resolve(false);
      }, 10_000);
    });
    // Re-probe next time if Docker was down.
    void this.availability.then((ok) => {
      if (!ok) this.availability = undefined;
    });
    return this.availability;
  }

  async run(req: SandboxRequest): Promise<SandboxResult> {
    if (!(await this.available())) throw new SandboxUnavailableError();
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
      GOPATH: `${home}/go`,
      GOCACHE: `${home}/go-build`,
      CARGO_HOME: `${home}/cargo`,
      ...req.env,
    };
    const envArgs = Object.entries(env)
      .filter(([k]) => SAFE_ENV.test(k) && !BLOCKED_ENV.test(k))
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    const args = [
      'run',
      '--rm',
      '--name',
      name,
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
      req.command,
    ];

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
