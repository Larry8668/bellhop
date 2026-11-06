import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { Principal } from '../auth/principal.js';
import type { CoreEngine } from '../core/engine.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import { describeOutcome, type ExecutionOutcome } from '../core/actions/outcomes.js';
import {
  ProposeBookingInputSchema,
  ProposeCancelInputSchema,
  ProposeRescheduleInputSchema,
  type ProposeResult,
} from '../core/proposals/service.js';
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

/**
 * The model never supplies `user_id`, `approval_id`, or `hash` (invariant 2):
 * every propose/decline input schema below is `.strict()`, so any of those
 * keys in the model's arguments fails validation (`isError`) instead of
 * being silently accepted. `user_id` on the wire is always `principal.userId`.
 */
const StrictProposeBookingInputSchema = ProposeBookingInputSchema.strict();
const StrictProposeCancelInputSchema = ProposeCancelInputSchema.strict();
const StrictProposeRescheduleInputSchema = ProposeRescheduleInputSchema.strict();
const DeclineProposalInputSchema = z.strictObject({ proposal_id: z.string().min(1) });

const CONFIRM_SCHEMA = {
  type: 'object' as const,
  properties: {
    confirm: { type: 'boolean' as const, title: 'Confirm this booking?' },
  },
  required: ['confirm'],
};

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

/**
 * Builds the MCP `propose_*` / `list_proposals` / `decline_proposal` tools
 * and the elicitation-based approval step that runs inside each `propose_*`
 * call (plan §7, §13, Phase 7 row of §18). No `approve`/`confirm` tool is
 * ever registered: the only way an approval row is created from MCP is the
 * elicitation response handled entirely in here.
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

  /** `allowReapprovalRetry`: the plan asks again once on a price change; a second one stops and falls back (no third elicitation). */
  async function elicitAndAct(proposal: Proposal, allowReapprovalRetry: boolean): Promise<CallToolResult> {
    let response: ElicitResult;
    try {
      response = await server.server.elicitInput({
        message: buildProposalCard(proposal),
        requestedSchema: CONFIRM_SCHEMA,
      });
    } catch (err) {
      log.warn({ err, proposalId: proposal.id }, 'elicitation failed or timed out; leaving proposal pending');
      return pendingResult(proposal);
    }

    const confirmed = response.action === 'accept' && response.content?.confirm === true;
    if (!confirmed) return declineResult(proposal);

    const approved = engine.approvals.approve(userId, {
      proposal_id: proposal.id,
      hash: proposal.hash,
      source: 'mcp_elicitation',
    });
    if (!approved.ok) {
      log.warn({ proposalId: proposal.id, reason: approved.reason }, 'approve after elicitation failed');
      return { isError: true, content: [{ type: 'text', text: `approval rejected: ${approved.reason}` }] };
    }

    const outcome = await engine.executor.execute(userId, approved.approval.id);
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

  async function runPropose(result: ProposeResult): Promise<CallToolResult> {
    if (!result.ok) return proposeFailureResult(result, log);
    return approvalStep(result.proposal);
  }

  server.registerTool(
    'propose_booking',
    {
      description:
        'Propose booking a provider slot. Holds the slot and shows the user an approval card; the model never books directly — a human must approve.',
      inputSchema: StrictProposeBookingInputSchema,
    },
    async (input) =>
      queue.run(userId, 'mcp:propose', async () => runPropose(await engine.proposals.proposeBooking(userId, input))),
  );

  server.registerTool(
    'propose_cancel',
    {
      description:
        'Propose cancelling one of the authenticated user\'s own bookings. Shows an approval card; the model never cancels directly.',
      inputSchema: StrictProposeCancelInputSchema,
    },
    async (input) =>
      queue.run(userId, 'mcp:propose', async () => runPropose(await engine.proposals.proposeCancel(userId, input))),
  );

  server.registerTool(
    'propose_reschedule',
    {
      description:
        "Propose moving one of the authenticated user's own bookings to a new slot. Shows an approval card; the model never reschedules directly.",
      inputSchema: StrictProposeRescheduleInputSchema,
    },
    async (input) =>
      queue.run(userId, 'mcp:propose', async () => runPropose(await engine.proposals.proposeReschedule(userId, input))),
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
    async (input) => {
      const result = engine.proposals.decline(userId, input.proposal_id);
      if (!result.ok) {
        log.warn({ proposalId: input.proposal_id, code: result.code }, 'decline_proposal rejected');
        return { isError: true, content: [{ type: 'text', text: `${result.code}: ${result.message}` }] };
      }
      return {
        content: [{ type: 'text', text: 'Declined.' }],
        structuredContent: { proposal_id: result.proposal.id, status: result.proposal.status },
      };
    },
  );
}
