# TODO

Persistent next-steps list. Move items to `LOGS.md` when done. Keep phases in sync with `docs/bellhopper-plan.md` §18.

## Now

- [x] Sign off plan v2 (`docs/bellhopper-plan.md`)
- [x] Dev setup: subagents, rules, husky, commitlint, CI (PR #1)
- [ ] Verify custom subagents + model pins are honored from the IDE Task tool (fresh turn)
- [ ] Confirm deadline → decide how firmly phases 7–9 stay in scope
- [ ] Branch protection on `main`: needs GitHub Pro or public repo; revisit when either changes

## Phase 0 — Scaffold

- [ ] npm workspaces: `provider/`, `server/`, `web/`
- [ ] TS config, Vitest, `better-sqlite3`, zod
- [ ] `server/src/config.ts` (model, limits, budgets, provider URL)
- [ ] Trace writer skeleton (JSONL)
- [ ] Logger module (pino, child loggers per module, `LOG_LEVEL`, run_id/turn_id correlation) shared by provider + server
- [ ] Ollama smoke test via `ai-sdk-ollama` (`think: false`, `num_ctx: 8192`, `reliableToolCalling: false`)
- [ ] Mock-model smoke test (`MockLanguageModelV4` + `ToolLoopAgent`)
- [ ] README skeleton, `BUGS.md`
- [ ] Verify: Better Auth + `better-sqlite3` adapter; MCP SDK v2 package name/API; `ai-sdk-ollama` peer range for `ai` 7.0.x

## Phase 1 — Provider service

- [ ] Pure engine: providers, slots, holds (10-min TTL), bookings, idempotency map
- [ ] Seeded RNG + injectable clock
- [ ] Named scenarios (see plan §4)
- [ ] 8 tool routes matching contracts exactly
- [ ] `/__admin` routes (reset, scenario, clock, cancel-booking, state), gated by env
- [ ] Own SQLite + seed (providers, reviews with ≥1 injection)
- [ ] `server/src/provider-client` with zod-validated responses + timeout handling
- [ ] Test setup boots provider on an ephemeral port
- [ ] Contract test per tool

## Phase 2 — Core engine

- [ ] Schema + migrations (task_state, proposals, approvals, intents, bookings, events)
- [ ] State machine with persisted transitions
- [ ] Proposal hashing; approval create/consume (CAS)
- [ ] Intents written before side effects; idempotency key from approval id
- [ ] Executors: book (timeout → status check), cancel (503 retry), reschedule (conflict → alternatives)
- [ ] Startup recovery of pending/unknown intents
- [ ] Per-user promise queue
- [ ] EVALS reporter
- [ ] Scenarios 6, 9–16, H1–H10

## Phase 3 — Harness

- [ ] ToolLoopAgent wiring, tool wrappers (user_id injection, counters, zod)
- [ ] `propose_*` validates against task_state constraints
- [ ] `prepareStep` context layer: builder, budget, tool-result clearing, context_log
- [ ] Limits: stopWhen, tool counter, AbortSignal.timeout; user-facing exit messages
- [ ] Trace via onStepFinish
- [ ] Scripted-model helpers
- [ ] Scenarios 1–5, 23–28; commit first raw trace

## Phase 4 — Memory

- [ ] Facts store, kinds/statuses, lint, profile.md renderer
- [ ] Relevance selection, exclusion of forgotten/unconfirmed
- [ ] Seed 50+ memories + long history
- [ ] Scenarios 17–21

## Phase 5 — Proactive

- [ ] Decide polling vs webhook from provider
- [ ] Event processor through per-user queue; replacement search; fresh approval
- [ ] Scenario 22

## Phase 6 — API + Auth + UI

- [ ] HTTP + SSE routes; Better Auth email/password; seeded demo account
- [ ] Web: Login, Chat (approval card, trace panel), Profile (facts, API key), Bookings

## Phase 7 — MCP

- [ ] `/mcp` route (MCP SDK v2, stateless HTTP)
- [ ] API Key plugin auth → user_id
- [ ] Elicitation approval + `CapabilityNotSupported` fallback to UI link
- [ ] Verify with Claude Code and Cursor

## Phase 8 — Ship

- [ ] docker-compose (provider, server, web; Ollama on host)
- [ ] DESIGN.md (1 page) from LOGS.md; annotated trace excerpt
- [ ] Final EVALS.md; ≥3 entries in BUGS.md
- [ ] Demo video (3–5 min); export this Cursor transcript to `docs/transcripts/`

## Backlog (not a priority)

- [ ] Provider randomness beyond spec: latency jitter, intermittent 5xx/429 on any tool, rating/price drift between searches, providers going offline, varied injection phrasings, malformed-but-valid responses, configurable outcome weights per tool
- [ ] OAuth 2.1 MCP auth via `@better-auth/mcp` + `cimd` + consent page
- [ ] Capacitor wrapper
- [ ] Tune limit values and token-slot budget after real Qwen runs
