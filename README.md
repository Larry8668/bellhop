# Bellhop

> An errand agent that never books without your say-so.

Chat-based agent that arranges home-service errands (plumber, electrician, AC servicing…). It clarifies missing details, compares providers, asks for explicit approval before anything consequential, and recovers safely when tools fail. Everything runs locally against a mock provider service.

Status: **Phase 1 (provider service) done**, plus the auth/API/web/MCP shells pulled forward as test surfaces. The agent itself (approvals, harness, memory) lands in Phases 2–5. See `TODO.md` for what's next and `LOGS.md` for decisions.

## Prerequisites

- Node 24+
- [Ollama](https://ollama.com) with `ollama pull qwen3.5:9b` (fallback: `ollama pull qwen3:8b`)
- Ollama is only needed to chat with the agent and for the Ollama smoke test. **`npm test` runs fully offline** against a scripted model and the mock provider on an ephemeral port.

## Layout

```
shared/     logger, clock, rng, and the tool contracts (zod) shared by provider and server
provider/   mock provider service: the 8 tool contracts, seeded randomness, admin endpoints
server/     Bellhop backend: auth, API, MCP, provider client; harness + core land in Phases 2–3
web/        React + Vite UI (login, chat, profile, bookings)
docs/       plan and transcripts
traces/     raw JSONL traces (one committed timeout-after-success run)
```

## Install

```bash
npm install                   # also builds shared/ and provider/ (prepare hook)
```

## Run

Three processes, three terminals (Docker Compose arrives in Phase 8):

```bash
# 1. mock provider on :4010, admin routes on
PROVIDER_ADMIN=1 npm run start -w provider

# 2. backend on :4000 (creates ./server/data/bellhop.db, migrations auto-applied)
BETTER_AUTH_SECRET=$(openssl rand -base64 32) npm run start -w server
npm run seed:demo -w server   # once: demo@bellhop.local / demo-pass-123 (same BETTER_AUTH_SECRET + DB_PATH)

# 3. web on :5173 (proxies /api to :4000)
npm run dev -w web
```

Sign in at http://localhost:5173 with the demo account. Profile → "Create key" gives an API key for MCP.

Env (all optional; defaults in `server/src/config.ts`, `provider/src/config.ts`): `MODEL`, `OLLAMA_BASE_URL`, `PROVIDER_URL`, `PROVIDER_TIMEOUT_MS`, `DB_PATH`, `SERVER_PORT`, `WEB_ORIGIN`, `BETTER_AUTH_SECRET`; provider `PORT`, `SEED`, `PROVIDER_ADMIN`, `TIMEOUT_DELAY_MS`, `HOLD_PRICE_DRIFT_PROB`.

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

Endpoint: `http://localhost:4000/mcp` (Streamable HTTP, stateless). Auth: `Authorization: Bearer <api key>` or `x-api-key`. Tools today: `search_providers`, `get_provider` (reviews returned fenced as untrusted text), `list_bookings`, `whoami`. `propose_*` + approval elicitation arrive with Phase 2/7.

Cursor (`.cursor/mcp.json`) or Claude Code:

```json
{ "mcpServers": { "bellhop": { "url": "http://localhost:4000/mcp", "headers": { "Authorization": "Bearer <api key>" } } } }
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

The provider exposes `/__admin` routes when `PROVIDER_ADMIN=1`:

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
