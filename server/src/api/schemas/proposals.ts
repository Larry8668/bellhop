import {
  ServiceSchema,
  SlotSchema,
  type Service,
  type Slot,
} from '@bellhop/shared/contracts';
import { z } from 'zod';
import { ExecutionOutcomeSchema } from '../../core/actions/outcomes.js';
import { ProposalSchema, TaskStateSchema } from '../../core/types.js';

/** Request body for `POST /api/proposals` — strict: rejects e.g. `user_id` (invariant 2). */
export const PostProposalBodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('book'),
      provider_id: z.string().min(1),
      provider_name: z.string().min(1),
      service: ServiceSchema,
      slot: SlotSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      booking_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('reschedule'),
      booking_id: z.string().min(1),
      slot: SlotSchema,
    })
    .strict(),
]);
export type PostProposalBody = z.infer<typeof PostProposalBodySchema>;

export const ApproveProposalBodySchema = z
  .object({
    hash: z.string().min(1),
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
  provider_name: string;
  service: Service;
  slot: Slot;
};
export type CancelProposalInput = { booking_id: string };
export type RescheduleProposalInput = { booking_id: string; slot: Slot };
