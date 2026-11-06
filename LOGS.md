# LOGS

Dated working log: what was done, what was decided, what's next. Complements `BUGS.md` (bugs) and `TODO.md` (open items).

## 2026-11-06 — Planning

**Done**
- Private repo created and renamed to `Larry8668/bellhop`; `docs/internal/` gitignored.
- Environment checked: Node 24.9, Ollama 0.40.3, `qwen3.5:9b` and `qwen3:8b` pulled. Both return clean tool calls on the Phase 0 smoke prompt; `qwen3:8b` stuffs budget/time constraints into `date_range`, `qwen3.5:9b` does not.
- Package versions checked: `ai` 7.0.x, `ai-sdk-ollama` 4.x, `better-auth` 1.7.x, `better-sqlite3` 13.x, `vitest` 5.x, `zod` 4.x.
- Plan rewritten to v2 (`docs/bellhopper-plan.md`); `TODO.md` and `LOGS.md` created.

**Decided**
- Drop Mastra. Its workflow snapshots would be a second source of truth next to our `proposals`/`approvals`/`intents` tables. AI SDK v7 `ToolLoopAgent` + `prepareStep` + `MockLanguageModelV4` cover the loop, the context hook, and offline evals.
- "Harness" = `prepareStep` context layer + limits + trace around `ToolLoopAgent`. Compaction is code-generated from `task_state`, no LLM summarizer.
- `ai-sdk-ollama` `reliableToolCalling` off so every model call is visible to limits and trace.
- Provider tools run as a separate mock HTTP service (`provider/`) with seeded RNG, injectable clock, own SQLite and admin endpoints to force scenarios. Backend talks to it only over HTTP; tests boot it on an ephemeral port.
- `propose_*` validates against `task_state` constraints (budget, window) because the fixed `search_providers` contract has no fields for them.
- Approval hash uses the hold's quoted price. Any price change after approval (up or down) voids approval. A re-hold with identical price/slot proceeds without re-asking.
- Approval sources: Confirm button (primary), typed yes checked by code when exactly one unexpired proposal is pending (config flag, default on), MCP elicitation.
- MCP: `/mcp` route on the server, API Key plugin for auth; elicitation for approval with fallback to confirm-in-UI link. Model never returns the approval. OAuth via `@better-auth/mcp` is a stretch.
- Better Auth stays (email + password) for user segregation; needed for MCP anyway.
- Monorepo with npm workspaces; docker-compose runs provider + server + web; Ollama stays on host (no Metal in Docker on Mac).
- `LOGS.md` replaces the draft plan's `NOTES.md`. Root-level deliverable files; `docs/` for plan and transcripts.
- Plan v2 signed off.
- Separate structured logger (pino) alongside the trace writer; trace is the deliverable, logs are for debugging, correlated by `run_id`/`turn_id`.

**Dev setup (PR #1)**
- `.cursor/agents/`: `implementer` + `test-writer` (composer-2.5), review panel `review-quality` (sonnet-5), `review-security` (codex-5.3-high), `review-correctness` (grok-4.7-medium), reviewers read-only + background.
- `.cursor/rules/`: `workflow.mdc` (plan strong / execute small, review panel before PR, git + docs discipline) and `coding-standards.mdc` (invariants + style), both always-apply.
- Husky: pre-commit lint, commit-msg commitlint (conventional), pre-push blocks direct pushes to `main` (`ALLOW_MAIN_PUSH=1` escape hatch). `scripts/run-ws.mjs` runs scripts only in workspaces that exist.
- GitHub Actions CI (lint, typecheck, test) on PRs and `main`; not a required check.
- GitHub branch protection / rulesets unavailable: private repo on Free plan returns 403 (needs Pro or a public repo). Local pre-push hook is the guard for now.
- Headless CLI probe (`agent -p --trust --model …`): composer-2.5, grok-4.7-low, claude-sonnet-5-thinking-high, claude-opus-5-5-low, gpt-5.3-codex-low all respond in 10–12 s. Custom `.cursor/agents` are not visible to the IDE Task tool mid-session; verify on next turn.

**Delegation via CLI (PR #3)**
- Default delegation channel is the headless Cursor CLI: `scripts/delegate.sh <role> <model> "<brief>"`; `scripts/review-panel.sh "<task>"` runs the three reviewers in parallel with the diff inlined. IDE Task-tool subagents are the fallback.
- Model per task by complexity: composer-2.5 / grok-4.7-medium (mechanical), claude-sonnet-5-thinking-high (multi-file logic), claude-opus-5-5-medium (core guarantees). No GPT models (dated).
- Reviewers capped at 5/5/3 findings and run in `--mode ask` (CLI-enforced read-only) with the diff inlined inside an untrusted-data fence.
- Panel timing on this branch (two runs): claude-opus-5-5-medium 44–46 s; grok-4.7-high 430–490 s; grok-4.7-medium 369–429 s, with or without shell access. Grok 4.7 is the bottleneck. Pins now: quality claude-opus-5-5-medium, security claude-opus-5-5-medium, correctness claude-sonnet-5-thinking-high. Grok available via `REVIEW_MODEL_*` overrides.
- IDE Task-tool subagents ignore the frontmatter `model:` pin on this plan: a role pinned to grok-4.7-medium reported running as the parent model (Claude Fable 5.1). Model selection only works through the CLI (`--model`), which is why the CLI is the default channel.
- **Panel policy: milestone gates only** (end of Phases 2, 3, 6, 7, or on request), not per PR. Non-gate PRs say "panel: skipped (not a gate)".
- Panel findings fixed in this PR: reviewer failures were swallowed; `--readonly` was prompt-only (now `--mode ask`, fail-closed on frontmatter); role name path injection; non-unique transcript names; no cleanup trap; truncation pipeline SIGPIPE; dirty-tree not detected; reviewers could be steered by `VERDICT:` text in the diff (now fenced + warned).
- `.cursor/cli.json` denies `git push/commit/merge`, `gh`, `docs/internal/**`, `.env*` to CLI delegates; deny rules survive `--force` but are prefix-based and bypassable (`git -C`, `sh -c`), so writer delegates additionally run with git/gh credentials stripped from the environment (verified: `git -C . push` and `sh -c 'git push'` both fail auth; `gh` blocked) and `.husky`/`.cursor`/`core.hooksPath` are checked after each run. Parent owns git; main is PR-only (`AGENTS.md`).

**Phase 0 — scaffold (PR #7, stacked from #5, #6)**
- Stacked flow used for the first time: integration branch `feat/phase-0-scaffold`; wave 1 (root tooling + `shared`) ran alone because it owns the lockfile; wave 2 ran `server` and `provider` in parallel CLI worktrees (`scripts/delegate.sh … --worktree=<name>`), each merged by PR into the phase branch, then one PR to `main`. Lockfile edits were disjoint; rebase was clean.
- Delegate timings: wave 1 composer-2.5 250 s; wave 2 claude-sonnet-5-thinking-high 85 s, composer-2.5 86 s.
- `@bellhop/shared` is consumed via `dist/` (NodeNext `exports`); root `prepare` builds it after install so `npm ci` in CI and fresh clones resolve it. Source-path exports were rejected because they fight `rootDir` in the consuming workspaces' typecheck.
- `web/` left out of workspaces until Phase 6 (no point carrying an empty Vite app through the core phases).
- Ollama smoke verified: `qwen3.5:9b` via `ai-sdk-ollama` 4.x returns a well-formed `search_providers` call for the plan's sample prompt (374 in / 57 out tokens, ~2 s). `ai` v7 exports `stepCountIs`, not `isStepCount`.
- `trace/types.ts` uses a distributive `Omit` so `emit()` keeps the discriminated union narrow.
- 20 tests across the three workspaces; lint/typecheck clean from root.

**Phase 1 — provider service + test surfaces (PR #15, stacked from #8–#14)**
- Contracts first: the 8 tool input/output schemas, error codes → HTTP status map, admin schemas and the `TOOL_CONTRACTS` registry live in `@bellhop/shared/contracts`. Provider routes, the backend client and the MCP tools are all generated from the same registry, so a contract change fails typecheck in every consumer.
- `user_id` travels to the provider in an `x-user-id` header on every tool call (the fixed contracts have no user field except `list_bookings`); holds and bookings are owned by that user, cross-user reads return not_booked/not_found rather than leaking.
- Simulated timeout = the engine decides (and may write the booking), the HTTP layer sleeps `TIMEOUT_DELAY_MS` then answers 504. Backend timeout (`PROVIDER_TIMEOUT_MS` 5 s) < provider delay (8 s) in dev; tests set 50 ms / 100 ms via `startTestProvider`.
- Idempotency records only definitive outcomes (success, slot_taken, slot_conflict). 503s and not-booked timeouts are not recorded, so a retry with the same key proceeds; a booked timeout is recorded, so the retry replays the booking.
- Scenario queue is FIFO per tool: `take(tool)` consumes the first queued outcome that applies to that tool; `RANDOM` clears. Lets a test queue `PRICE_CHANGES_ON_HOLD, TIMEOUT_BOOKED` and drive hold then book.
- Pulled Better Auth, the API shell, the web scaffold and the read-only MCP route forward from Phases 6/7 on request, so there is something to click and an MCP surface to point Cursor/Claude at. The agent, approvals and `propose_*` tools remain Phase 2–3 work.
- Verified at install time (plan's "re-verify APIs" rule): Better Auth 1.7.18 accepts a raw better-sqlite3 instance and `(await auth.$context).runMigrations()`; the API-key plugin is a separate `@better-auth/api-key` package in 1.7; MCP SDK is 1.32 (there is no v2); `@hono/mcp` 0.3.5 provides `StreamableHTTPTransport` that takes a Hono context.
- Web: the delegate pulled pino into the browser via `@bellhop/shared/logger` plus a `process` shim; replaced with a 30-line browser logger with the same `(fields, msg)` shape. Web pins Vite 8 so Vitest 5 and the plugins resolve one Vite (removed an `as any` on the plugin array).
- Stacked flow at 4 parallel worktrees worked; two lockfile conflicts resolved by taking the base lockfile and re-running `npm install`. `gh pr merge --delete-branch` from inside a worktree fails to delete the local branch (the base is checked out elsewhere) — merge from the main checkout by PR number and delete remote branches explicitly.
- Delegate timings this phase: composer-2.5 93 s (contracts), 166 s (client), 477 s (web); claude-sonnet-5-thinking-high 1084 s (engine), 1236 s (auth), 932 s (http), 840 s (root), 999 s (mcp).
- Live check: provider + server + web + `seed:demo`; sign-in, API key, `/api/me` via cookie and key, booking visible in `/api/bookings`, MCP `tools/list` + `search_providers` + `list_bookings` through the real provider with a forged `user_id` argument ignored; 401 without auth.

**Follow-ups (PRs #17, #18)**
- BUGS #1: `base: './'` in `vite.config.ts` disables `server.proxy` under Vite 8 dev, so the UI got `index.html` for `/api/*`. Relative base is now build-only; config exported as a function with a regression test.
- Migrations: user asked for alembic-style DB versioning. Chose plain SQL files (`NNNN_name.sql`, dbmate-compatible up/down sections) with a ~150-line runner in `@bellhop/shared/migrate` over an external tool: no Python/binary, works on `:memory:` in tests, and the format can be handed to dbmate later unchanged. Better Auth's tables are compiled into `server/db/migrations/0001_auth.sql` by `better-auth/db/migration` (`getMigrations().compileMigrations()`), guarded by a drift test. Per workspace: `db:migrate|rollback|status|seed|reset`; boot still auto-applies. Phase 2 core tables go in as `0002_core.sql`.
- `.cursor/mcp.json` is gitignored (holds a personal API key).
- BUGS #2 (PR #20): `@better-auth/api-key` rate-limits each key to 10 verifications / 24 h by default and every MCP request verifies the key, so Cursor's MCP client got 401 after ~10 calls and fell into an OAuth flow. Disabled on the plugin; migration `0002_apikey_no_rate_limit.sql` clears the flag on existing keys.
- PR #21: `db:stamp <version>` records migrations as applied without running them, for databases created before the runner existed (the live dev DBs). Both live DBs stamped at `0001`.

**Phase 2 — core engine (branch `feat/phase-2-core`, gate phase)**
- Wave 1 (PR #22, claude-sonnet-5-thinking-high, 765 s): `0003_core.sql` (not `0002`, already taken by the api-key fix — the delegate caught the collision), zod domain types, one prepared-statement repo per table with every user-owned query filtered on `user_id`, `proposalHash` over canonical JSON, state machine with the §6 transition table persisted to `task_state` and traced. Repos take explicit timestamps rather than reading a clock (invariant: no `Date.now()` in core).
- Wave 2 (parallel worktrees): `p2-engine` claude-opus-5-5-medium — proposal/approval/intent services + book/cancel/reschedule executors; `p2-infra` claude-sonnet-5-thinking-high — per-user queue, startup intent recovery, EVALS reporter, core test harness; `p2-reqid` composer-2.5 — `x-request-id` propagated server → provider and logged on both sides (a server log line and the provider call it caused were only matchable by timestamp).
- Process trap: the first wave-2 launch put all three `delegate.sh` runs behind `&` inside one shell call; the harness killed the process group when that call returned, so each delegate died after creating its worktree (transcripts were one line). Lost ~2 h. Rule: one background shell call per delegate, never `&` inside a call that returns.
- Decided: `GATHERING → PROPOSED` is a legal transition (cancel/reschedule don't search; plan §6 says they share the PROPOSED → DONE path).
- Decided: on boot, a `pending` book intent whose key the provider reports `not_booked` is marked `failed` and the user is asked to confirm again; the engine never re-books from a restart because the approval was for a moment that has passed.
- Decided: executors emit `tool_call` trace events themselves (hold/book/cancel/reschedule/status never pass through the LLM tool wrapper).

- Wave 2 merged (PRs #23, #24, #25): engine claude-opus-5-5-medium 827 s, infra claude-sonnet-5-thinking-high 1005 s, request-id composer-2.5 297 s. Parent fixes: `as unknown as Hono` casts replaced by a typed `RequestIdEnv`; a 40 ms client timeout in the engine test harness misclassified a 503 as a timeout under a parallel full run (now 300/800 ms); `createCoreEngine` facade (PR #26) so API/MCP/agent compose the engine in one place; recovery wired into boot.
- Trap: a `.d.ts` containing `declare module 'vitest'` without an `import`/`export` is a global script and *replaces* vitest's module instead of augmenting it (every vitest export vanished repo-wide). `export {}` fixes it; noted in `server/test/helpers/evals-meta.d.ts`.
- Wave 3 merged (PRs #27–#30): scenarios claude-sonnet-5-thinking-high 1210 s, MCP claude-sonnet-5-thinking-high 2014 s, API composer-2.5 444 s, web composer-2.5 371 s. Parent fixes: the API's repeated-Confirm replay now requires the submitted hash to equal the existing approval's hash (the delegate replayed on any hash) and uses `approvalsRepo.getLatestForProposal` instead of raw SQL in the route; MCP returns 404 for an unknown `Mcp-Session-Id` (spec) instead of starting an orphan server.
- Decided: `/mcp` keeps one `McpServer` + transport per `Mcp-Session-Id`, bound to the authenticated principal (mismatch → 401, 1000 cap, 30 min idle sweep). Elicitation is a server→client request answered in a *later* HTTP POST, so a per-request server can never receive the answer. Nothing business-level lives in the session; the plan's "stateless" intent (no second source of truth) holds.
- Decided: the API exposes `POST /api/proposals` as a dev/test surface for creating proposals without the agent; the Chat page will use it until Phase 3 replaces it.
- Decided: `not_booked` after the last retry ends as `unconfirmed`, not `failed` — the last `book` attempt timed out, so a real provider could still land it; recovery on next boot settles it.
- Scenario-id discipline: unit tests must not carry `S##`/`H#` prefixes unless they follow plan §16 numbering; the scenario suite under `server/test/scenarios/` is the only EVALS source.
- Live check on the phase branch: boot applied `0003_core`, recovery ran, `POST /api/proposals` → wrong hash 409 → approve → `booked` → second approve `replayed: true`; trace file shows approval created/consumed → intent pending → EXECUTING → `book` → succeeded → VERIFYING → DONE; `x-request-id` matches the server line to the provider line.

**Gate review — Phase 2 (PR #31), panel 404 s total (quality 31 s, security 129 s, correctness 404 s; all `claude-opus-5-5-medium`/sonnet per role files). All three: REQUEST_CHANGES.**
- BLOCKER (security): `POST /api/proposals/:id/approve` accepted an API key; the coding agent driving MCP can read `.cursor/mcp.json` and curl an approval into existence. Fix: `requireSession` on every proposal mutation (approvals come only from a browser session or MCP elicitation).
- BLOCKER (correctness): `approvals.consume` and `intents.begin` were two statements; a crash between them strands a consumed approval with no intent row that recovery cannot see. Fix: one transaction.
- MAJOR fixed: card `provider_name`/`service` came from model args and were not hashed (spoofable) → resolved from `get_provider`, dropped from external schemas; restart recovery marked a `not_booked` book intent `failed` and asked for a fresh approval → could double-book if the timed-out attempt landed late; now retries once with the *same* key, else `failed`, never re-asks; proposal create/decline not queued; elicitation held the user's queue while the human thought; engine calls did not forward `x-request-id`; trace run ids were minted from a client header; recovery bypassed `IntentService` and read `user_id` from the provider payload; `pending → approved` was not a compare-and-set.
- Deferred to `TODO.md`: shared request-id middleware, `approveOrReplay` in core, per-user proposal rate limit.
- Panel diff was truncated at 120 k chars (112 files) — next gates should run on smaller PRs or with `BASE=<last gate tag>`.

**Gate re-review (security + correctness on the fix diff): both APPROVE, two follow-ups fixed before merge.**
- Trace could record `approval consumed` for a transaction that then rolled back (consume emitted to disk before `intents.begin` threw). `TraceWriter.atomic(fn)` now buffers events raised inside the claim transaction and drops them on throw. Test: `executor.test.ts` "intents.begin throws" asserts no consumed/intent trace rows.
- Restart retry of a `not_booked` book intent ignored whether the user had moved on. `resolve-intents` now refuses the same-key retry when the task is no longer in flight or a newer approval exists (`approvals.getLatestForUser`) and fails the intent `superseded`. Decision: a stale pre-crash approval is never acted on behind the user's back; the existing test that expected a booking in that case was wrong and is replaced by two tests.

**Next**
- Merge #31 into `main`, tag `gate-phase-2`.
- Phase 3: harness (ToolLoopAgent, tools incl. `propose_*` validation against `task_state`, context layer, limits, per-turn trace), scenarios 1–5, 23–28.

## 2026-11-07 — Phase 5 proactive

**Done**
- Scenario 22: the backend polls upcoming confirmed bookings, records one `provider_cancelled` event when the provider has cancelled, and proposes a replacement that still needs a fresh approval.

**Decided**
- Proactive detection is polling, not webhooks (plan §19). Simpler: no inbound endpoint, and the provider admin cancel is already the way tests force scenario 22.
- Status is read with `list_bookings` (one call per user, bounded). `get_booking_status` keys on hold id or idempotency key, which the app booking row does not store.
- Replacement search uses the cancelled provider's area (`get_provider`) and the booking's service, over the next 14 days (the seed's slot horizon). The cancelling provider is excluded. Prefs: `not_before` (`HH:MM` IST) and `max_price` (whole rupees); unknown keys ignored. Best = lowest price, then earliest slot, then highest rating. `proposeBooking` holds a slot and opens a pending card — nothing is booked until the user approves. A slot that is no longer in the future is marked processed with no message.
- The UI dev button that forces a cancel stays with the Phase 6 screens. Tests cancel through the provider admin client.

**Next**
- Wire `notify` to the SSE stream when the API layer lands (Phase 6). The assistant message is already the record.
## 2026-11-07 — Phase 4 memory store

**Done**
- `0004_memory.sql`: `memories` and `context_log` (plan §5, §11).
- `server/src/memory`: user-scoped facts. Explicit remember is active and overwrites the active value for that key; inferred starts unconfirmed. Selection is active facts only — matching service/area tags, `general`, untagged prefs, or a key match — newest first, capped at 800 tokens (chars/4). Lint flags two active facts with the same key and different values. `profile.md` is rendered from the rows.
- `/api/facts`: GET (session or API key) returns non-forgotten `{id,key,value,kind,status}`. PATCH, forget, and confirm require a browser session. An unknown id or another user's id is 404. Editing a fact makes it explicit and active.
- Demo seed: 54 memories (plumber, electrician, `ac_servicing`, Indiranagar, plus irrelevant and forgotten/unconfirmed) and a 40-message prior conversation. Idempotent.
- Scenarios S18 (value correction), S19 (forget), S20 (unconfirmed), S21 (cap + relevance), plus a lint test. `@bellhop/server` typecheck, lint, and tests pass (287).

**Decided**
- Tag service ids are the provider's. `ac_servicing` is the real id; `ac_service` does not match it.
- A service or area tag constrains the fact only when the turn has that dimension. `general` and untagged prefs are included unless a tag conflicts. `logContext` refuses ids that are not active for that user. A `context_log` row written while a fact was active is left in place if the user later forgets it — the row is a record of what was sent.
- Editing a forgotten fact (PATCH) makes it explicit and active again. Confirm does not resurrect a forgotten fact.
- The plan's `memories.source` column is not stored. Kind, status, and tags cover what this phase selects and displays.

**Next**
- Harness wires `selectForContext`, `remember`, and `logContext` into `prepareStep` (scenario 17, and the conversation half of 18).
## 2026-11-07 — Phase 3 harness

**Done**
- `server/src/harness/`: `ToolLoopAgent` turn (`runTurn`), Ollama model factory (think off, temperature 0, `num_ctx` 8192, `keep_alive` 10m, `reliableToolCalling` false), tool wrappers, and `prepareStep` context (system rules, active memories, task-state summary, trimmed history, stale search/get results stubbed, chars/4 budget, `memory.logContext`).
- Tools close over the caller's `userId`. `propose_booking` rejects a slot outside the task window before holding, and declines a hold whose price is over budget. `update_task` writes gathering constraints. Model-written facts are `inferred`. No tool creates an approval or calls `book` / `cancel` / `reschedule`.
- Typed yes (`yes`, `confirm`, `book it`, `go ahead`, …) with exactly one live pending proposal is approved in code (`source: 'typed'`) and executed; the reply is `describeOutcome`. The model is not called on that path.
- Limits: `stepCountIs(modelCalls)`, per-turn tool counter (invalid args count), `AbortSignal.timeout(wallClockMs)`, tool retries of `1 + retriesPerTool`. Every exit has a user-facing message. Model text that claims a booking is replaced unless the outcome came from the executor.
- Scenarios S01–S05 and S23–S28, plus context and typed-yes tests. Example trace: `traces/examples/s01-happy-path.jsonl`.

**Decided**
- Tool retries live in the wrapper and consume one tool-call slot per model invocation; the agent's `maxRetries` is 0 so a model HTTP retry is not a second counted call.
- A typed "yes" with no pending proposal falls through to the model (it may answer a clarifying question). An expired hold, or more than one live proposal, is answered in code and the model is not called.
- Message timestamps sequence off the previous row when the injected clock does not move, so history stays ordered without advancing hold expiry.
- Plan §1's typed-yes config flag is not wired; the path is always on. A later wave can gate it. API/MCP/web are untouched.
