# Contributing to NeuroFlow

Thanks for your interest in NeuroFlow. This guide explains how to set up the project, how changes
are made, and what a pull request needs before it can be merged.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an issue with the bug report template: what you did, what you expected,
  what happened, and logs or screenshots (with secrets removed).
- **Suggest a feature** — open an issue with the feature request template. Explain the problem
  first; a solution is optional.
- **Improve the docs** — typos, unclear setup steps and missing explanations are all welcome.
- **Send a pull request** — for anything larger than a small fix, open an issue first so the
  approach can be agreed before you spend time on it.

Security vulnerabilities must **not** be reported in public issues; see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 22+, pnpm 9 (`corepack enable`), Docker, and a Groq API key or a local Ollama.

```bash
cp .env.example .env
pnpm install
pnpm infra:up      # PostgreSQL :5433, Redis :6380
pnpm dev           # API :8080 · worker · web :5173 · site :5180
```

The full guide is in [docs/SETUP.md](docs/SETUP.md). Before changing the runtime, read
[docs/architecture.md](docs/architecture.md) and [docs/system-design.md](docs/system-design.md);
the current state of the project is in [docs/STATUS.md](docs/STATUS.md).

## Project principles

These keep the codebase coherent; pull requests that break them will be asked to change.

1. **One runtime.** The Code Workspace is a specialization of the core runtime (runs, agents,
   models, tools, events, persistence) — never a second backend.
2. **Every tool call is validated and authorized.** Model-generated arguments go through the Tool
   Registry: schema validation → authorization → approval when consequential → execution →
   normalized result.
3. **No blind mutation.** Code changes are patches the user can review; the approval policy
   decides what may be applied.
4. **Commands run in the sandbox**, never on the API server, and never with server secrets.
5. **Models stay behind the Model Gateway.** The frontend never calls a provider directly.
6. **Real events only.** The UI shows progress the backend actually emitted.
7. **No secrets or hidden reasoning in logs, events or prompts.**

## Making a change

1. Fork the repository and create a branch from `master`:
   `git checkout -b feat/short-description` (or `fix/…`, `docs/…`).
2. Make focused changes. Match the surrounding code: naming, comment density and idioms.
3. Add or update tests for behaviour you change:
   - unit tests next to the code (`*.test.ts`),
   - integration tests in `apps/api/test/integration` for API, queue, Git or sandbox behaviour,
   - Playwright tests in `apps/web/e2e` for user-visible flows.
4. Database changes go in a new numbered migration in `infra/migrations` — never edit an existing
   one.
5. Update the documentation that your change affects, including [docs/STATUS.md](docs/STATUS.md)
   for user-visible features.
6. Run the checks locally:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test        # needs pnpm infra:up and Docker
   pnpm test:e2e    # for UI changes
   ```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(code-agent): plan review before the agent touches the repository
fix(api): accept partial command overrides in workspace settings
docs: deployment guide for the worker
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `ci`, `chore`. The scope is the
app or package (`api`, `worker`, `web`, `site`, `models`, `orchestrator`, `code`, …).

## Pull requests

- Fill in the pull request template: what changed, why, and how it was tested.
- Keep pull requests small and about one thing.
- CI must pass: typecheck, lint, unit, integration, end-to-end and builds.
- UI changes: include a screenshot or short recording.
- Never commit secrets, `.env` files, personal data or large generated files.

A maintainer reviews every pull request. Expect questions and requested changes; they are part of
keeping the project reliable.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
