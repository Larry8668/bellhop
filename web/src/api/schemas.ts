import { z } from 'zod';

export const proposalActionSchema = z.enum(['book', 'cancel', 'reschedule']);

/** Full proposal row from `GET /api/proposals` / `POST /api/proposals`. */
export const proposalDetailSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  action: proposalActionSchema,
  provider_id: z.string(),
  provider_name: z.string(),
  service: z.string(),
  slot: z.object({
    start: z.string(),
    end: z.string(),
  }),
  price: z.number(),
  currency: z.string(),
  booking_id: z.string().nullable(),
  hold_id: z.string().nullable(),
  hold_expires_at: z.string(),
  hash: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  expired: z.boolean(),
});

export const listProposalsResponseSchema = z.object({
  proposals: z.array(proposalDetailSchema),
});

export const createProposalResponseSchema = z.object({
  proposal: proposalDetailSchema,
});

const executionOutcomeKindSchema = z.enum([
  'booked',
  'cancelled',
  'rescheduled',
  'needs_reapproval',
  'slot_gone',
  'unconfirmed',
  'rejected',
  'failed',
]);

export const executionOutcomeSchema = z
  .object({
    kind: executionOutcomeKindSchema,
  })
  .passthrough();

export const approveResponseSchema = z.object({
  outcome: executionOutcomeSchema,
  message: z.string(),
});

export const declineResponseSchema = z.object({
  ok: z.literal(true),
});

/** `GET /api/task` — extra fields allowed by the server. */
export const taskStateSchema = z
  .object({
    state: z.string(),
    service: z.unknown(),
    area: z.unknown(),
    window_from: z.unknown(),
    window_to: z.unknown(),
    budget: z.unknown(),
  })
  .passthrough();

export const getTaskResponseSchema = z.object({
  task: taskStateSchema.nullable(),
});

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});

/** `GET /api/me` wraps the user with how the caller authenticated (session vs API key). */
export const meResponseSchema = z.object({
  user: userSchema,
  via: z.enum(['session', 'api_key']),
});

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  createdAt: z.string(),
});

export const traceEventSchema = z.object({
  ts: z.string(),
  type: z.string(),
  summary: z.string(),
  detail: z.unknown().optional(),
});

export const factSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  kind: z.enum(['explicit', 'inferred']),
  status: z.enum(['active', 'unconfirmed', 'forgotten']),
});

export const bookingSchema = z.object({
  id: z.string(),
  providerName: z.string(),
  service: z.string(),
  slot: z.object({
    start: z.string(),
    end: z.string(),
  }),
  price: z.number(),
  currency: z.literal('INR'),
  status: z.enum(['confirmed', 'cancelled', 'rescheduled']),
  when: z.enum(['past', 'upcoming']),
});

/** List item shape from `GET /api/keys` — never includes key material. */
export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  start: z.string().optional(),
  prefix: z.string().optional(),
  createdAt: z.string(),
});

export const apiKeysListResponseSchema = z.object({
  keys: z.array(apiKeySchema),
});

/** `POST /api/keys` returns the plaintext key once, alongside its id/name/createdAt. */
export const createApiKeyResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  createdAt: z.string(),
});
