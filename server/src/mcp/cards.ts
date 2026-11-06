import type { Slot } from '@bellhop/shared/contracts';
import type { Proposal } from '../core/types.js';

const ACTION_LABEL: Record<Proposal['action'], string> = {
  book: 'Book',
  cancel: 'Cancel',
  reschedule: 'Reschedule',
};

function slotText(slot: Slot): string {
  return `${slot.start} → ${slot.end}`;
}

/**
 * Plain-text approval card for a proposal (plan §7: action, provider, slot,
 * price + currency, hold expiry, proposal id). Never includes provider
 * review text — only our own structured proposal fields.
 */
export function buildProposalCard(proposal: Proposal): string {
  const lines = [
    `${ACTION_LABEL[proposal.action]}: ${proposal.provider_name} (${proposal.service})`,
    `Slot: ${slotText(proposal.slot)}`,
    `Price: ${proposal.price} ${proposal.currency}`,
  ];
  if (proposal.hold_expires_at !== null) {
    lines.push(`Hold expires: ${proposal.hold_expires_at}`);
  }
  lines.push(`Proposal id: ${proposal.id}`);
  return lines.join('\n');
}

/** Non-elicitation fallback (plan §7, Phase 7 row of §18): the web route confirms this proposal. */
export function fallbackApprovalLine(webOrigin: string, proposalId: string): string {
  return `Approve in Bellhop: ${webOrigin}/proposals/${proposalId}`;
}
