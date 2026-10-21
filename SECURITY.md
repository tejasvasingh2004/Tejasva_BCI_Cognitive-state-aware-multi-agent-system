# Security Policy

NeuroFlow runs AI-generated code, stores repository credentials and talks to model providers, so
security reports are taken seriously.

## Supported versions

Security fixes are made on the latest `master` branch. Older commits and forks are not maintained.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private security advisory.

Include, as far as you can:

- the affected component (API, worker, sandbox, web app, site, a package),
- steps to reproduce or a proof of concept,
- the impact you expect (for example credential exposure or sandbox escape),
- any suggested fix.

You can expect an acknowledgement within a few days. Please give a reasonable time to fix the
issue before disclosing it publicly. Reporters are credited in the fix unless they prefer not to be.

## Scope

Of particular interest:

- escaping the command sandbox, or sandbox commands reaching host files, the network without
  approval, or server secrets;
- GitHub tokens or API keys reaching the browser, the model, logs or events;
- bypassing workspace authorization, tool authorization or approval policies;
- pushing to protected branches or merging pull requests;
- authentication, session or API key weaknesses;
- injection through tool arguments, file paths or repository content.

## Security model in brief

- Credentials are encrypted at rest (AES-256-GCM) and never sent to the browser or the model.
- Error tracking (optional, `SENTRY_DSN`) sends only the error type, message and stack trace with
  credentials redacted, plus route, stage and ids; never request bodies, prompts, model output or
  headers. `GET /status` exposes aggregate counts only.
- Every tool call is schema-validated, authorized and, when consequential, approved by the user.
- Agent commands run in throwaway Docker containers: no network by default, read-only system,
  dropped capabilities, CPU / memory / process / time limits, no inherited environment.
- The Code Agent commits only on `neuroflow/agent/*` branches, opens draft pull requests and never
  merges.

More detail: [docs/architecture.md](docs/architecture.md) and
[docs/decisions.md](docs/decisions.md).
