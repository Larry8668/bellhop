# TODO

Persistent next-steps list. Move items to `LOGS.md` when done. Keep phases in sync with `docs/bellhopper-plan.md` §18.

## Now

- [x] Sign off plan v2 (`docs/bellhopper-plan.md`)
- [x] Dev setup: subagents, rules, husky, commitlint, CI (PR #1)
- [x] CLI delegation scripts + review panel runner + cli.json deny rules (PR #3)
- [ ] Confirm deadline → decide how firmly phases 7–9 stay in scope
- [ ] `.delegate/` transcripts are never cleaned up; add a prune step (review-security MINOR)
- [ ] Stub-`agent` test for delegate.sh / review-panel.sh failure paths (reviewers' MAJOR; low priority)
- [x] First gate review at end of Phase 2 — timings in LOGS 2026-11-06
- [ ] Branch protection on `main`: needs GitHub Pro or public repo; revisit when either changes

## Phase 0 — Scaffold (PR #7)

- [x] npm workspaces: `shared/`, `provider/`, `server/` (`web/` added in Phase 6)
- [x] TS config, ESLint flat config, Vitest, `better-sqlite3`, zod
- [x] `server/src/config.ts` (model, limits, budgets, provider URL)
- [x] Trace writer skeleton (JSONL) + result sanitizer + cost table
- [x] Logger module (pino, child loggers per module, `LOG_LEVEL`) in `@bellhop/shared`
- [x] Ollama smoke test via `ai-sdk-ollama` (`think: false`, `num_ctx: 8192`, `reliableToolCalling: false`)
- [x] Mock-model smoke test (`MockLanguageModelV4` + `ToolLoopAgent`)
- [x] README skeleton, `BUGS.md`
- [x] Verified `ai-sdk-ollama` 4.x with `ai` 7.0.x (smoke test passes)
- [x] Verified: Better Auth 1.7 takes a raw better-sqlite3 handle; API-key plugin moved to `@better-auth/api-key`; MCP SDK is 1.32 (no v2), `@hono/mcp` 0.3 gives the Hono transport
- [ ] Fill in README (setup, scripts, layout) once Phase 1 lands
- [ ] `PORT=` (empty string) coerces to 0 in provider config; tighten to "unset or valid" if it bites

## Phase 1 — Provider service (PR #15)

- [x] Tool contracts as zod schemas in `@bellhop/shared/contracts` (single source for provider routes, client, MCP)
- [x] Pure engine: providers, slots, holds (10-min TTL), bookings, idempotency map
- [x] Seeded RNG + adjustable clock
- [x] Named scenarios (FIFO queue, per-tool matching)
- [x] 8 tool routes matching contracts exactly; simulated timeout = delayed 504
- [x] `/__admin` routes (reset, scenario, clock, cancel-booking, state), gated by `PROVIDER_ADMIN`
- [x] Own SQLite + seed (≈150 providers, reviews with injection templates, ≥1 per service×area)
- [x] `server/src/provider-client` with zod-validated responses + timeout handling
- [x] `@bellhop/provider/testing` boots the provider on an ephemeral port; e2e test client ↔ real provider
- [x] Contract test per tool over HTTP; every forced scenario reproducible over HTTP
- [ ] Dedupe `openDatabase` (server) / `openProviderDb` (provider) into shared once shared takes a better-sqlite3 dep
- [ ] Better Auth logs "schema mismatch" at boot before `migrateAuth` runs (cosmetic); silence or reorder
- [ ] `web`: `vitest.config.ts` separate from `vite.config.ts` only because `tsc -b` typechecks the Vite config; merge when convenient

## Pulled forward from Phases 6/7 (test surfaces)

- [x] Better Auth email/password + `@better-auth/api-key`; `resolvePrincipal` (session → API key, never body)
- [x] `/api/me`, `/api/keys` (session-only), `/api/bookings`, CORS for the web origin, `seed:demo`
- [x] `web/`: Vite 8 + React 19 + Tailwind 4; Login, Chat (ApprovalCard, TracePanel), Profile (facts, API keys), Bookings; `httpApi` + `mockApi`
- [x] `/mcp` stateless Streamable HTTP via `@hono/mcp`; tools `search_providers`, `get_provider` (fenced reviews), `list_bookings`, `whoami`
- [x] MCP `propose_*` + elicitation approval + UI-link fallback (Phase 2 wave 3B)
- [x] `/api/proposals` (+ approve/decline), `/api/task`, web Proposals page with hash-carrying Confirm (Phase 2 wave 3C/3D)
- [x] Web chat/events/facts endpoints served (`/api/messages`, `/api/chat/send`, `/api/events`, `/api/facts`, dev provider-cancel)
- [x] MCP `get_profile` for the API-key user
- [ ] Verify elicitation end-to-end from Cursor's MCP client (does it surface the confirm form? else the UI-link fallback is what users see)

## Phase 2 — Core engine (PRs #22–#30 into `feat/phase-2-core`)

- [x] Schema + migrations (`0003_core.sql`: conversations, messages, task_state, proposals, approvals, intents, bookings, events)
- [x] State machine with persisted transitions (+ `GATHERING → PROPOSED` for cancel/reschedule)
- [x] Proposal hashing over the hold price; approval create/consume (CAS)
- [x] Intents written before side effects; idempotency key `<action>_<approval_id>`
- [x] Executors: book (re-hold + hash recheck, timeout → status check → bounded same-key retry → unconfirmed), cancel (503 retry), reschedule (conflict → alternatives)
- [x] Startup recovery of pending/unknown intents (runs in `index.ts` before listen)
- [x] Per-user promise queue (one instance shared by API and MCP)
- [x] EVALS reporter (`task.meta.expected/actual`), `createCoreEngine` facade, `x-request-id` server → provider
- [x] Scenarios 6, 9–11, 13–16, H1–H10 (22 rows in `EVALS.md`)
- [x] Gate review panel on the Phase 2 → `main` PR — 2 BLOCKERs + MAJORs fixed, re-review clean (see LOGS 2026-11-06)
- [ ] `test/mcp/propose.test.ts` cross-user `list_proposals` failed once under full-suite load (1 of 5 runs); not reproduced in isolation — investigate before Phase 3 adds load
- [ ] Gate deferrals: move the identical `request-id` middleware (server/provider) into `@bellhop/shared`; `approvals.approveOrReplay` in core so the HTTP route stops holding replay logic; per-user proposal rate limit (hold exhaustion)
- [ ] Provider: admin knob for hold-price drift direction (H4/H5 currently pinned by RNG seed)
- [ ] Provider: expose `idempotency_key` per booking in `/__admin/state` so invariant "one booking per key" can be asserted exactly
- [ ] MCP session trace: one `mcp_<requestId>` file per session; switch to per-turn run ids in Phase 3
- [ ] Cleanup chore: remove the Phase 1 demo booking `bk_1` and the smoke booking `bk_2` from the live DBs

## Phase 3 — Harness

- [x] ToolLoopAgent wiring, tool wrappers (user_id injection, counters, zod)
- [x] `propose_*` validates against task_state constraints
- [x] `prepareStep` context layer: builder, budget, tool-result clearing, context_log
- [x] Limits: stopWhen, tool counter, AbortSignal.timeout; user-facing exit messages
- [x] Trace via onStepFinish
- [x] Scripted-model helpers
- [x] Scenarios 1–5, 23–28; commit first raw trace

## Phase 4 — Memory

- [x] Facts store, kinds/statuses, lint, profile.md renderer
- [x] Relevance selection, exclusion of forgotten/unconfirmed
- [x] Seed 50+ memories + long history
- [ ] Scenarios 17–21 — S18–S21 memory assertions are in `server/test/scenarios/memory.test.ts`; S17 and the conversation half of S18 need the harness

## Phase 5 — Proactive

- [x] Decide polling vs webhook from provider
- [x] Event processor through per-user queue; replacement search; fresh approval
- [x] Scenario 22

## Phase 6 — API + Auth + UI

- [x] HTTP + SSE routes (`/api/messages`, `/api/chat/send`, `/api/events`, dev provider-cancel); Better Auth email/password; seeded demo account
- [x] Web: Login (demo hint), Chat (approval card + countdown, trace panel), Profile (grouped facts, API key + MCP snippet), Bookings (dev provider-cancel), mock API (2026-11-07)

## Phase 7 — MCP

- [x] `/mcp` route plus `get_profile` (SDK is 1.x, not v2 — see LOGS 2026-11-06)
- [x] API Key plugin auth → user_id
- [x] Elicitation approval + `CapabilityNotSupported` fallback to UI link
- [ ] Verify with Claude Code and Cursor

## Phase 8 — Ship

- [x] docker-compose (provider, server, web; Ollama on host) — PR #35, personas seeded on boot
- [x] DESIGN.md (1 page) with annotated live timeout-after-success trace (`traces/examples/`)
- [x] Final EVALS.md (39/39 scenarios); BUGS.md has 6 entries with regression tests
- [x] Cursor transcripts exported to `docs/transcripts/` (PR #36); `DEMO.md` runbook + `seed:demo-users` personas
- [ ] Demo video (3–5 min) — user, following `DEMO.md`
- [ ] Export the Claude Code session transcript of 2026-11-07 to `docs/transcripts/`
- [ ] Known rough edge: on a vague first message qwen3.5:9b may search with a guessed area before asking

## Backlog (not a priority)

- [ ] Provider randomness beyond spec: latency jitter, intermittent 5xx/429 on any tool, rating/price drift between searches, providers going offline, varied injection phrasings, malformed-but-valid responses, configurable outcome weights per tool
- [ ] OAuth 2.1 MCP auth via `@better-auth/mcp` + `cimd` + consent page
- [ ] Capacitor wrapper
- [ ] Tune limit values and token-slot budget after real Qwen runs
