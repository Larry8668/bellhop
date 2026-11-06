# Bellhop — Build Plan (v2, final)

> An errand agent that never books without your say-so.

Chat-based agent that arranges home-service errands (plumber, electrician, AC servicing…): clarifies missing details, compares providers, gets explicit approval before any consequential action, and recovers safely from tool failures. Runs fully locally against a mock provider service.

This plan is the source of truth for scope. If something is not here or in the assignment, don't build it without asking. Working files: `TODO.md` (what's next), `LOGS.md` (what happened, what was decided), `BUGS.md` (real bugs + regression tests).

---

## 1. Final decisions

| Area | Decision |
|---|---|
| Name | Product **Bellhop**. Repo `Larry8668/bellhop`. Local folder name is irrelevant. |
| Language | TypeScript, Node 24 |
| Agent loop | **Vercel AI SDK v7 directly** (`ToolLoopAgent` + `prepareStep`). No Mastra. |
| LLM | `qwen3.5:9b` on Ollama via `ai-sdk-ollama` v4: `think: false`, `temperature: 0`, `num_ctx: 8192`, `keep_alive: '10m'`, `reliableToolCalling: false` (every model call must be visible to limits + trace). Fallback `qwen3:8b`. Model is a config value. |
| Offline evals | `MockLanguageModelV4` from `ai/test`, scripted per scenario. `npm test` never touches Ollama. |
| Provider tools | **Separate mock provider HTTP service** (`provider/`), own SQLite, seeded RNG, injectable clock, admin endpoints to force scenarios. Backend only talks to it over HTTP. |
| DB | SQLite via `better-sqlite3` (backend and provider each have their own file) |
| Auth | Better Auth, email + password. API Key plugin for MCP clients. OAuth (`@better-auth/mcp`) is a stretch. |
| UI | React + Vite, HTTP + SSE |
| MCP | Route `/mcp` on the backend (MCP SDK v2, stateless HTTP). Approval via **elicitation**, fallback to confirm-in-UI. |
| Packaging | Monorepo with npm workspaces; `docker-compose.yml` runs `provider` + `server` + `web`; Ollama on host via `host.docker.internal`. |
| Tests | Vitest + custom reporter that generates `EVALS.md` |
| Validation | zod 4 |

**Explicitly skipped:** Mastra, multi-agent, vector DB / embeddings, LLM-written summaries, context resets, OAuth/2FA (stretch only), Capacitor (maybe after everything else).

> Package versions were checked on 2026-11-06: `ai` 7.0.x, `ai-sdk-ollama` 4.x, `better-auth` 1.7.x, `better-sqlite3` 13.x, `vitest` 5.x, `zod` 4.x, `@modelcontextprotocol/server` v2. Re-verify APIs at install time; don't assume from memory.

---

## 2. Architecture

```
                  ┌─────────────────── Bellhop server ───────────────────┐
React UI ───────► │ HTTP/SSE API  (Better Auth session → user_id)        │
                  │   ↓                                                   │
MCP client ─────► │ /mcp route (API key → user_id, elicitation approval)  │
(Claude Code,     │   ↓                                                   │
 Cursor, any LLM) │ Harness: ToolLoopAgent + context layer + limits       │        ┌────────────────────┐
                  │   LLM calls READ-ONLY tools + propose_* only          │  HTTP  │ Provider service   │
                  │   ↓                                                   │ ─────► │ 8 tool contracts   │
                  │ Core: state machine · proposals/approvals · intents   │        │ seeded RNG, clock  │
                  │       executors (book/cancel/reschedule) · recovery   │        │ admin endpoints    │
                  │ Memory · Context log · Trace (JSONL) · Events · SQLite│        │ own SQLite         │
                  └───────────────────────────────────────────────────────┘        └────────────────────┘
```

**Core rule 1:** the LLM never calls `book`, `cancel`, or `reschedule`. It calls read-only tools and `propose_*`. Execution runs in core code, gated by an approval row that only the user can create (button, typed-yes checked by code, or MCP elicitation).

**Core rule 2:** `user_id` comes from the authenticated session or API key, never from the model or tool arguments.

**Core rule 3:** one source of truth for workflow state: our own tables (`task_state`, `proposals`, `approvals`, `intents`). No framework snapshots.

---

## 3. Repo layout

```
bellhop/
  package.json             # npm workspaces: provider, server, web
  docker-compose.yml
  README.md  DESIGN.md  EVALS.md  BUGS.md  LOGS.md  TODO.md
  docs/                    # plan, transcripts (internal/ is gitignored)
  traces/                  # raw JSONL; one committed timeout-after-success run
  provider/                # mock provider service
    src/
      engine/              # pure: slots, holds, bookings, idempotency map, scenario rules
      rng.ts  clock.ts     # seeded RNG, injectable clock
      scenarios.ts         # named forced outcomes
      http.ts              # tool routes + /__admin routes
      db/                  # schema + seed (providers, reviews incl. injections)
    test/
  server/
    src/
      config.ts            # model, limits, budgets, provider URL
      provider-client/     # typed HTTP client for the 8 tools (zod-validated responses)
      core/
        state/             # task state machine
        approvals/         # proposal hashing, approval create/consume (CAS)
        actions/           # book / cancel / reschedule / replace executors
        recovery/          # startup resolver for pending intents
        queue/             # per-user promise queue
      harness/
        agent.ts           # ToolLoopAgent setup, tools, stopWhen, abort
        tools/             # read-only wrappers + propose_* (zod, user_id injection, counters)
        context/           # prepareStep: builder, budget, tool-result clearing, context_log
        limits.ts
        scripted-model.ts  # MockLanguageModelV4 helpers for evals
      memory/              # facts store, relevance selection, lint, profile.md renderer
      trace/               # JSONL writer, sanitizer, cost estimator
      events/              # simulated provider-cancellation processor
      api/                 # HTTP + SSE routes, Better Auth wiring
      mcp/                 # MCP route, API-key auth, elicitation approval
      db/                  # schema, migrations, seed (50+ memories, long history)
    test/
      scenarios/           # 30+ eval scenarios
      reporter/            # writes EVALS.md
  web/                     # React + Vite: Chat (+trace panel), Profile, Bookings, Login
```

---

## 4. Provider service (mocks)

A real small HTTP server, not in-process stubs. It is the development and testing benchmark for the backend.

**Tool routes (contracts fixed by the assignment):**

| Tool | Required behaviour |
|---|---|
| `search_providers(service, area, date_range)` | 3–8 providers: id, name, price, rating, slots, attributes |
| `get_provider(provider_id)` | details + free-text reviews; ≥1 review contains a prompt-injection attempt |
| `hold_slot(provider_id, slot)` | 10-min hold, returns hold_id + expires_at; quoted price may differ from search price (configurable) |
| `book(hold_id, idempotency_key)` | 70% success / 15% `slot_taken` / 15% timeout (half of those actually booked); `hold_expired` if past expiry |
| `get_booking_status(hold_id \| idempotency_key)` | source of truth |
| `cancel(booking_id, idempotency_key)` | first call 503, retry succeeds |
| `reschedule(booking_id, slot, idempotency_key)` | `slot_conflict` on configured slots |
| `list_bookings(user_id)` | past + upcoming: id, provider, service, slot, status |

**Rules the engine must honour:**
- Idempotency keys are stored: same key → same result, no second side effect. Different request under same key → `idempotency_mismatch`.
- "Timeout" means: the HTTP response is delayed past the backend's timeout (or a 504 is returned), and the booking may or may not have been written. `get_booking_status` reveals the truth.
- Holds and bookings persist in the provider's SQLite so provider restarts are realistic.
- Pure engine + thin HTTP layer, so tests can also drive the engine directly when useful.

**Admin endpoints (dev/test only, disabled unless `PROVIDER_ADMIN=1`):**
- `POST /__admin/reset` — wipe and reseed with a given seed
- `POST /__admin/scenario` — force next outcome(s): `BOOK_SUCCESS`, `BOOK_SLOT_TAKEN`, `TIMEOUT_BOOKED`, `TIMEOUT_NOT_BOOKED`, `PRICE_CHANGES_ON_HOLD`, `HOLD_EXPIRED`, `CANCEL_503_ONCE`, `RESCHEDULE_CONFLICT`, `SEARCH_ERROR`, `RANDOM`
- `POST /__admin/clock` — set or advance the provider clock (hold expiry tests)
- `POST /__admin/cancel-booking/:id` — provider-side cancellation (feeds the proactive event)
- `GET /__admin/state` — dump holds/bookings/idempotency map for assertions

**Later (tracked in `TODO.md`, not a priority):** go beyond the spec's randomness so nothing looks hard-coded: latency jitter, intermittent 5xx/429 on any tool, rating/price drift between searches, providers going offline, varied injection phrasings, malformed-but-valid-JSON responses.

---

## 5. Data model (backend SQLite)

Better Auth manages its own tables (`user`, `session`, `account`, `apikey`…). App tables:

| Table | Purpose / key columns |
|---|---|
| `conversations`, `messages` | chat history per user |
| `task_state` | current errand: service, area, window, budget, prefs, state, updated_at |
| `proposals` | id, user_id, action, provider_id, slot, price, booking_id, hold_id, hold_expires_at, `hash`, status (pending/superseded/declined/expired/approved) |
| `approvals` | id, proposal_id, hash, status (valid/consumed/void), source (button/typed/mcp_elicitation), created_at |
| `intents` | idempotency_key UNIQUE, approval_id, action, status (pending/succeeded/failed/unknown), result, attempts |
| `bookings` | app-side view, synced from provider |
| `memories` | id, user_id, key, value, kind (explicit/inferred), status (active/unconfirmed/forgotten), source, timestamps |
| `context_log` | per model call: memory ids sent, history range, tool results kept/cleared, est tokens, actual tokens |
| `events` | provider cancellations, processed flag |

---

## 6. State machine

```
GATHERING → SEARCHING → COMPARING → PROPOSED → APPROVED → EXECUTING → VERIFYING → DONE
                                        ↑          │           │            │
                                        └──────────┴───────────┴── material change / hold expired / slot_taken
any state → FAILED (user-facing message)      any state → LIMIT_EXCEEDED (user-facing message)
```

- Persisted in `task_state` on every transition; every transition traced.
- A correction updates only the corrected field; other facts stay.
- Cancel and reschedule use the same PROPOSED → … → DONE path.
- A new proposal supersedes any pending one for that user.

---

## 7. Approval enforcement

- `propose_*` → holds the slot (booking) → stores proposal with `hash = sha256(action, provider_id, slot, price, booking_id)` where `price` is the **hold's quoted price** → UI/MCP shows a card with exact details.
- Approval rows are created only by: Confirm button (`proposal_id` + `hash`), typed yes/confirm checked by code when exactly one unexpired proposal is pending (config flag, default on), or MCP elicitation response.
- Execute: re-hold if expired, recompute hash from the actual hold. Hash equal → proceed (identical re-hold does not re-ask). Hash differs (price up **or down**, slot changed) → approval void → new proposal → ask again.
- Consume atomically: `UPDATE approvals SET status='consumed' WHERE id=? AND status='valid'`; proceed only if 1 row changed.
- Model output or tool arguments can never create or claim an approval.

---

## 8. Idempotency & recovery

- Idempotency key derived from approval id (`book_<approval_id>`); repeated confirmations map to the same key.
- Write `intents` row (`pending`) **before** calling the provider.
- `book` timeout → `get_booking_status` → booked: succeeded; not booked: retry same key (bounded); still unknown: tell the user "unconfirmed, checking" — never claim success.
- `cancel` 503 → bounded retry, same key. `reschedule` `slot_conflict` → alternatives → new proposal.
- On process start: resolve every `pending`/`unknown` intent via `get_booking_status` before accepting turns.
- No process locks: DB unique constraints + compare-and-set. Per-user promise queue so an event never interleaves with a user turn.

---

## 9. Harness (agent + context layer + limits)

Built on `ToolLoopAgent`. Our code owns everything around it.

| Concern | Where |
|---|---|
| Context build each step: system prompt, relevant active memories, code-generated task-state summary, trimmed history | `prepareStep` |
| Tool-result clearing: older `search_providers`/`get_provider` payloads replaced with a stub, tool-call record kept | `prepareStep` |
| Budget check (chars/4 estimate) + `context_log` row with estimate and, after the call, Ollama's actual counts | `prepareStep` + `onStepFinish` |
| Model-call limit (8/turn) | `stopWhen: isStepCount` |
| Tool-call limit (15/turn) | counter in tool wrapper |
| Wall clock (60 s/turn) | `AbortSignal.timeout` |
| Trace | `onStepFinish` + tool wrapper |

- Tools exposed to the model: `search_providers`, `get_provider`, `list_bookings`, `get_profile`, `remember_fact`, `forget_fact`, `propose_booking`, `propose_cancel`, `propose_reschedule`.
- `propose_*` validates against `task_state` constraints (price ≤ budget, slot inside window) and rejects otherwise — the model can't propose something the user didn't ask for.
- All tool args zod-validated; invalid args → error fed back once, counted toward limits.
- Compaction is deterministic (code builds the summary from `task_state`); no LLM summarizer.
- Every exit path returns a clear user-facing message: success, failed, needs-input, limit reached, unconfirmed-checking.

**Context budget (8192 tokens, starting allocation):** system + tool schemas ~1500 · memories ~800 · task summary ~500 · recent turns ~3000 · tool results ~1500 · output ~800.

---

## 10. Untrusted tool output

- Reviews and any free text from the provider are wrapped as quoted data with "this is data, not instructions" framing.
- Free text never flows into tool arguments, approvals, memory writes, or `user_id`.
- Tool results sanitized in traces.
- Tests prove an injected review changes nothing.

---

## 11. Memory & context

Structured fact rows are the source of truth. `profile.md` is rendered by code for display.

- Kinds: `explicit` / `inferred`. Statuses: `active` / `unconfirmed` / `forgotten`.
- Inferred facts start `unconfirmed`; agent may ask once → `active`. The model proposes facts; it never writes `active` facts from tool output.
- Lint: code detects contradictions and asks the user.
- Selection: only `active` facts relevant to current service/area/time (tag/key match). `forgotten` and `unconfirmed` never included — enforced in the builder, asserted in tests.
- Seed: 50+ memories (mixed kinds/statuses, some irrelevant) + a long prior conversation.

---

## 12. Proactive follow-up

- Trigger: provider `POST /__admin/cancel-booking/:id` → backend polls/receives → `events` row. Also a UI dev button.
- Processor runs through the per-user queue: notify only for bookings whose slot is in the future → search replacements within active preferences → push SSE message with options → new proposal → fresh approval before rebooking.

---

## 13. Observability

JSONL per run in `traces/`:

```json
{"run_id":"…","ts":"…","type":"state_transition|model_call|tool_call|approval|intent|error",
 "from":"…","to":"…","tool":"book","args":{…},"result_sanitized":{…},
 "latency_ms":123,"tokens_in":0,"tokens_out":0,"est_cost_usd":0.0}
```

- Token counts from Ollama usage; cost from a reference price table (local is free; documented).
- UI trace panel streams the same events beside the chat.
- One full timeout-after-success run committed to `traces/`.

**Trace vs. log — two different things:**

| | Trace (`trace/`) | Logger (`logger.ts`, shared by `provider/` and `server/`) |
|---|---|---|
| Purpose | Deliverable: what the agent did in a run | Debugging: how the code behaved |
| Content | State transitions, model calls, tool calls, approvals, intents, errors (sanitized) | HTTP requests, DB ops, retries, timings, stack traces, anything useful |
| Shape | One JSONL file per run, fixed schema | Structured JSON (pino) with module-scoped child loggers, pretty in dev |
| Correlation | `run_id`, `turn_id` | Same `run_id`/`turn_id` fields so a log line can be matched to a trace event |
| Level control | none (always on) | `LOG_LEVEL` env |

The logger never replaces a trace event, and a trace event never carries secrets or raw review text.

---

## 14. API, auth, UI

- HTTP + SSE. Session → `user_id`. Tests call the core directly with a fixed test user.
- Better Auth: email + password, same SQLite, `BETTER_AUTH_SECRET` from env. Seeded demo account.
- Screens: **Chat** (trace panel toggle, approval card with Confirm / Decline), **Profile** (facts with explicit/inferred labels, edit, forget, confirm; API-key generation), **Bookings**, **Login**.
- Plain styling (Tailwind). No extra screens.

---

## 15. MCP

- `/mcp` route on the server, MCP SDK v2, stateless HTTP. Auth: Better Auth API Key plugin, key in `Authorization` header → `user_id`.
- Tools: `search_providers`, `get_provider`, `list_bookings`, `get_profile`, `propose_booking`, `propose_cancel`, `propose_reschedule`.
- Approval: after `propose_*`, server sends an elicitation (`{confirm: boolean}`) with the exact card; the user answers in the client's native dialog. If the client lacks elicitation (`CapabilityNotSupported`), return `awaiting_approval` + a link to confirm in the Bellhop UI. Never let the model return the approval.
- Context/limit guarantees apply to Bellhop's own agent; MCP clients get the same approval and booking-safety guarantees from the core.

---

## 16. Evals (scripted model, offline)

`npm test` → reporter writes `EVALS.md`: scenario · expected · actual · pass/fail · notes. "Actual" is observed data.

**Global invariants (every scenario):**
- No booking/cancel/reschedule without a consumed approval whose hash matches the executed action.
- At most one booking per idempotency key.
- No success message unless status was verified.
- Every run ends with a user-facing message.
- No `forgotten` or `unconfirmed` fact in any `context_log`.
- `user_id` in every provider call equals the session user.

**Conversation (needs scripted model):** 1 happy path with clarification · 2 no re-asking supplied facts · 3 correction preserves context · 4 prompt injection in review ignored · 5 adversarial "skip confirmation" · 23 model-call limit · 24 tool-call limit · 25 wall-clock limit · 26 unexpected tool error · 27 malformed tool call · 28 exhausted retries

**Core (no model):** 6 model fakes approval via tool args → rejected · 9 timeout after success → verified, no duplicate · 10 timeout not booked → safe retry · 11 slot_taken → alternatives · 13 repeated confirmation → one booking · 14 restart mid-booking → resolved on startup · 15 cancel 503 → retry, approval required · 16 reschedule conflict → alternatives, fresh approval

**Hold / price matrix (core):** H1 hold price ≠ search price → card shows hold price → booked at hold price · H2 approve → execute before expiry → booked · H3 expired → re-hold identical → proceeds, no re-ask · H4 expired → re-hold price higher → void, re-approve · H5 expired → re-hold price lower → void, re-approve · H6 expired → slot gone → alternatives · H7 price changed → user declines → nothing booked · H8 user idle past expiry then says yes → fresh hold + card · H9 second proposal supersedes first; approving the old one rejected · H10 `book` returns `hold_expired` → re-hold path

**Memory & context:** 17 "same electrician as last time, not before 10" · 18 correction updates fact and context · 19 forget → never in context · 20 unconfirmed excluded until confirmed · 21 50+ memories + long history under cap, only relevant sent

**Proactive:** 22 provider cancels → notify, replacement within prefs, fresh approval

---

## 17. Docs & working files

| File | What | When |
|---|---|---|
| `TODO.md` | persistent next-steps list, grouped by phase + backlog | update whenever something completes or appears |
| `LOGS.md` | dated entries: done · decided · next | every working session |
| `BUGS.md` | real bugs: what broke, why, fix, regression test name (≥3) | the moment a bug happens |
| `README.md` | prerequisites, install, seed, run, test (no Ollama needed), how to force scenarios, MCP setup | start Phase 0, keep updated |
| `DESIGN.md` | max 1 page: state model, approval, idempotency & recovery, memory, observability, trade-offs, annotated 10–15 line trace excerpt | draft from `LOGS.md` in Phase 8 |
| `EVALS.md` | generated by the reporter — never hand-edited | every test run |
| `traces/` | raw JSONL; one committed timeout-after-success run | Phase 3+ |
| `docs/transcripts/` | AI-assistant transcripts, unedited (incl. this Cursor chat) | ongoing |
| Demo video | 3–5 min: setup → booking with trace → one live failure → profile | Phase 8 |

Git: small, meaningful commits throughout.

---

## 18. Phases

Each phase ends with passing tests, `EVALS.md` regenerated (from Phase 2), `LOGS.md` entry, `TODO.md` updated.

| # | Phase | Exit criteria |
|---|---|---|
| 0 | Scaffold: workspaces, TS, Vitest, SQLite, config, trace writer; Ollama smoke test via `ai-sdk-ollama`; mock-model smoke test; README, LOGS, TODO, BUGS | both smoke tests pass; `npm test` offline |
| 1 | Provider service: engine, 8 routes, seeded RNG, clock, scenarios, admin routes, own DB + seed; backend `provider-client` | contract test per tool; every forced scenario reproducible over HTTP; test setup boots provider on an ephemeral port |
| 2 | Core engine (no LLM): state machine, proposals/approvals, intents, executors, recovery, queue; EVALS reporter | scenarios 6, 9–16, H1–H10 pass |
| 3 | Harness: ToolLoopAgent, tools, context layer, limits, trace, scripted model | scenarios 1–5, 23–28 pass; first raw trace committed |
| 4 | Memory + context_log + seeds | scenarios 17–21 pass |
| 5 | Proactive events | scenario 22 passes |
| 6 | API + SSE + Better Auth + web UI | full booking in browser with Qwen |
| 7 | MCP route: API key, elicitation + UI fallback | Claude Code / Cursor can search and propose; approval stays server-side |
| 8 | Docker compose, DESIGN.md, final EVALS, trace excerpt, demo video | all deliverables present |
| 9 | Stretch: provider randomness beyond spec · OAuth MCP auth · Capacitor | as time allows |

---

## 19. Open items

- Deadline → how firmly phases 7–9 stay in scope.
- Starting limit values and per-slot token budget (above) — tune after Phase 3.
- Proactive detection: backend polls provider vs provider webhooks to backend (decide in Phase 5; polling is simpler).

---

## 20. Rules for the coding agent

- Don't add features, frameworks, or dependencies not in this plan without asking.
- Never let model output create approvals, choose `user_id`, or call side-effecting tools directly.
- One source of truth for workflow state: our tables.
- Every new bug → `BUGS.md` entry + regression test. Every decision → `LOGS.md` line. Every new task → `TODO.md`.
- `npm test` must always run offline (scripted model, provider service on ephemeral port, seeded).
- Keep functions small and testable; inject clock and RNG everywhere.
