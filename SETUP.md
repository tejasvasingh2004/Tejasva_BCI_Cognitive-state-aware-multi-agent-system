# NeuroFlow — Setup

See `README.md` for the full picture. Minimal local setup:

1. Install Node 22+, Docker, and enable pnpm: `corepack enable` (or `npm i -g pnpm@9`).
2. Model provider (at least one):
   - Local Qwen: install [Ollama](https://ollama.com), then `ollama pull qwen3:8b`
     (small/faster: `qwen3:1.7b`, set `QWEN_MODELS=qwen3:1.7b`).
   - Groq: set `GROQ_API_KEY` in `.env`.
3. `cp .env.example .env` and adjust.
4. `pnpm install`
5. `pnpm infra:up` — PostgreSQL on `localhost:5433`, Redis on `localhost:6380`
   (non-default host ports avoid clashing with locally installed Postgres/Redis).
6. `pnpm dev` — API on `:8080`, worker, web on `:5173`. Migrations run on start.

Optional Cognitive Mode EEG service:

```bash
docker compose --profile bci up -d bci     # http://localhost:8000
# then set BCI_SERVICE_URL=http://localhost:8000 in .env and restart the API/worker
```

Tests: `pnpm test` (needs `pnpm infra:up`), `pnpm test:e2e` (first run `pnpm --filter @neuroflow/web exec playwright install chromium`).

The pre-v4 Python/Next.js research prototype is documented in `README_old.md`; its Next.js UI has
been replaced by `apps/web` and its chat runtime by the Node.js runtime.
