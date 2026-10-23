# Deployment

NeuroFlow has six deployable pieces. Two are static, two are Node processes, two are data services.

```text
apps/site    marketing site        static   → Vercel (or any CDN)
apps/web     product UI            static   → Vercel (or any CDN)
apps/api     Fastify API           Node     → Railway, a VM, or Docker
apps/worker  BullMQ worker         Node     → a VM with Docker (runs the sandbox)
PostgreSQL                         service  → Neon, or self-hosted
Redis                              service  → Upstash, or self-hosted
Models                             external → Groq API (and/or an OpenAI-compatible Qwen endpoint)
```

The API only enqueues work; the **worker must be running** or runs stay queued. The worker is the
only piece that needs a Docker daemon — the sandbox starts a throwaway container for every agent
command. Without Docker the agent can still read, edit, diff and commit, but test, lint, build and
terminal commands report the sandbox as unavailable.

## 1. Data services

- **PostgreSQL** — create a database (for example on Neon) and copy its connection string with
  `sslmode=require`. Migrations run automatically when the API starts.
- **Redis** — create a database (for example on Upstash) and copy the **TLS** URL (`rediss://…`).
  BullMQ polls Redis continuously; check that your plan's command quota is enough, or run Redis on
  the worker VM.

## 2. API

On Railway, connect the repository; `nixpacks.toml` builds with pnpm 9 on Node 22 and starts
`node apps/api/dist/main.js`. Environment:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` / `PORT` | `0.0.0.0` / the port the platform provides |
| `AUTH_MODE` | `production` (email/password accounts and API keys) |
| `SESSION_SECRET` | 32+ random characters |
| `SECRETS_KEY` | `openssl rand -base64 32` — encrypts stored GitHub credentials |
| `DATABASE_URL`, `REDIS_URL` | from step 1 |
| `CORS_ORIGINS` | the web app's URL |
| `PUBLIC_WEB_URL` | the web app's URL |
| `GROQ_API_KEY`, `GROQ_MODELS` | provider key and models (optional when every workspace brings its own key) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` | optional platform keys; without them these providers serve only workspaces that add their own key (`*_MODELS` to change the list) |
| `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `OPENROUTER_API_KEY` | optional platform keys for hosted open-weight models; workspaces can add their own instead |
| `KEK_PROVIDER` | `local` (default, derived from `SECRETS_KEY`), `aws-kms` (`AWS_KMS_KEY_ID`, `AWS_REGION`) `vault` (`VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_KEY`) or `gcp-kms` (`GCP_KMS_KEY_NAME` + `GOOGLE_APPLICATION_CREDENTIALS` or the metadata server); same on the worker. Then `pnpm keys:rewrap` |
| `WEBHOOK_ALLOW_PRIVATE` | leave `false` in production (webhooks only to public https URLs); same on the worker, which delivers them |
| `GATEWAY_FAST_PATH`, `MODEL_EQUIVALENT_FAILOVER`, `MODEL_ADAPTIVE_CONCURRENCY`, `MODEL_HEDGE_AFTER_MS` | latency and self-healing controls, all on by default except hedging ([GATEWAY.md](GATEWAY.md)) |
| `PLATFORM_MODEL_KEYS` | `disabled` on a public deployment: models run only with workspaces' own keys; same value on the worker |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | optional; users can connect with a token instead |

Create the first account after the API is up:
`pnpm user:create` (run with the same `DATABASE_URL`).

## 3. Web app and site

Create two Vercel projects from the repository:

| Project | Root directory | Environment |
| --- | --- | --- |
| Web app | `apps/web` | `VITE_API_URL` = the API URL |
| Site | `apps/site` | `VITE_APP_URL` = the web app URL |

Both include a `vercel.json` (SPA rewrites for the web app, clean URLs for the site).

## 4. Worker and sandbox on a VM

Any Linux VM with Docker works. Oracle Cloud's Always Free Ampere VM (up to 4 OCPU / 24 GB) is a
free option; a small Hetzner or DigitalOcean VM is a reliable paid one. The worker only makes
outbound connections, so no inbound ports are needed beyond SSH.

### Quick setup (one command)

On a fresh Ubuntu VM:

```bash
curl -fsSL https://raw.githubusercontent.com/tejasvasingh2004/Tejasva_BCI_Cognitive-state-aware-multi-agent-system/master/infra/scripts/setup-worker-vm.sh | bash
sudo nano /etc/neuroflow/worker.env      # fill in DATABASE_URL, REDIS_URL, GROQ_API_KEY, SECRETS_KEY, SESSION_SECRET
curl -fsSL https://raw.githubusercontent.com/tejasvasingh2004/Tejasva_BCI_Cognitive-state-aware-multi-agent-system/master/infra/scripts/setup-worker-vm.sh | bash
```

Add `INSTALL_GVISOR=1` before `bash` to also install gVisor, then set `SANDBOX_RUNTIME=runsc` in the env
file: agent commands then run behind a user-space kernel instead of directly on the host kernel.

The first run installs Docker and Node 22, pre-pulls the sandbox images and creates the env file;
the second builds the worker and starts it as the `neuroflow-worker` systemd service. Re-run it to
update. [`infra/scripts/setup-worker-vm.sh`](../infra/scripts/setup-worker-vm.sh) does exactly the
manual steps below.

### Install Docker and Node

```bash
sudo apt update && sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker
docker run --rm hello-world

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable && corepack prepare pnpm@9.15.4 --activate
```

### Pre-pull the sandbox images

```bash
docker pull node:22-bookworm-slim
docker pull python:3.12-slim
docker pull golang:1.23-bookworm
docker pull rust:1-slim-bookworm
```

### Build the worker

```bash
sudo mkdir -p /opt/neuroflow /var/lib/neuroflow/code
sudo chown -R "$USER":"$USER" /opt/neuroflow /var/lib/neuroflow
git clone https://github.com/tejasvasingh2004/Tejasva_BCI_Cognitive-state-aware-multi-agent-system.git /opt/neuroflow
cd /opt/neuroflow
pnpm install --frozen-lockfile
pnpm --filter @neuroflow/worker build
```

The worker runs directly on the host (not in a container), so the repository checkouts it mounts
into sandbox containers have the same paths on the host.

### Configure

`/etc/neuroflow/worker.env` (`chmod 600`, never committed):

```text
NODE_ENV=production
DATABASE_URL=postgresql://…?sslmode=require
REDIS_URL=rediss://…
GROQ_API_KEY=…
GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b
SECRETS_KEY=…        # the same value as the API
SESSION_SECRET=…     # the same value as the API
CODE_DATA_DIR=/var/lib/neuroflow/code
WORKER_QUEUES=runs,workspace,evals
LOG_LEVEL=info
```

`SECRETS_KEY` must match the API: the worker decrypts stored GitHub tokens to clone repositories and
workspaces' provider keys to run their models. Changing it makes stored keys unreadable, so rotate it
only with a migration plan.

### Run as a service

`/etc/systemd/system/neuroflow-worker.service`:

```ini
[Unit]
Description=NeuroFlow worker
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/opt/neuroflow/apps/worker
EnvironmentFile=/etc/neuroflow/worker.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now neuroflow-worker
journalctl -u neuroflow-worker -f      # expect "model gateway ready" and "worker started"
```

Start a Code Agent run that executes tests and check `docker ps -a --filter name=nf-sbx` to see
sandbox containers come and go.

### Update

```bash
cd /opt/neuroflow && git pull && pnpm install --frozen-lockfile \
  && pnpm --filter @neuroflow/worker build && sudo systemctl restart neuroflow-worker
```

## Monitoring and alerts

- **`GET /status`** (public, on the API) returns `200` when work can flow end to end and `503`
  otherwise: database or Redis unreachable, no live worker (workers refresh a heartbeat key every
  10 s), a queue whose oldest job has waited longer than `STATUS_MAX_QUEUE_AGE_S` (default 300 s),
  or no model provider available. The body lists the problems and per-queue counts — no tenant data.
- **Free alerting with GitHub Actions** — set the repository variable `STATUS_URL`
  (Settings → Secrets and variables → Actions → Variables) to `https://<your-api>/status`. The
  `Uptime` workflow checks it every 15 minutes, opens a "Production health check failing" issue
  (GitHub emails you) and closes it when the API recovers. Any uptime service (UptimeRobot,
  Better Stack) can poll the same URL instead.
- **Error tracking** — create a free Sentry project and set `SENTRY_DSN` (and optionally
  `SENTRY_ENVIRONMENT`) on the API and the worker. Reported: server errors (5xx), crashes and
  unhandled rejections, infrastructure job failures, and run failures that need action (internal
  errors, broken workspaces, provider authentication or request errors). Not reported: timeouts,
  rate limits and outages that retries, fallbacks and the circuit breaker already handle.
  Credentials are redacted; prompts, request bodies, model output and headers are never sent.
  Identical errors are sent once a minute, at most 30 events per minute per process.

## Self-hosting everything with Docker Compose

```bash
cp .env.example .env    # set AUTH_MODE=production, SESSION_SECRET, SECRETS_KEY, model keys
docker compose --profile app up -d
```

This starts PostgreSQL, Redis, the API, the worker (with access to the host Docker daemon for the
sandbox) and the web app behind nginx. Add `--profile bci` for the EEG Cognitive Mode sidecar.

## Models

- **Groq** serves GPT-OSS 120B / 20B, Llama 3.3 70B and Llama 3.1 8B in production and Qwen3.8 27B in preview ([models](https://console.groq.com/docs/models)); no model hosting is needed. Preview models can be withdrawn, so keep a production model in `GROQ_MODELS` as a fallback.
- **Anthropic, OpenAI, Google** — hosted APIs; set a platform key, or let each workspace add its own
  under Settings → Model providers. Defaults: `claude-sonnet-5-5`, `claude-haiku-5-5`,
  `claude-opus-5-5`; `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`; `gemini-3.8-flash`.
- **Self-hosted Qwen**: run Ollama (or any OpenAI-compatible server) and set `QWEN_BASE_URL` and
  `QWEN_MODELS` on the API and the worker. Small models (`qwen3:0.6b`, `qwen3:1.7b`) run on CPU;
  larger ones need a GPU to be responsive.
