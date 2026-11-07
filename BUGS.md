# BUGS

Real bugs hit while building. Logged the moment they happen. Each entry: what broke, why, the fix, and the regression test that now guards it. Tooling-only issues (hooks, scripts) live in `LOGS.md`, not here.

Format:

```
## <short title>  —  <date>, Phase <n>
**What broke:**
**Why:**
**Fix:**  (commit / PR)
**Regression test:** `<test file> › <test name>`
```

---

## 1. Web dev server answered `/api/*` with `index.html`  —  2026-11-06, Phase 1
**What broke:** Every API call from the web UI failed with `Invalid JSON (me)`. The browser's `/api/me` came back `200 text/html` (then `304` once cached) instead of the backend's JSON; the backend on `:4000` was fine.
**Why:** `vite.config.ts` set `base: './'` (relative asset paths for the later Capacitor build). Under Vite 8 a relative base makes the dev server skip `server.proxy`, so `/api/*` fell through to the SPA fallback. Verified by starting the same config with `--base /`, which proxied correctly.
**Fix:** `base` is `'./'` only when `command === 'build'`; dev keeps `/`. Config is exported as a function so it can be unit-tested. (`fix/vite-dev-proxy`)
**Regression test:** `web/src/test/vite-config.test.ts › uses an absolute base in dev so the /api proxy applies`

## 2. MCP API key stopped working after ~10 calls  —  2026-11-06, Phase 1
**What broke:** Cursor connected to `/mcp` with a valid bearer key, then started getting 401s and showed an "authenticate" prompt that led nowhere (a 401 makes MCP clients attempt OAuth discovery, which we don't offer).
**Why:** `@better-auth/api-key` enables a per-key rate limit by default: 10 verifications per 24 h, copied onto each key row at creation (`rateLimitEnabled=1, rateLimitMax=10`). Every MCP request verifies the key, so the 11th request got `RATE_LIMITED` → `verifyApiKey` invalid → 401. The server log had the 429 from the plugin; nothing was logged at the HTTP layer because a rejected key is just an unauthenticated request.
**Fix:** `apiKey({ rateLimit: { enabled: false } })` for new keys; migration `server/db/migrations/0002_apikey_no_rate_limit.sql` clears the flag on existing keys. Request limits, if ever needed, belong at the HTTP edge, not on the credential.
**Regression test:** `server/test/auth/principal.test.ts › keeps resolving an API key well past 10 verifications` (fails at verification #11 without the fix)

## 3. Second errand refused after the first one finished  —  2026-11-06, Phase 2
**What broke:** Live check: after one booking reached `DONE`, every new `POST /api/proposals` (and MCP `propose_*`) returned `invalid_state: cannot propose from state DONE`. The user could never book twice.
**Why:** `DONE` only allows `→ GATHERING` (plan §6: a new request starts a new errand), and `proposeBooking` checked `canTransition(state, 'PROPOSED')` directly. Every engine test passed because the shared helper `bookThroughExecutor` quietly forced `GATHERING` after each booking — a setup step that hid the exact behaviour the live path needs.
**Fix:** proposal creation from a terminal state (`DONE`, `FAILED`, `LIMIT_EXCEEDED`) takes `→ GATHERING → PROPOSED` inside the same transaction; the helpers no longer force the transition. (`fix/phase-2-new-errand-after-done`)
**Regression test:** `server/test/core/proposals/service.test.ts › a new proposal after DONE starts a new errand: DONE → GATHERING → PROPOSED`

## 4. Model never knew the current date  —  2026-11-07, Phase 3
**What broke:** Live run with a local Qwen model: it asked users for ISO dates, could not resolve "tomorrow afternoon", and `update_task` rejected `"tomorrow"` as a window value.
**Why:** The system prompt carried no clock. A small model cannot guess today's date, so relative phrases had no anchor.
**Fix:** `formatNow(now)` in `context.ts` appends an IST "Current time" line plus day-part rules (morning/afternoon/evening) to the instructions; the agent passes `deps.clock.now()`.
**Regression test:** `server/test/harness/context.test.ts › formatNow converts UTC to IST across midnight (weekday and date roll forward)` and `› adds the IST current time and day-part rules to instructions only when now is passed`

## 5. Near-miss tool calls rejected by strict schemas  —  2026-11-07, Phase 3
**What broke:** The model passed the provider *name* as `provider_id`, and datetimes without seconds (`2026-11-08T12:00+05:30`), so `propose_booking` failed zod validation repeatedly.
**Why:** Small local models approximate the shape of IDs and ISO strings; the schemas are strict by design.
**Fix:** `server/src/harness/repair.ts` (`repairToolInput`, `repairToolCallFor`, `rememberSearchResults`) wired as the ToolLoopAgent `repairToolCall`: adds `:00` seconds and resolves a name to the id from that user's last search. Nothing else is rewritten.
**Regression test:** `server/test/harness/repair.test.ts` (all tests) and `server/test/scenarios/conversation.test.ts › repairs a provider name and datetimes without seconds in propose_booking`

## 6. Task stuck in SEARCHING; proposals claimed without a card  —  2026-11-07, Phase 3
**What broke:** After a search errored mid-turn (or a turn was cut short) the task stayed in `SEARCHING` and `propose_booking` failed with `invalid_state: cannot propose from state SEARCHING` on every retry. Separately the model sometimes replied "I'll propose ..., confirm on the card" without calling `propose_booking`, so the user saw no card.
**Why:** Proposals are legal only from `COMPARING`, and nothing moved the task out of `SEARCHING` once results had been shown. Nothing checked a proposal claim against the tool calls actually made.
**Fix:** `propose_booking` first moves `SEARCHING -> COMPARING`. The agent nudges the model once when `PROPOSAL_CLAIM` matches with no proposal, and otherwise replaces the claim with `NO_CARD_REPLY`.
**Regression test:** `server/test/scenarios/conversation.test.ts › propose_booking recovers a task stuck in SEARCHING (SEARCHING -> COMPARING -> PROPOSED)`, `› nudges once when the model claims a proposal without calling the tool`, `› replaces a proposal claim with the honest no-card reply when the model never calls the tool`
