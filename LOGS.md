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

**Next**
- Phase 2: core engine (schema, state machine, proposals/approvals with hash + CAS, intents, executors, recovery, per-user queue, EVALS reporter). Gate review at the end.
