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

**Next**
- Verify custom subagents + model pins from the IDE on a fresh turn, then Phase 0.
