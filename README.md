# NeuroFlow Production Execution Docs — v4

This documentation set updates NeuroFlow to a TypeScript-first architecture.

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Node.js + Fastify + TypeScript
- Validation/contracts: Zod + JSON Schema
- Queue: Redis + BullMQ
- Database: PostgreSQL
- Realtime: SSE/WebSocket
- Models: Qwen + Groq
- Observability: OpenTelemetry
- Packaging: Docker

## Why not Next.js?

NeuroFlow is primarily an AI execution runtime/workspace rather than a content-heavy web application. Keeping React and Node independently deployable makes the long-running worker, queue, model gateway, tool runtime, realtime transport, and future horizontal scaling cleaner.

Next.js can still be introduced later for a separate marketing/site surface if useful, without coupling the AI runtime to it.

## Files

- `architecture.md` — system architecture and invariants
- `system-design.md` — implementation-level design
- `prd.md` — product requirements
- `brain-dump.md` — product/architecture reasoning
- `progress.md` — implementation checklist
- `claude.md` — master implementation prompt
