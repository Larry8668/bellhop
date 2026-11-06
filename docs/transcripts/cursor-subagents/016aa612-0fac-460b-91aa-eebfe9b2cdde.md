# Bellhop — Cursor session 016aa612

- **Source session id:** 016aa612-0fac-460b-91aa-eebfe9b2cdde
- **Tool:** Cursor agent transcript (Bellhop project)
- **Date range:** Saturday, Nov 7, 2026, 12:22 AM (UTC+5:30)
- **Turns exported:** 12

> **Note:** exported unedited except for redactions marked [REDACTED: …]. Tool calls are shown as one-line summaries; tool results are not present in the source transcript.

---

## User

<timestamp>Saturday, Nov 7, 2026, 12:22 AM (UTC+5:30)</timestamp>
<user_query>
Repository: /Users/leharadityakumar/project/bellhopper
You are acting as the 'review-security' role. Follow AGENTS.md and .cursor/rules/*.mdc.

You are the attacker. You review a diff looking for ways to break Bellhop's guarantees. You are read-only; you report, you do not fix. Be brief: this review runs in parallel with two others and must finish in minutes. Only probe surfaces the diff actually touches.

Read `docs/bellhopper-plan.md` §2 (core rules), §7 (approval), §8 (idempotency), §10 (untrusted output), §15 (MCP) first. Then scope to the diff you are given.

Attack surfaces to probe, with the question to answer for each:
1. Approval bypass: can model output, tool arguments, an MCP tool result, or a replayed request create/claim/consume an approval? Is the hash recomputed from the real hold before execution? Is consume a compare-and-set?
2. Duplicate side effects: can a double click, a retry, a restart, or a concurrent event cause two `book`/`cancel`/`reschedule` calls under different idempotency keys?
3. Identity: is `user_id` ever taken from a request body, tool argument, or model output instead of the session/API key? Can one user read or act on another's proposals, bookings, memories?
4. Prompt injection: does any free text from the provider (reviews, names, attributes) reach tool arguments, memory writes, approvals, or the system prompt unwrapped?
5. Secrets and PII: `BETTER_AUTH_SECRET`, API keys, session tokens, raw review text in logs, traces, error messages, or responses.
6. Input validation: zod missing at an HTTP/MCP boundary; unbounded sizes; SQL built by string concatenation.
7. Admin surface: provider `/__admin` reachable without the env gate; dev endpoints exposed in non-dev config.

Output format, nothing else:

```
VERDICT: APPROVE | REQUEST_CHANGES
BLOCKERS (exploitable now):
- [path:line] attack — concrete steps to exploit — fix
MAJOR (exploitable with another weakness):
- ...
MINOR / hardening:
- ...
```

Limits: at most 5 BLOCKERS, 5 MAJOR, 3 MINOR. Every finding must include the concrete sequence that exploits it, in one or two lines. If you cannot construct one, downgrade it to MINOR. If a category has no findings, write `none`.

# Task

RE-REVIEW of the Phase 2 gate fixes only. You previously raised on PR #31: BLOCKER — API key could call POST /api/proposals/:id/approve (and /decline, POST /api/proposals), letting the coding agent that holds the MCP key self-approve; MAJOR — card provider_name/service from model args, not hashed (spoofable); MAJOR — restart recovery marked a not_booked book intent failed and asked for a fresh approval (double-booking path); MAJOR — create/decline not queued; MINOR — trace runId from client header; MINOR — pending→approved not CAS; MINOR — no .max() bounds. The fixes are the diff `git diff bab88ad...HEAD` (branch feat/phase-2-core; the file /tmp/gate-fix.diff has the same content). Verify each finding is closed, with file:line evidence, and look for any NEW hole the fixes introduced (e.g. requireSession bypass via cookie forgery or a session principal reachable with an API key; the elicitation-outside-queue window — can a web decline or supersede race the MCP approve into booking something the user no longer sees; same-key restart retry — can it book after the user changed their mind). Output the standard VERDICT / BLOCKERS / MAJOR / MINOR format, scoped to this diff.
</user_query>

## Assistant

I need to be efficient, so I'll go straight to reading the diff.

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && git diff bab88ad...HEAD --stat && wc -l /tmp/gate-fix.diff`

## Assistant

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && git diff bab88ad...HEAD -- server/src web/src`

## Assistant

> **tool:** `Read` — `/Users/leharadityakumar/.cursor/projects/Users-leharadityakumar-project-bellhopper/agent-tools/8b400f92-c323-45a2-8065-4fff39138192.txt`

## Assistant

I'm checking how resolvePrincipal decides the `via` value, and whether a request carrying both a cookie and a bearer token can count as a session. Next I want to confirm whether the provider name is part of the hash, and look at proposeFromHold and hash.ts. The last item is the same-key retry case, where the approval was already consumed and the intent still exists, so the user can't simply decline it.

I'm weighing a retry risk: if the executor timed out and marked a booking unknown, then the user may have booked a different slot in the meantime, so a later restart could re-book the old intent with the same key and create a duplicate. I'm checking whether the hold TTL would make the provider reject that first, and whether plan §8 covers it.

Now I'm checking whether recovery only runs at startup, since the retry path calls `ctx.intents.attempt(key)` without a compare-and-set. I'm also looking at whether the elicitation gate holds up: a web approve or decline that lands first should make the MCP accept stale, and the re-elicitation after a price change should behave the same way.

I'm wondering whether the MCP elicitation path is open to anyone holding the API key, since a client could open a session, declare elicitation support, and accept its own confirmation. That would sidestep the session check I was trying to enforce, so I want to see whether plan §15 already accepts elicitation as the approval channel.

I'm checking whether the provider name from get_provider gets into the hash, and whether it could reach the model unescaped through pendingResult or the card. I also want to confirm what plan §7 and §15 say about elicitation being an accepted approval channel, since that determines whether this is a design note or a bigger issue.

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && cat server/src/auth/principal.ts; sed -n 1,80p server/src/core/approvals/hash.ts; grep -n "hash\|proposeFromHold" server/src/core/proposals/service.ts …`

> **tool:** `Grep` — `/Users/leharadityakumar/project/bellhopper/docs/bellhopper-plan.md`

## Assistant

The hash doesn't cover the service field, but service is derived from the provider, so that's fine. Session precedence checks the cookie first, and an API-key caller without a cookie falls through to api_key; forging a cookie would need BETTER_AUTH_SECRET. Now I'm wondering whether the session-only routes have any CSRF protection.

I'm checking whether the cookie-based POST routes are exposed to cross-site requests. Hono's `c.req.json()` parses the body regardless of content-type, so a text/plain form could reach it, but the attacker would also need the hash and proposal ID, and better-auth's default SameSite=lax keeps the cookie off cross-site POSTs, so this looks minor. The bigger concern is that MCP elicitation is reachable with an API key, so I'll read plan §7, §8, and §15 next.

> **tool:** `Read` — `/Users/leharadityakumar/project/bellhopper/docs/bellhopper-plan.md`

> **tool:** `Read` — `/Users/leharadityakumar/project/bellhopper/docs/bellhopper-plan.md`

## Assistant

I'm weighing whether the elicitation-based approval is a plan-level accepted risk, since the plan explicitly treats it as a valid approval channel. But it cuts against the stated rationale of the requireSession fix: anyone holding the MCP key could run their own client, hit /mcp with the elicitation capability, and answer with confirm:true. I'm considering whether to flag this as MAJOR, depending on whether the threat model includes a coding agent reading the key and calling curl directly.

I'm treating the elicitation route as a sanctioned approval channel, but it still breaks the requireSession fix: anyone holding the MCP key could run their own client, call /mcp with the elicitation capability, and answer with confirm:true. That's the same attack through a different door, and it isn't introduced by the fix, so I'll flag it as MAJOR needing a user decision rather than a blocker, since the plan sanctions it. Next, I'm checking the recovery path: a same-key retry against the old hold_id either books if the hold is still valid or fails with hold_expired.

I'm checking the state machine to see whether a new booking can be proposed while the intent is unknown, since a restart could then book both. I also want the provider's hold TTL, and I'm confirming that recovery reusing the approved hold_id doesn't need a fresh price check, because the hold's quoted price is fixed.

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && rg -n "VERIFYING|FAILED|DONE" server/src/core/state/machine.ts | head -30; rg -n "canEnterProposed" -A8 server/src/core/proposals/service.ts | head -20…`

## Assistant

I'm checking whether the new fix opens a double-booking path: a book that timed out leaves the booking unknown, the user can propose and approve a new one, and then a hold TTL restart could let recovery rebook under the old key. I'm weighing that against the earlier behavior, where recovery just marked things failed and required re-approval, and the same-key retry the earlier review asked for.

Recovery retrying the booking under the same key could still land a second booking if the user has already moved on, since the provider dedupes by key but an in-flight request from before the restart might still be processing. Settling the task state doesn't stop the booking call itself, so I'm flagging this as a major concern.

Now I'm checking whether a book that timed out can get rebooked under its old key during recovery, after the user has already approved a different slot. Settling the task state doesn't stop the booking call, so I'm flagging the fix as a major issue: check whether the user has moved on before retrying, and if so, don't retry. I also want to confirm that the new proposal only supersedes pending proposals, not ones already approved.

I'm checking the elicitation path: the hash is taken from the proposal at creation, and approval verifies the stored hash, so a re-hold can't slip a different booking through. The race between a web decline and an MCP approve looks closed by the queue, the pending check, and the compare-and-set. I still need to see whether any other route creates approvals outside the session check, such as a chat turn that treats a typed "yes" as confirmation.

I still need to check whether the turn route also accepts an API key, since a typed "yes" there could create an approval without the session check.

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && rg -n "app\.(get|post|put|patch|delete)\(" server/src/api server/src/mcp server/src/*.ts; rg -n "typed|confirm" server/src/core --glob '*.ts' -l; rg -n…`

## Assistant

I'm noting that the /api/keys POST route with requireUser isn't in this diff and wouldn't grant approval anyway, so I'll skip it as pre-existing. Next, the card's provider name now comes from the provider's free text through get_provider, flowing into buildProposalCard and back to the model in the pending result. That free text reaches the model unwrapped in the tool result, whereas before the name came from the model, so I want to check cards.ts.

I'm checking whether cards.ts wraps the provider's free text before it reaches the model, since that text used to come from the model and now passes through unwrapped.

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && sed -n 1,60p server/src/mcp/cards.ts`

## Assistant

I'm looking at whether provider.name, which is free text the provider controls, could carry newlines that forge extra card lines like a fake price, so the user might read a misleading figure first. It's minor-to-major and the name also reaches the model unwrapped, so I'll add some hardening.

I'm checking whether the control-character stripping and length cap are enough, since the provider mock still sits on the §10 trust boundary. I'm also noting that the provider_name placeholder is passed but ignored, so the comments are stale, though that's a quality issue rather than a security one. Last, I want to see whether the request ID forwarded from the client header gets validated before it reaches the provider.

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && cat server/src/api/middleware/request-id.ts; rg -n "requestId" server/src/provider-client/client.ts | head`

## Assistant

I've confirmed the transaction boundary in the executor claim: the approvals consume step sits inside it, so that part holds. Failure handling looks fine too, since a spent approval marks the task failed while the intent stays pending for recovery. I'm now checking whether a re-hold during the same-key recovery could change the proposal's hold id.

I'm checking the task-failure path for the recovery retry. If the old hold has expired, the provider returns a non-transient error and the task fails, which is a safe outcome with no double booking. There's an edge case where a late first attempt lands with the new hold, but I'm setting that aside. Now I'm weighing whether to call the elicitation self-approval a blocker, and I'm leaning toward a major finding that needs a plan decision, since §15 designates elicitation as the approval.

I'm deciding whether the MCP elicitation self-approval counts as a blocker or a major. Since it's exploitable with an API key, it could be a blocker, but the plan explicitly makes elicitation the approval path, so it's really a plan-level trust decision and I'd flag it as major for the user to rule on. The recovery double-book case is also a major, since it needs a restart after the timeout and a rebooking. I'm leaning toward APPROVE, since there are no blockers, and I'll note a config flag as one option for the elicitation issue.

> **tool:** `Shell` — `cd /Users/leharadityakumar/project/bellhopper && rg -n "async function resolveBook|ctx.intents.attempt|settleTaskState\(ctx|IN_FLIGHT.has" server/src/core/recovery/resolve-intents.ts; rg -n "setStatus…`

## Assistant

```
VERDICT: APPROVE
BLOCKERS (exploitable now):
none

MAJOR (exploitable with another weakness):
- [server/src/core/recovery/resolve-intents.ts:119-145, 68] Recovery retries the booking with the same key even after the user has moved on. Exploit: the book call times out, so the intent becomes unknown and task state is VERIFYING. The state machine allows VERIFYING→PROPOSED (server/src/core/state/machine.ts:25), so the user proposes, approves and books a different slot under a new key. If the server restarts inside the 10-minute hold TTL, `resolveBook` books the old approved hold too. The user now has two bookings and was never asked again. `settleTaskState` sees "task moved on" (line 68), but only after the provider call (line 138). Fix: check the current task state before the retry. If it is not in-flight, or a newer proposal or approval exists for the user, do not book. Leave the intent unknown or failed and tell the user. Alternatively, block PROPOSED while an unresolved book intent exists.
- [server/src/mcp/propose-tools.ts:166-171; server/src/api/middleware/require-session.ts:20] The earlier "agent self-approves" blocker is closed on REST but still open through MCP elicitation. Exploit: the coding agent reads the MCP API key from client config. It opens its own `/mcp` session that declares the elicitation capability, calls `propose_booking`, and answers the elicitation with `{action:"accept", content:{confirm:true}}`. That creates the approval and books. Plan §15 makes elicitation an approval channel, so code alone can't close this; it needs your decision. Options: a config flag that forces web confirmation (the fallback link) for API-key principals, or accept the risk and document it.

MINOR / hardening:
- [server/src/core/proposals/service.ts:242; server/src/mcp/cards.ts:21] The card's provider name now comes from `get_provider`. That fixes model spoofing, but this provider free text reaches the card and the model-visible tool result unwrapped and unbounded. Exploit: a provider named `X\nPrice: 10 USD` puts a fake price line on the card above the real one. Fix: strip control characters and newlines from name and service, and cap their length, before persisting.
- [server/src/api/app.ts:56, server/src/mcp/propose-tools.ts:1286] Both callers still pass `provider_name: service`, and the comments say core still requires it. Core now ignores that field (service.ts:26-33), so this is harmless but misleading. Drop the field and the comments.
- [server/src/api/app.ts:201,250,317] The session-only routes depend on Better Auth's SameSite cookie default for CSRF protection, and `c.req.json()` does not check Content-Type. Cross-site exploitation is not practical, because an attacker needs the unguessable proposal id and hash. Hardening: require `application/json` or check the Origin header.

Prior findings — closure evidence:
- BLOCKER (API key → approve/decline/create): CLOSED for REST. require-session.ts:20 rejects any principal that is not a session, and is applied at app.ts:201, 250 and 317. principal.ts checks the cookie first, and a valid session cannot be forged without BETTER_AUTH_SECRET. The MCP path is still open (MAJOR above).
- MAJOR (card name/service from model args): CLOSED. service.ts:242 takes both from `get_provider`. A mismatched `service` is rejected. The tool and HTTP schemas no longer accept `provider_name`. The hash is unchanged per plan §7, and the display fields are now server-derived.
- MAJOR (restart marked not_booked failed, then re-approval): CLOSED per plan §8. Recovery now retries once with the same key and the approved hold. This introduced the new "moved-on" hole above.
- MAJOR (create/decline not queued): CLOSED. See app.ts:209 and 323, and propose-tools.ts:168, 207 and 284.
- Elicitation outside the queue: SAFE. Approve and execute run in one queue turn (propose-tools.ts:136). That turn re-checks the proposal is still pending and unexpired (line 137), and `approve` is compare-and-set (approvals/service.ts:107). A decline, supersede or web approve that lands while the elicitation is open makes the MCP accept come back "stale", and nothing is approved.
- MINOR (trace runId from client header): CLOSED. The id is server-minted at api/engine.ts:29 and mcp/app.ts:125. The forwarded `x-request-id` is validated by `parseIncomingRequestId`.
- MINOR (pending→approved not CAS): CLOSED at approvals/service.ts:107. Consume and intent creation are also now one transaction (executor.ts:124).
- MINOR (no .max() bounds): CLOSED. `idSchema` caps ids at 128 characters and the hash must be 64 hex characters (schemas/proposals.ts:13-16, propose-tools.ts:24).
```
