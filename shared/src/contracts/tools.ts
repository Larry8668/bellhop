import { z } from 'zod';
import {
  BookingSchema,
  HoldSchema,
  IsoDateTimeSchema,
  ProviderDetailSchema,
  ProviderSummarySchema,
  ServiceSchema,
  SlotSchema,
} from './common.js';

export const SearchProvidersInputSchema = z.object({
  service: ServiceSchema,
  area: z.string().min(1),
  date_range: z.object({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
  }),
});
export type SearchProvidersInput = z.infer<typeof SearchProvidersInputSchema>;

export const SearchProvidersOutputSchema = z.object({
  providers: z.array(ProviderSummarySchema).min(0),
});
export type SearchProvidersOutput = z.infer<typeof SearchProvidersOutputSchema>;

export const GetProviderInputSchema = z.object({
  provider_id: z.string().min(1),
});
export type GetProviderInput = z.infer<typeof GetProviderInputSchema>;

export const GetProviderOutputSchema = z.object({
  provider: ProviderDetailSchema,
});
export type GetProviderOutput = z.infer<typeof GetProviderOutputSchema>;

export const HoldSlotInputSchema = z.object({
  provider_id: z.string().min(1),
  slot: SlotSchema,
});
export type HoldSlotInput = z.infer<typeof HoldSlotInputSchema>;

export const HoldSlotOutputSchema = z.object({
  hold: HoldSchema,
});
export type HoldSlotOutput = z.infer<typeof HoldSlotOutputSchema>;

export const BookInputSchema = z.object({
  hold_id: z.string().min(1),
  idempotency_key: z.string().min(1),
});
export type BookInput = z.infer<typeof BookInputSchema>;

export const BookOutputSchema = z.object({
  status: z.literal('booked'),
  booking: BookingSchema,
});
export type BookOutput = z.infer<typeof BookOutputSchema>;

export const GetBookingStatusInputSchema = z
  .object({
    hold_id: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  .refine((v) => v.hold_id !== undefined || v.idempotency_key !== undefined, {
    message: 'hold_id or idempotency_key required',
  });
export type GetBookingStatusInput = z.infer<typeof GetBookingStatusInputSchema>;

export const GetBookingStatusOutputSchema = z.object({
  status: z.enum(['booked', 'not_booked']),
  booking: BookingSchema.nullable(),
  hold: z
    .object({
      hold_id: z.string(),
      expires_at: IsoDateTimeSchema,
      state: z.enum(['active', 'expired', 'consumed']),
    })
    .nullable(),
});
export type GetBookingStatusOutput = z.infer<typeof GetBookingStatusOutputSchema>;

export const CancelInputSchema = z.object({
  booking_id: z.string().min(1),
  idempotency_key: z.string().min(1),
});
export type CancelInput = z.infer<typeof CancelInputSchema>;

export const CancelOutputSchema = z.object({
  status: z.literal('cancelled'),
  booking: BookingSchema,
});
export type CancelOutput = z.infer<typeof CancelOutputSchema>;

export const RescheduleInputSchema = z.object({
  booking_id: z.string().min(1),
  slot: SlotSchema,
  idempotency_key: z.string().min(1),
});
export type RescheduleInput = z.infer<typeof RescheduleInputSchema>;

export const RescheduleOutputSchema = z.object({
  status: z.literal('rescheduled'),
  booking: BookingSchema,
  previous_slot: SlotSchema,
});
export type RescheduleOutput = z.infer<typeof RescheduleOutputSchema>;

export const SlotConflictDetailsSchema = z.object({
  alternatives: z.array(SlotSchema),
});
export type SlotConflictDetails = z.infer<typeof SlotConflictDetailsSchema>;

export const ListBookingsInputSchema = z.object({
  user_id: z.string().min(1),
});
export type ListBookingsInput = z.infer<typeof ListBookingsInputSchema>;

export const ListBookingsOutputSchema = z.object({
  bookings: z.array(
    BookingSchema.extend({
      when: z.enum(['past', 'upcoming']),
    }),
  ),
});
export type ListBookingsOutput = z.infer<typeof ListBookingsOutputSchema>;

export const ToolNameSchema = z.enum([
  'search_providers',
  'get_provider',
  'hold_slot',
  'book',
  'get_booking_status',
  'cancel',
  'reschedule',
  'list_bookings',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const TOOL_CONTRACTS = {
  search_providers: {
    path: '/tools/search_providers',
    input: SearchProvidersInputSchema,
    output: SearchProvidersOutputSchema,
  },
  get_provider: {
    path: '/tools/get_provider',
    input: GetProviderInputSchema,
    output: GetProviderOutputSchema,
  },
  hold_slot: {
    path: '/tools/hold_slot',
    input: HoldSlotInputSchema,
    output: HoldSlotOutputSchema,
  },
  book: {
    path: '/tools/book',
    input: BookInputSchema,
    output: BookOutputSchema,
  },
  get_booking_status: {
    path: '/tools/get_booking_status',
    input: GetBookingStatusInputSchema,
    output: GetBookingStatusOutputSchema,
  },
  cancel: {
    path: '/tools/cancel',
    input: CancelInputSchema,
    output: CancelOutputSchema,
  },
  reschedule: {
    path: '/tools/reschedule',
    input: RescheduleInputSchema,
    output: RescheduleOutputSchema,
  },
  list_bookings: {
    path: '/tools/list_bookings',
    input: ListBookingsInputSchema,
    output: ListBookingsOutputSchema,
  },
} as const satisfies Record<
  ToolName,
  { path: string; input: z.ZodType; output: z.ZodType }
>;

export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_CONTRACTS)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOL_CONTRACTS)[N]['output']>;
