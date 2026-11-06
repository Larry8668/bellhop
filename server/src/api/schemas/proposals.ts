import {
  ServiceSchema,
  SlotSchema,
  type Service,
  type Slot,
} from '@bellhop/shared/contracts';
import { z } from 'zod';
import { ExecutionOutcomeSchema } from '../../core/actions/outcomes.js';
import { ProposalSchema, TaskStateSchema } from '../../core/types.js';

/** Shared bounds for ids on the wire (plan §7/§15 gate fixes): long enough for any `newId(...)` value, short enough to stop a client wasting storage/log space. */
const ID_MAX_LEN = 128;
const idSchema = z.string().min(1).max(ID_MAX_LEN);

/** `proposalHash` is always a sha256 hex digest (`server/src/core/approvals/hash.ts`) — exactly 64 lowercase hex characters, never free text. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const hashSchema = z.string().regex(HASH_PATTERN, 'hash must be a 64-character hex sha256 digest');

/**
 * Request body for `POST /api/proposals` — strict: rejects e.g. `user_id`
 * (invariant 2). No `provider_name`: a client-supplied display string could
 * mislabel the real provider on the approval card, so the server derives it
 * (plan §7 gate fixes item 5) rather than trusting the caller's text.
 */
export const PostProposalBodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('book'),
      provider_id: idSchema,
      service: ServiceSchema,
      slot: SlotSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      booking_id: idSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('reschedule'),
      booking_id: idSchema,
      slot: SlotSchema,
    })
    .strict(),
]);
export type PostProposalBody = z.infer<typeof PostProposalBodySchema>;

export const ApproveProposalBodySchema = z
  .object({
    hash: hashSchema,
  })
  .strict();
export type ApproveProposalBody = z.infer<typeof ApproveProposalBodySchema>;

export const GetTaskResponseSchema = z.object({
  task: TaskStateSchema.nullable(),
});
export type GetTaskResponse = z.infer<typeof GetTaskResponseSchema>;

export const PendingProposalSchema = ProposalSchema.extend({
  expired: z.boolean(),
});
export type PendingProposal = z.infer<typeof PendingProposalSchema>;

export const GetProposalsResponseSchema = z.object({
  proposals: z.array(PendingProposalSchema),
});
export type GetProposalsResponse = z.infer<typeof GetProposalsResponseSchema>;

export const PostProposalSuccessSchema = z.object({
  proposal: ProposalSchema,
});
export type PostProposalSuccess = z.infer<typeof PostProposalSuccessSchema>;

export const ProposalErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const ApproveSuccessResponseSchema = z.object({
  outcome: ExecutionOutcomeSchema,
  message: z.string(),
});
export type ApproveSuccessResponse = z.infer<typeof ApproveSuccessResponseSchema>;

export const DeclineSuccessSchema = z.object({
  ok: z.literal(true),
});
export type DeclineSuccess = z.infer<typeof DeclineSuccessSchema>;

/** Narrow input types for `propose*` calls (no `action` field). */
export type BookProposalInput = {
  provider_id: string;
  service: Service;
  slot: Slot;
};
export type CancelProposalInput = { booking_id: string };
export type RescheduleProposalInput = { booking_id: string; slot: Slot };
