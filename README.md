# Bellhop

> An errand agent that never books without your say-so.

Chat-based agent that arranges home-service errands (plumber, electrician, AC servicing…). It clarifies missing details, compares providers, asks for explicit approval before anything consequential, and recovers safely when tools fail. Everything runs locally against a mock provider service.

The repo is an npm workspace: mock provider, Bellhop server, and React UI. `npm test` is offline. Chat with the model needs Ollama on the host. See `TODO.md` for what's next and `LOGS.md` for decisions.

## Prerequisites

- Node 24+
- [Ollama](https://ollama.com) with `ollama pull qwen3.5:9b` (fallback: `ollama pull qwen3:8b`)
- Ollama is only needed to chat with the agent and for the Ollama smoke test. **`npm test` runs fully offline** against a scripted model and the mock provider on an ephemeral port.

## Layout

```
shared/              logger, clock, rng, migrate, tool contracts (zod)
provider/            mock provider HTTP service, its own SQLite, /__admin routes
server/              API, Better Auth, harness, core, MCP
web/                 React + Vite UI (login, chat, profile, bookings, proposals)
docker/              nginx config for the compose `web` service
docs/                plan and transcripts
traces/              raw JSONL traces
docker-compose.yml   provider + server + web; Ollama stays on the host
```

## Install

```bash
npm install                   # prepare hook: husky, then build shared, provider, and web
```

## Migrate and seed

`npm run start` on provider and server applies pending SQL migrations before serving. The commands below are for a one-shot migrate or a fresh demo login. Use the same `DB_PATH` and `BETTER_AUTH_SECRET` for seed and server.

```bash
npm run db:migrate -w provider
npm run db:migrate -w server
npm run seed:demo -w server
# demo@bellhop.local / demo-pass-123
```

`seed:demo` is idempotent. For the demo personas (`fresh@`, `returning@`, `mover@`, all `demo-pass-123`) run `npm run seed:demo-users -w server` with the provider running. See `DEMO.md` for the recording script.

`seed:demo` is idempotent. `npm run db:seed -w server` seeds the same account. Provider seed data is applied on first boot (and by `npm run db:seed -w provider`); it is not the demo login.

## Run (dev)

Three processes. Ollama must already be running if you want live model replies (`ollama pull qwen3.5:9b`, or `MODEL=qwen3:8b` after `ollama pull qwen3:8b`).

```bash
# 1. mock provider on :4010, admin routes on
PROVIDER_ADMIN=1 npm run start -w provider

# 2. backend on :4000 (default DB ./server/data/bellhop.db when cwd is server/)
BETTER_AUTH_SECRET=$(openssl rand -base64 32) npm run start -w server
npm run seed:demo -w server   # once; same BETTER_AUTH_SECRET and DB_PATH as the server

# 3. web on :5173 (Vite proxies /api to :4000)
npm run dev -w web
```

Sign in at http://localhost:5173 with the demo account. Profile → "Create key" gives an API key for MCP.

Env (all optional; defaults in `server/src/config.ts` and `provider/src/config.ts`): `MODEL` (default `qwen3.5:9b`), `MODEL_FALLBACK` (`qwen3:8b`), `OLLAMA_BASE_URL` (`http://localhost:11434`), `PROVIDER_URL` (`http://localhost:4010`), `PROVIDER_TIMEOUT_MS`, `DB_PATH`, `TRACES_DIR`, `SERVER_PORT` (`4000`), `WEB_ORIGIN` (`http://localhost:5173`), `BETTER_AUTH_SECRET` (default `dev-secret-change-me`), `BETTER_AUTH_URL` (`http://localhost:4000`). Provider: `PORT` (`4010`), `SEED`, `PROVIDER_ADMIN`, `TIMEOUT_DELAY_MS`, `HOLD_PRICE_DRIFT_PROB`, `DB_PATH`.

## Run with Docker Compose

Ollama is not a container. Start it on the host and pull a model first. Compose reaches it at `http://host.docker.internal:11434` (`extra_hosts: host.docker.internal:host-gateway`).

```bash
ollama pull qwen3.5:9b
docker compose up --build
```

| Service | Published port | What you open |
|---|---|---|
| `web` | 8080 → nginx | http://localhost:8080 (static Vite build; `/api` and `/mcp` proxied to `server`) |
| `server` | 4000 | http://localhost:4000/api/health and http://localhost:4000/mcp |
| `provider` | 4010 | http://localhost:4010/health ; `/__admin` is on (`PROVIDER_ADMIN=1`) |

Demo login is the same: `demo@bellhop.local` / `demo-pass-123`. On startup `server` runs `npm run db:migrate -w server`, then `npm run seed:demo -w server`, then `npm run start -w server`.

SQLite files and traces are named volumes (`provider-data`, `server-data`, `traces`), not the files in your checkout. `BETTER_AUTH_SECRET` defaults to `dev-secret-change-me` via `${BETTER_AUTH_SECRET:-dev-secret-change-me}`. `BETTER_AUTH_URL` and `WEB_ORIGIN` default to `http://localhost:8080` so the proxied UI and Better Auth share one origin. Override them in the environment if you publish `web` on another host port.

`MODEL` still defaults to `qwen3.5:9b`. Set `MODEL=qwen3:8b` on the `server` service if that is the model you pulled.

## Database

SQL-file migrations, versioned and applied in order, Node's equivalent of alembic/dbmate (`@bellhop/shared/migrate`). Provider and server each have their own SQLite file and their own migrations directory:

- `provider/db/migrations/*.sql` — engine tables (providers, slots, holds, bookings, idempotency, events).
- `server/db/migrations/*.sql` — `0001_auth.sql` is generated, not hand-written (see below); later files are app tables (conversations, task_state, proposals, …).

Both workspaces expose the same five commands:

```bash
npm run db:migrate -w provider   # apply all pending migrations
npm run db:rollback -w provider  # revert the most recent migration (or `tsx scripts/db.ts down <n>` for more)
npm run db:status -w provider    # table of applied/pending migrations
npm run db:seed -w provider      # seed data (providers, or the demo account on server) — skips if already seeded
npm run db:reset -w provider     # revert everything reversible, re-migrate, reseed — a fresh db for testing
npm run db:stamp -w server -- 0001   # adopt a db created before migrations existed: mark ≤0001 applied without running
# same five with `-w server`
```

**Boot auto-applies pending migrations** (`bootstrapProvider` / `server/src/index.ts` both run `up()` before serving traffic and log `migrations: N applied`), so `npm run start` never needs a manual migration step — `db:migrate` is for inspecting/scripting, or for `db:status`/`db:rollback` during development.

**Adding a migration:** create `<dir>/NNNN_name.sql` with the next zero-padded 4-digit version (e.g. `0002_add_index.sql`), dbmate-style sections:

```sql
-- migrate:up
CREATE INDEX idx_bookings_user ON bookings(user_id);

-- migrate:down
DROP INDEX idx_bookings_user;
```

A file with no `-- migrate:down` section applies fine but `db:rollback`/`db:reset` refuse to revert it — only do this for a change that's genuinely one-way.

**Server auth tables are generated, not hand-written:** `npm run db:gen-auth -w server` builds the same options `createAuth` uses, asks Better Auth's own migration planner (`better-auth/db/migration`'s `getMigrations`) what it would create against a fresh db, and writes that into `0001_auth.sql`. Re-run it (and add a *new* migration on top — never hand-edit `0001_auth.sql`) after a Better Auth upgrade; `server/test/db/migrate.test.ts` fails loudly if the installed version would now plan something different.

### MCP

Endpoint: `http://localhost:4000/mcp` (Streamable HTTP). With Compose, the same route is also proxied at `http://localhost:8080/mcp`. Create a key on the Profile page. The server accepts `Authorization: Bearer <api key>` (also `x-api-key`). `user_id` comes from that key, never from tool arguments.

Tools: `search_providers`, `get_provider` (reviews fenced as untrusted text), `list_bookings`, `whoami`, `propose_booking`, `propose_cancel`, `propose_reschedule`, `list_proposals`, `decline_proposal`. Booking, cancel, and reschedule still require approval (elicitation when the client supports it, otherwise confirm in the UI).

Cursor (`.cursor/mcp.json`) or Claude Code:

```json
{
  "mcpServers": {
    "bellhop": {
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer <api key>" }
    }
  }
}
```

### Checks

```bash
npm run typecheck
npm run lint
npm test                      # offline: scripted model + mock provider on an ephemeral port
```

Ollama smoke test (needs Ollama running):

```bash
npm run smoke:ollama -w server
```

## Forcing scenarios

The provider exposes `/__admin` routes when `PROVIDER_ADMIN=1` (set that way in Compose, and in the dev command above):

```bash
# queue forced outcomes (FIFO, consumed by the next matching tool call)
curl -X POST localhost:4010/__admin/scenario -H 'content-type: application/json' \
  -d '{"outcomes":["PRICE_CHANGES_ON_HOLD","TIMEOUT_BOOKED"],"timeout_delay_ms":8000}'
# BOOK_SUCCESS BOOK_SLOT_TAKEN TIMEOUT_BOOKED TIMEOUT_NOT_BOOKED HOLD_EXPIRED PRICE_CHANGES_ON_HOLD
# CANCEL_503_ONCE CANCEL_OK RESCHEDULE_CONFLICT SEARCH_ERROR RANDOM (clears the queue)

curl -X POST localhost:4010/__admin/clock -H 'content-type: application/json' -d '{"advance_ms":660000}'   # expire holds
curl -X POST localhost:4010/__admin/cancel-booking/bk_1      # provider-side cancellation (proactive flow, Phase 5)
curl -X POST localhost:4010/__admin/reset -H 'content-type: application/json' -d '{"seed":7}'
curl localhost:4010/__admin/state                            # holds, bookings, idempotency map, pending scenarios
```

Without forced scenarios the engine follows the spec's odds: `book` succeeds 70%, `slot_taken` 15%, times out 15% (half of those actually booked); `cancel` fails once with 503 then succeeds; hold prices drift 15% of the time. Tool calls need an `x-user-id` header (the backend sets it from the session; it never comes from the model).

## Deliverables

| File | What |
|---|---|
| `DESIGN.md` | one-page design note with annotated trace excerpt (Phase 8) |
| `EVALS.md` | generated by the test reporter, never hand-edited |
| `BUGS.md` | real bugs hit while building, with regression tests |
| `LOGS.md` | dated decisions and progress |
| `TODO.md` | what's next |
| `traces/` | raw JSONL traces |
| `docs/transcripts/` | AI-assistant transcripts, unedited |
