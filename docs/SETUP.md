# NeuroFlow — Setup

See the [README](../README.md) for the overview and [STATUS.md](STATUS.md) for what is built. Hosting guide: [DEPLOYMENT.md](DEPLOYMENT.md). Minimal local setup:

1. Install Node 22+, Docker, and enable pnpm: `corepack enable` (or `npm i -g pnpm@9`).
2. Model provider (at least one):
   - Local Qwen: install [Ollama](https://ollama.com), then `ollama pull qwen3:8b`
     (small/faster: `qwen3:1.7b`, set `QWEN_MODELS=qwen3:1.7b`).
   - Groq: set `GROQ_API_KEY` in `.env` (several keys, comma-separated, form a key pool).
3. `cp .env.example .env` and adjust.
4. `pnpm install`
5. `pnpm infra:up` — PostgreSQL on `localhost:5433`, Redis on `localhost:6380`
   (non-default host ports avoid clashing with locally installed Postgres/Redis).
6. `pnpm dev` — API on `:8080`, worker, web on `:5173`. Migrations run on start.
7. Marketing site: `pnpm --filter @neuroflow/site dev` on `:5180`
   (production preview: `pnpm --filter @neuroflow/site build && pnpm --filter @neuroflow/site preview`).

Optional Cognitive Mode EEG service:

```bash
docker compose --profile bci up -d bci     # http://localhost:8000
# then set BCI_SERVICE_URL=http://localhost:8000 in .env and restart the API/worker
```

Code Agent: the sandbox runs commands in Docker, so keep Docker running next to the worker. Connect
GitHub with a fine-grained token (Contents and Pull requests read/write, Metadata read) or configure
`GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`.

## Plans and limits

Workspaces have a plan (free, pro, team, enterprise) that sets HTTP rate limits, active-run caps and
the daily token quota. The development seed puts the dev workspace on `team`. Change a plan with:

```bash
pnpm --filter @neuroflow/db cli set-plan --email <owner email> --plan pro
```

`.env` overrides (`RATE_LIMIT_PER_MINUTE`, `RUN_RATE_LIMIT_PER_MINUTE`, `DAILY_TOKEN_QUOTA`,
`MAX_ACTIVE_RUNS_PER_*`) apply to every plan. Provider budgets: `MODEL_PROVIDER_LIMITS`, e.g.
`groq:tpm=8000,rpm=30,concurrency=8;qwen:concurrency=2`.

## Tests

- `pnpm typecheck && pnpm lint`
- `pnpm test` — unit and integration (needs `pnpm infra:up` and Docker)
- `pnpm test:e2e` — Playwright (first run `pnpm --filter @neuroflow/web exec playwright install chromium`)

CI runs the same steps on every push (`.github/workflows/ci.yml`).

## Deployment

| Part | Where | Notes |
| --- | --- | --- |
| `apps/site` | Vercel, project root `apps/site` | `vercel.json` included; set `VITE_APP_URL` to the web app URL |
| `apps/web` | Vercel, project root `apps/web` | `vercel.json` rewrites to `index.html`; set `VITE_API_URL` to the API URL |
| `apps/api` | Railway (Nixpacks) | `nixpacks.toml` builds with pnpm 9 on Node 22 and starts `node apps/api/dist/main.js` |
| `apps/worker` | Railway, second service from the same repo | start `node apps/worker/dist/main.js`; needs Docker for the sandbox |
| PostgreSQL, Redis | managed services | set `DATABASE_URL`, `REDIS_URL` on API and worker |

Set `CORS_ORIGINS` and `PUBLIC_WEB_URL` on the API to the web app's URL, and `SECRETS_KEY` /
`SESSION_SECRET` to strong random values. Self-hosting: Docker Compose (`app` profile) and the
Dockerfiles in `infra/docker`.

The pre-v4 Python/Next.js research prototype is documented in [`legacy/prototype-readme.md`](legacy/prototype-readme.md); its Next.js UI has
been replaced by `apps/web` and its chat runtime by the Node.js runtime.
