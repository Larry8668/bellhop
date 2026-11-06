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
