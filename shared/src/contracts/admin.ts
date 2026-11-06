import { z } from 'zod';
import { BookingSchema, HoldSchema, IsoDateTimeSchema } from './common.js';
import { ToolNameSchema } from './tools.js';

export const ScenarioNameSchema = z.enum([
  'BOOK_SUCCESS',
  'BOOK_SLOT_TAKEN',
  'TIMEOUT_BOOKED',
  'TIMEOUT_NOT_BOOKED',
  'PRICE_CHANGES_ON_HOLD',
  'HOLD_EXPIRED',
  'CANCEL_503_ONCE',
  'CANCEL_OK',
  'RESCHEDULE_CONFLICT',
  'SEARCH_ERROR',
  'RANDOM',
]);
export type ScenarioName = z.infer<typeof ScenarioNameSchema>;

export const AdminScenarioRequestSchema = z.object({
  outcomes: z.array(ScenarioNameSchema).min(1),
  timeout_delay_ms: z.number().int().min(0).optional(),
});
export type AdminScenarioRequest = z.infer<typeof AdminScenarioRequestSchema>;

export const AdminResetRequestSchema = z.object({
  seed: z.number().int().optional(),
});
export type AdminResetRequest = z.infer<typeof AdminResetRequestSchema>;

export const AdminClockRequestSchema = z
  .object({
    set: IsoDateTimeSchema.optional(),
    advance_ms: z.number().int().optional(),
  })
  .refine((v) => v.set !== undefined || v.advance_ms !== undefined, {
    message: 'set or advance_ms required',
  });
export type AdminClockRequest = z.infer<typeof AdminClockRequestSchema>;

export const AdminStateResponseSchema = z.object({
  now: IsoDateTimeSchema,
  seed: z.number().int(),
  pending_scenarios: z.array(ScenarioNameSchema),
  timeout_delay_ms: z.number().int(),
  holds: z.array(HoldSchema),
  bookings: z.array(BookingSchema),
  idempotency: z.array(
    z.object({
      tool: ToolNameSchema,
      key: z.string(),
      fingerprint: z.string(),
      status: z.number().int(),
    }),
  ),
});
export type AdminStateResponse = z.infer<typeof AdminStateResponseSchema>;

export const ADMIN_PATHS = {
  reset: '/__admin/reset',
  scenario: '/__admin/scenario',
  clock: '/__admin/clock',
  cancelBooking: (id: string) => `/__admin/cancel-booking/${id}`,
  state: '/__admin/state',
} as const;
