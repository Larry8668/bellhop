# Bellhop — design (1 page)

Bellhop is an errand agent that never books without your say-so. The model can only call read-only tools and `propose_*`. It never calls `book`, `cancel` or `reschedule`. Those run in core code, and only after the user has approved.

## State model
- There is one current errand per user, stored in `task_state`: `GATHERING → SEARCHING → COMPARING → PROPOSED → APPROVED → EXECUTING → VERIFYING → DONE | FAILED | LIMIT_EXCEEDED`. Every transition is persisted and traced.
- Our own tables are the only workflow state: `task_state`, `proposals`, `approvals`, `intents`. There are no framework snapshots. That is why we chose AI SDK v7 `ToolLoopAgent` and dropped Mastra.
- Each user has one promise queue, shared by the HTTP API, the MCP route and the proactive processor. A user's actions therefore never interleave.

## Approval
- A proposal is hashed over canonical JSON, using the provider's hold price rather than the search price. Provider name and service come from `get_provider`, never from model arguments.
- Only the user can create an approval, in one of three ways: the Confirm button (a browser session; an API key is not enough), a typed "yes" that code checks when exactly one unexpired proposal is pending, or MCP elicitation. Consuming the approval is a compare-and-set, and it runs in the same transaction that writes the intent.
- Any price change after approval voids it. A re-hold at the same price and slot proceeds without asking again. A second proposal supersedes the first, and approving the old card is rejected.

## Idempotency & recovery
- The intent row is written before any side effect, with key `<action>_<approval_id>`. If a booking call times out, the engine checks status first, then retries with the same key a bounded number of times, and otherwise reports `unconfirmed`. It never claims success without a verified status.
- On boot, every `pending`/`unknown` intent is resolved before the server accepts a turn. If the user has moved on (a newer approval exists, or the task is no longer in flight), the stale approval is never acted on.

## Harness & context
- `prepareStep` builds every step's context in code: a short system prompt; the relevant **active** memories; a task summary generated from `task_state`; trimmed history. Older `search_providers`/`get_provider` payloads are replaced with stubs. There is no LLM summarizer.
- Limits: 8 model calls per turn (`stepCountIs`), 15 tool calls, a 120 s wall clock (`AbortSignal.timeout`; local model calls take 13–27 s each). Every exit path ends with a user-facing message.
- Provider free text such as reviews is fenced as untrusted data. It never flows into tool arguments, approvals, memory writes or `user_id`.

## Memory
- Memories are structured fact rows: kind `explicit`/`inferred`, status `active`/`unconfirmed`/`forgotten`. A fact the model infers starts as `unconfirmed`. The selector includes only `active` facts whose service/area tags match, and caps them at about 800 tokens. Each step's choice is written to `context_log` and asserted in tests.

## Proactive
- The backend polls the provider for booking status. A provider-side cancellation becomes an `events` row. The processor, running through the user's queue, finds a replacement that fits the user's preferences and creates a **new proposal**. Rebooking needs a fresh approval.

## Observability
- Each run writes one JSONL trace (`traces/`): state transitions, model calls (tokens, latency, cost from a reference table, which is 0 for local models), tool calls, approvals, intents and errors, all sanitized. Pino logs are separate debugging output, correlated by `run_id` and `x-request-id`.

## Trade-offs
- SQLite plus an in-process queue: simple, and correct for a single node, but it doesn't scale horizontally.
- Polling instead of webhooks for proactive follow-up: easier to test with an injected clock, at the cost of latency.
- Deterministic compaction loses nuance an LLM summary might keep, but it is reproducible and testable offline.
- The MCP route keeps a session per `Mcp-Session-Id`, because an elicitation answer arrives in a later POST. No business state lives in that session.

## Trace excerpt: timeout after success
Raw file: `traces/examples/timeout-after-success.jsonl`. Live run: the provider was forced to `TIMEOUT_BOOKED`, meaning it books the slot and then answers 504 after 8 s, while the server's client times out at 5 s. Fields are trimmed here.

```
00:19:42.566 state_transition PROPOSED→APPROVED  "approved via button"     ① the user clicked Confirm (approval row; the hash matched the card)
00:19:42.567 approval  created / consumed  appr_4a28…                       ② consumed by compare-and-set, in the same transaction as ③
00:19:42.572 intent    pending  key=book_appr_4a28…                          ③ intent written BEFORE the side effect
00:19:42.574 state_transition APPROVED→EXECUTING
00:19:47.581 tool_call book  hold_6  → timeout (5006 ms, timed_out:true)      ④ outcome unknown; the provider may have booked
00:19:47.583 state_transition EXECUTING→VERIFYING  "book timed out"           ⑤ no blind retry
00:19:47.603 tool_call get_booking_status key=book_appr_4a28… → booked bk_1   ⑥ ask the source of truth with the same key
00:19:47.605 intent    succeeded                                              ⑦ recorded once; a retry would replay this
00:19:47.609 state_transition VERIFYING→DONE  "book verified"                 ⑧ success is reported only now
```
