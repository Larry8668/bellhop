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
