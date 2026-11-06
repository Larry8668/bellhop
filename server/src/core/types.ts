import { z } from 'zod';
import {
  BookingStatusSchema,
  CurrencySchema,
  IsoDateTimeSchema,
  PriceSchema,
  ServiceSchema,
  SlotSchema,
} from '@bellhop/shared/contracts';

/** zod enums + inferred types for every CHECK-constrained column in `0003_core.sql` (plan §5, §6, §7, §8). */

export const ActionSchema = z.enum(['book', 'cancel', 'reschedule']);
export type Action = z.infer<typeof ActionSchema>;

export const TaskStateNameSchema = z.enum([
  'GATHERING',
  'SEARCHING',
  'COMPARING',
  'PROPOSED',
  'APPROVED',
  'EXECUTING',
  'VERIFYING',
  'DONE',
  'FAILED',
  'LIMIT_EXCEEDED',
]);
export type TaskStateName = z.infer<typeof TaskStateNameSchema>;

export const ProposalStatusSchema = z.enum(['pending', 'superseded', 'declined', 'expired', 'approved']);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ApprovalStatusSchema = z.enum(['valid', 'consumed', 'void']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSourceSchema = z.enum(['button', 'typed', 'mcp_elicitation']);
export type ApprovalSource = z.infer<typeof ApprovalSourceSchema>;

export const IntentStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'unknown']);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** Free-form per-user preferences ("same electrician as last time", not before 10am…). Phase 4 gives it structure. */
export const TaskStatePrefsSchema = z.record(z.string(), z.unknown());
export type TaskStatePrefs = z.infer<typeof TaskStatePrefsSchema>;

// --- Domain object schemas (row↔domain mapping lives in server/src/core/repo/**) ---

export const ConversationSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversation_id: z.string().min(1),
  user_id: z.string().min(1),
  role: MessageRoleSchema,
  text: z.string(),
  proposal_id: z.string().nullable(),
  created_at: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const TaskStateSchema = z.object({
  user_id: z.string().min(1),
  conversation_id: z.string().nullable(),
  state: TaskStateNameSchema,
  service: ServiceSchema.nullable(),
  area: z.string().nullable(),
  window_from: IsoDateTimeSchema.nullable(),
  window_to: IsoDateTimeSchema.nullable(),
  budget: PriceSchema.nullable(),
  prefs: TaskStatePrefsSchema,
  run_id: z.string().nullable(),
  updated_at: IsoDateTimeSchema,
});
export type TaskState = z.infer<typeof TaskStateSchema>;

/** `slot` is the `Slot` object from `@bellhop/shared/contracts`, not the two `slot_start`/`slot_end` columns. */
export const ProposalSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  action: ActionSchema,
  provider_id: z.string().min(1),
  provider_name: z.string().min(1),
  service: ServiceSchema,
  slot: SlotSchema,
  price: PriceSchema,
  currency: CurrencySchema,
  booking_id: z.string().nullable(),
  hold_id: z.string().nullable(),
  hold_expires_at: IsoDateTimeSchema.nullable(),
  hash: z.string().min(1),
  status: ProposalStatusSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  proposal_id: z.string().min(1),
  user_id: z.string().min(1),
  hash: z.string().min(1),
  status: ApprovalStatusSchema,
  source: ApprovalSourceSchema,
  created_at: IsoDateTimeSchema,
  consumed_at: IsoDateTimeSchema.nullable(),
  void_reason: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const IntentSchema = z.object({
  idempotency_key: z.string().min(1),
  approval_id: z.string().min(1),
  user_id: z.string().min(1),
  action: ActionSchema,
  status: IntentStatusSchema,
  result: z.unknown().nullable(),
  attempts: z.number().int().nonnegative(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Intent = z.infer<typeof IntentSchema>;

/** App-side view of a provider booking (plan §5) — `server/src/provider-client`'s `Booking` is the provider's own source of truth. */
export const AppBookingSchema = z.object({
  booking_id: z.string().min(1),
  user_id: z.string().min(1),
  provider_id: z.string().min(1),
  provider_name: z.string().min(1),
  service: ServiceSchema,
  slot: SlotSchema,
  price: PriceSchema,
  currency: CurrencySchema,
  status: BookingStatusSchema,
  synced_at: IsoDateTimeSchema,
});
export type AppBooking = z.infer<typeof AppBookingSchema>;

export const AppEventSchema = z.object({
  id: z.number().int().nonnegative(),
  user_id: z.string().min(1),
  type: z.string().min(1),
  booking_id: z.string().nullable(),
  payload: z.unknown(),
  processed: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type AppEvent = z.infer<typeof AppEventSchema>;
