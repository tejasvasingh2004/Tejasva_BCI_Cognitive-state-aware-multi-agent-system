export type ProjectCommands = {
  install?: string;
  test?: string;
  lint?: string;
  build?: string;
};

export type ProjectProfile = {
  kind: 'node' | 'python' | 'go' | 'rust' | 'unknown';
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** Sandbox image used for commands. */
  image: string;
  commands: ProjectCommands;
  manifests: string[];
  dependencies: Array<{ name: string; version: string; dev: boolean; manifest: string }>;
};

export const SANDBOX_IMAGES = {
  node: 'node:22-bookworm-slim',
  python: 'python:3.12-slim',
  go: 'golang:1.23-bookworm',
  rust: 'rust:1-slim-bookworm',
  unknown: 'node:22-bookworm-slim',
} as const;

const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml'];

/**
 * Infers the project type, sandbox image and test/lint/build commands from repository files.
 * `read` returns a file's text (or null). Only root-level manifests are considered.
 */
export async function detectProject(files: string[], read: (p: string) => Promise<string | null>): Promise<ProjectProfile> {
  const has = (f: string) => files.includes(f);
  const manifests = MANIFESTS.filter(has);
  const dependencies: ProjectProfile['dependencies'] = [];

  if (has('package.json')) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse((await read('package.json')) ?? '{}');
    } catch {
      /* invalid package.json: keep defaults */
    }
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) dependencies.push({ name, version, dev: false, manifest: 'package.json' });
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) dependencies.push({ name, version, dev: true, manifest: 'package.json' });
    // pnpm is run through corepack so no global install is needed in the read-only sandbox image.
    const runner = pm === 'pnpm' ? 'corepack pnpm' : pm === 'yarn' ? 'corepack yarn' : pm;
    const scripts = pkg.scripts ?? {};
    const run = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${runner} run ${s}`);
    return {
      kind: 'node',
      packageManager: pm,
      image: SANDBOX_IMAGES.node,
      manifests,
      dependencies,
      commands: {
        install:
          pm === 'pnpm'
            ? 'corepack pnpm install --frozen-lockfile'
            : pm === 'yarn'
              ? 'corepack yarn install --frozen-lockfile'
              : pm === 'bun'
                ? 'bun install'
                : has('package-lock.json')
                  ? 'npm ci'
                  : 'npm install',
        ...(scripts.test ? { test: pm === 'npm' ? 'npm test' : `${runner} test` } : {}),
        ...(scripts.lint ? { lint: run('lint') } : scripts.typecheck ? { lint: run('typecheck') } : {}),
        ...(scripts.build ? { build: run('build') } : {}),
      },
    };
  }

  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    const req = (await read('requirements.txt')) ?? '';
    for (const line of req.split('\n')) {
      const m = /^([A-Za-z0-9_.\-[\]]+)\s*([<>=!~].*)?$/.exec(line.trim());
      if (m && !line.trim().startsWith('#')) dependencies.push({ name: m[1]!, version: (m[2] ?? '*').trim(), dev: false, manifest: 'requirements.txt' });
    }
    const pyproject = (await read('pyproject.toml')) ?? '';
    const usesRuff = /\[tool\.ruff/.test(pyproject) || has('ruff.toml');
    return {
      kind: 'python',
      image: SANDBOX_IMAGES.python,
      manifests,
      dependencies,
      commands: {
        install: has('requirements.txt') ? 'pip install --user -r requirements.txt' : 'pip install --user -e .',
        test: 'python -m pytest -q',
        ...(usesRuff ? { lint: 'ruff check .' } : {}),
      },
    };
  }

  if (has('go.mod')) {
    const mod = (await read('go.mod')) ?? '';
    for (const m of mod.matchAll(/^\s*([\w.\-/]+)\s+(v[\w.\-+]+)/gm)) dependencies.push({ name: m[1]!, version: m[2]!, dev: false, manifest: 'go.mod' });
    return {
      kind: 'go',
      image: SANDBOX_IMAGES.go,
      manifests,
      dependencies,
      commands: { install: 'go mod download', test: 'go test ./...', lint: 'go vet ./...', build: 'go build ./...' },
    };
  }

  if (has('Cargo.toml')) {
    return {
      kind: 'rust',
      image: SANDBOX_IMAGES.rust,
      manifests,
      dependencies,
      commands: { install: 'cargo fetch', test: 'cargo test', lint: 'cargo clippy', build: 'cargo build' },
    };
  }

  return { kind: 'unknown', image: SANDBOX_IMAGES.unknown, manifests, dependencies, commands: {} };
}

/** Images a workspace may choose in Workspace Settings (curated; arbitrary images are not allowed). */
export const SANDBOX_IMAGE_CHOICES: string[] = [...new Set(Object.values(SANDBOX_IMAGES))];
