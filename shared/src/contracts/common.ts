import { z } from 'zod';

export const USER_ID_HEADER = 'x-user-id' as const;

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const SlotSchema = z.object({
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
});
export type Slot = z.infer<typeof SlotSchema>;

export const PriceSchema = z.number().int().nonnegative();
export type Price = z.infer<typeof PriceSchema>;

export const CurrencySchema = z.literal('INR');
export type Currency = z.infer<typeof CurrencySchema>;

export const ServiceSchema = z.enum([
  'plumber',
  'electrician',
  'ac_servicing',
  'cleaning',
  'carpenter',
  'pest_control',
]);
export type Service = z.infer<typeof ServiceSchema>;

export const ProviderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  service: ServiceSchema,
  area: z.string(),
  price: PriceSchema,
  currency: CurrencySchema,
  rating: z.number().min(0).max(5),
  slots: z.array(SlotSchema),
  attributes: z.array(z.string()),
});
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

export const ReviewSchema = z.object({
  author: z.string(),
  rating: z.number().int().min(1).max(5),
  text: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const ProviderDetailSchema = ProviderSummarySchema.extend({
  description: z.string(),
  years_active: z.number().int().nonnegative(),
  reviews: z.array(ReviewSchema),
});
export type ProviderDetail = z.infer<typeof ProviderDetailSchema>;

export const BookingStatusSchema = z.enum(['confirmed', 'cancelled', 'rescheduled']);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const BookingSchema = z.object({
  booking_id: z.string(),
  user_id: z.string(),
  provider_id: z.string(),
  provider_name: z.string(),
  service: ServiceSchema,
  slot: SlotSchema,
  price: PriceSchema,
  currency: CurrencySchema,
  status: BookingStatusSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Booking = z.infer<typeof BookingSchema>;

export const HoldSchema = z.object({
  hold_id: z.string(),
  provider_id: z.string(),
  user_id: z.string(),
  slot: SlotSchema,
  price: PriceSchema,
  search_price: PriceSchema,
  currency: CurrencySchema,
  expires_at: IsoDateTimeSchema,
});
export type Hold = z.infer<typeof HoldSchema>;

export const ToolErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'provider_not_found',
  'slot_unavailable',
  'hold_not_found',
  'hold_expired',
  'slot_taken',
  'booking_not_found',
  'already_cancelled',
  'booking_cancelled',
  'slot_conflict',
  'idempotency_mismatch',
  'transient',
  'timeout',
  'search_error',
  'not_found',
  'internal',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolErrorSchema = z.object({
  error: z.object({
    code: ToolErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const TOOL_ERROR_HTTP_STATUS: Record<ToolErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  provider_not_found: 404,
  hold_not_found: 404,
  booking_not_found: 404,
  not_found: 404,
  slot_unavailable: 409,
  slot_taken: 409,
  already_cancelled: 409,
  booking_cancelled: 409,
  slot_conflict: 409,
  idempotency_mismatch: 409,
  hold_expired: 410,
  transient: 503,
  search_error: 503,
  timeout: 504,
  internal: 500,
};
