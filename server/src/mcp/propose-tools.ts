import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { ServiceSchema, SlotSchema } from '@bellhop/shared/contracts';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { Principal } from '../auth/principal.js';
import type { CoreEngine } from '../core/engine.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import { describeOutcome, type ExecutionOutcome } from '../core/actions/outcomes.js';
import type { ProposeResult } from '../core/proposals/service.js';
import type { Proposal } from '../core/types.js';
import { buildProposalCard, fallbackApprovalLine } from './cards.js';

export interface RegisterProposeToolsDeps {
  server: McpServer;
  engine: CoreEngine;
  principal: Principal;
  queue: UserQueue;
  webOrigin: string;
  logger: Logger;
}

/** Long enough for any `newId(...)` value, short enough to stop a client wasting storage/log space. */
const ID_MAX_LEN = 128;
const idSchema = z.string().min(1).max(ID_MAX_LEN);

/**
 * The model never supplies `user_id`, `approval_id`, or `hash` (invariant 2):
 * every propose/decline input schema below is `.strict()`, so any of those
 * keys in the model's arguments fails validation (`isError`) instead of
 * being silently accepted. `user_id` on the wire is always `principal.userId`.
 *
 * No `provider_name` here either (gate fix item 5): a client/model-supplied
 * display string could mislabel the real provider on the approval card, so
 * the server derives it instead of trusting the tool caller's text.
 */
const ProposeBookingToolInputSchema = z
  .object({
    provider_id: idSchema,
    service: ServiceSchema,
    slot: SlotSchema,
  })
  .strict();
type ProposeBookingToolInput = z.infer<typeof ProposeBookingToolInputSchema>;

const ProposeCancelToolInputSchema = z
  .object({
    booking_id: idSchema,
  })
  .strict();

const ProposeRescheduleToolInputSchema = z
  .object({
    booking_id: idSchema,
    slot: SlotSchema,
  })
  .strict();

const DeclineProposalInputSchema = z.object({ proposal_id: idSchema }).strict();

const CONFIRM_SCHEMA = {
  type: 'object' as const,
  properties: {
    confirm: { type: 'boolean' as const, title: 'Confirm this booking?' },
  },
  required: ['confirm'],
};

/** Plan §7 gate fix item 3: bounds how long a `propose_*` call can sit waiting on a human, outside any queue. */
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

function proposeFailureResult(result: Extract<ProposeResult, { ok: false }>, log: Logger): CallToolResult {
  log.warn({ code: result.code }, 'propose rejected');
  return { isError: true, content: [{ type: 'text', text: `${result.code}: ${result.message}` }] };
}

function outcomeResult(outcome: ExecutionOutcome): CallToolResult {
  return {
    content: [{ type: 'text', text: describeOutcome(outcome) }],
    structuredContent: { outcome: outcome as unknown as Record<string, unknown> },
  };
}

type ApproveOutcome =
  | { kind: 'stale' }
  | { kind: 'approve_failed'; reason: string }
  | { kind: 'executed'; outcome: ExecutionOutcome };

/**
 * Builds the MCP `propose_*` / `list_proposals` / `decline_proposal` tools
 * and the elicitation-based approval step around each `propose_*` call
 * (plan §7, §13, Phase 7 row of §18). No `approve`/`confirm` tool is ever
 * registered: the only way an approval row is created from MCP is the
 * elicitation response handled entirely in here.
 *
 * Plan §8 ("nothing for one user interleaves") + gate fix item 3 ("never
 * hold the user's queue while a human thinks"): creating the proposal and
 * approving+executing it each run inside their own short `queue.run`, but
 * `elicitInput` itself — which can take as long as a human takes to answer —
 * runs with the queue released, so a `list_proposals`/event for the same
 * user is never blocked behind an open approval card.
 */
export function registerProposeTools(deps: RegisterProposeToolsDeps): void {
  const { server, engine, principal, queue, webOrigin, logger } = deps;
  const log = childLogger(logger, 'mcp-propose', { userId: principal.userId });
  const userId = principal.userId;

  /** Leaves the proposal pending and points the client at the web fallback (plan §7 — no elicitation support, or elicitation failed/timed out). */
  function pendingResult(proposal: Proposal, prefix?: string): CallToolResult {
    const text = [prefix, buildProposalCard(proposal), fallbackApprovalLine(webOrigin, proposal.id)]
      .filter((part): part is string => part !== undefined)
      .join('\n\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: { proposal_id: proposal.id, status: 'pending' },
    };
  }

  async function declineResult(proposal: Proposal): Promise<CallToolResult> {
    const result = engine.proposals.decline(userId, proposal.id);
    if (!result.ok) {
      log.warn({ proposalId: proposal.id, code: result.code }, 'decline after elicitation failed');
      return { isError: true, content: [{ type: 'text', text: `${result.code}: ${result.message}` }] };
    }
    return { content: [{ type: 'text', text: 'Declined: nothing was changed.' }] };
  }

  /** True only if the proposal is still exactly as the user was shown — not superseded, declined, or hold-expired while the elicitation was in flight. */
  function isStillApprovable(proposalId: string): boolean {
    const latest = engine.proposals.listPending(userId).find((p) => p.id === proposalId);
    return latest !== undefined && !latest.expired;
  }

  /** Approve + execute, scoped to its own short queue turn (gate fix item 3) — never the same turn that ran the (possibly minutes-long) elicitation. */
  async function approveAndExecute(proposal: Proposal): Promise<ApproveOutcome> {
    return queue.run(userId, 'mcp:approve', async () => {
      if (!isStillApprovable(proposal.id)) {
        return { kind: 'stale' };
      }
      const approved = engine.approvals.approve(userId, {
        proposal_id: proposal.id,
        hash: proposal.hash,
        source: 'mcp_elicitation',
      });
      if (!approved.ok) {
        return { kind: 'approve_failed', reason: approved.reason };
      }
      const outcome = await engine.executor.execute(userId, approved.approval.id);
      return { kind: 'executed', outcome };
    });
  }

  /** `allowReapprovalRetry`: the plan asks again once on a price change; a second one stops and falls back (no third elicitation). */
  async function elicitAndAct(proposal: Proposal, allowReapprovalRetry: boolean): Promise<CallToolResult> {
    let response: ElicitResult;
    try {
      response = await server.server.elicitInput(
        { message: buildProposalCard(proposal), requestedSchema: CONFIRM_SCHEMA },
        { timeout: ELICITATION_TIMEOUT_MS },
      );
    } catch (err) {
      log.warn({ err, proposalId: proposal.id }, 'elicitation failed or timed out; leaving proposal pending');
      return pendingResult(proposal);
    }

    const confirmed = response.action === 'accept' && response.content?.confirm === true;
    if (!confirmed) {
      return queue.run(userId, 'mcp:decline', () => declineResult(proposal));
    }

    const result = await approveAndExecute(proposal);
    if (result.kind === 'stale') {
      log.warn({ proposalId: proposal.id }, 'proposal no longer pending when elicitation resolved');
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'This proposal was declined, superseded, or its hold expired while waiting for your confirmation. Nothing was approved.',
          },
        ],
      };
    }
    if (result.kind === 'approve_failed') {
      log.warn({ proposalId: proposal.id, reason: result.reason }, 'approve after elicitation failed');
      return { isError: true, content: [{ type: 'text', text: `approval rejected: ${result.reason}` }] };
    }

    // Only `'executed'` remains after the two guards above.
    const { outcome } = result;
    if (outcome.kind === 'needs_reapproval') {
      if (!allowReapprovalRetry) return pendingResult(outcome.proposal, describeOutcome(outcome));
      return elicitAndAct(outcome.proposal, false);
    }
    return outcomeResult(outcome);
  }

  /** Entry point for every `propose_*` tool once a proposal exists: elicit if the client supports it, else fall back to the web link. */
  async function approvalStep(proposal: Proposal): Promise<CallToolResult> {
    const supportsElicitation = Boolean(server.server.getClientCapabilities()?.elicitation);
    if (!supportsElicitation) return pendingResult(proposal);
    return elicitAndAct(proposal, true);
  }

  /** Creates the proposal inside its own short queue turn, then — with the queue released — runs the (possibly long) approval step. */
  async function proposeAndApprove(proposeCall: () => Promise<ProposeResult>): Promise<CallToolResult> {
    const result = await queue.run(userId, 'mcp:propose', proposeCall);
    if (!result.ok) return proposeFailureResult(result, log);
    return approvalStep(result.proposal);
  }

  server.registerTool(
    'propose_booking',
    {
      description:
        'Propose booking a provider slot. Holds the slot and shows the user an approval card; the model never books directly — a human must approve.',
      inputSchema: ProposeBookingToolInputSchema,
    },
    async (input: ProposeBookingToolInput) =>
      proposeAndApprove(() =>
        engine.proposals.proposeBooking(userId, {
          provider_id: input.provider_id,
          // The core service still requires a non-empty provider_name; the
          // gate fix drops it from this tool's input (a model-supplied
          // display string could mislabel the real provider), so the
          // service name stands in as a harmless placeholder until the core
          // delegate's change makes the field optional-and-ignored.
          provider_name: input.service,
          service: input.service,
          slot: input.slot,
        }),
      ),
  );

  server.registerTool(
    'propose_cancel',
    {
      description:
        'Propose cancelling one of the authenticated user\'s own bookings. Shows an approval card; the model never cancels directly.',
      inputSchema: ProposeCancelToolInputSchema,
    },
    async (input) => proposeAndApprove(() => engine.proposals.proposeCancel(userId, input)),
  );

  server.registerTool(
    'propose_reschedule',
    {
      description:
        "Propose moving one of the authenticated user's own bookings to a new slot. Shows an approval card; the model never reschedules directly.",
      inputSchema: ProposeRescheduleToolInputSchema,
    },
    async (input) => proposeAndApprove(() => engine.proposals.proposeReschedule(userId, input)),
  );

  server.registerTool(
    'list_proposals',
    {
      description: "List the authenticated user's own pending proposals (id, action, provider, slot, price, hold expiry).",
    },
    async () => {
      const pending = engine.proposals.listPending(userId);
      const text =
        pending.length === 0
          ? 'No pending proposals.'
          : pending
              .map(
                (p) =>
                  `${p.id}: ${p.action} ${p.provider_name} — ${p.slot.start} — ${p.price} ${p.currency}${
                    p.expired ? ' (hold expired)' : ''
                  }`,
              )
              .join('\n');
      return { content: [{ type: 'text', text }], structuredContent: { proposals: pending } };
    },
  );

  server.registerTool(
    'decline_proposal',
    {
      description: "Decline one of the authenticated user's own pending proposals.",
      inputSchema: DeclineProposalInputSchema,
    },
    async (input) =>
      queue.run(userId, 'mcp:decline_proposal', async () => {
        const result = engine.proposals.decline(userId, input.proposal_id);
        if (!result.ok) {
          log.warn({ proposalId: input.proposal_id, code: result.code }, 'decline_proposal rejected');
          return { isError: true, content: [{ type: 'text', text: `${result.code}: ${result.message}` }] };
        }
        return {
          content: [{ type: 'text', text: 'Declined.' }],
          structuredContent: { proposal_id: result.proposal.id, status: result.proposal.status },
        };
      }),
  );
}
