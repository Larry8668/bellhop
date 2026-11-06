import { describe, expect, it } from 'vitest';
import {
  BookingSchema,
  BookingStatusSchema,
  CurrencySchema,
  HoldSchema,
  PriceSchema,
  ProviderDetailSchema,
  ProviderSummarySchema,
  ReviewSchema,
  ServiceSchema,
  SlotSchema,
  TOOL_ERROR_HTTP_STATUS,
  ToolErrorCodeSchema,
  USER_ID_HEADER,
  parseIncomingRequestId,
} from '../src/contracts/common.js';
import {
  BookInputSchema,
  CancelInputSchema,
  GetBookingStatusInputSchema,
  GetProviderInputSchema,
  HoldSlotInputSchema,
  ListBookingsInputSchema,
  RescheduleInputSchema,
  SearchProvidersInputSchema,
  TOOL_CONTRACTS,
  ToolNameSchema,
} from '../src/contracts/tools.js';

const tWithOffset = '2025-11-06T10:00:00.000Z';
const tWithOffset2 = '2025-11-06T12:00:00.000Z';
const datetimeNoOffset = '2025-11-06T10:00:00';

function slot(): { start: string; end: string } {
  return { start: tWithOffset, end: tWithOffset2 };
}

describe('parseIncomingRequestId', () => {
  it('accepts alnum, underscore, hyphen up to 64 chars', () => {
    expect(parseIncomingRequestId('a_B-9')).toBe('a_B-9');
    expect(parseIncomingRequestId('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects empty, too long, or bad charset', () => {
    expect(parseIncomingRequestId(undefined)).toBeNull();
    expect(parseIncomingRequestId('')).toBeNull();
    expect(parseIncomingRequestId('a'.repeat(65))).toBeNull();
    expect(parseIncomingRequestId('bad!')).toBeNull();
    expect(parseIncomingRequestId(' space')).toBeNull();
  });
});

describe('provider tool input schemas', () => {
  it('SearchProvidersInputSchema accepts valid and rejects bad datetime', () => {
    expect(
      SearchProvidersInputSchema.parse({
        service: 'plumber',
        area: 'Indiranagar',
        date_range: { from: tWithOffset, to: tWithOffset2 },
      }),
    ).toMatchObject({ service: 'plumber' });

    expect(() =>
      SearchProvidersInputSchema.parse({
        service: 'plumber',
        area: 'Indiranagar',
        date_range: { from: datetimeNoOffset, to: tWithOffset2 },
      }),
    ).toThrow();
  });

  it('GetProviderInputSchema accepts valid and rejects empty id', () => {
    expect(GetProviderInputSchema.parse({ provider_id: 'p1' })).toEqual({ provider_id: 'p1' });
    expect(() => GetProviderInputSchema.parse({ provider_id: '' })).toThrow();
  });

  it('HoldSlotInputSchema accepts valid and rejects invalid slot time', () => {
    expect(
      HoldSlotInputSchema.parse({
        provider_id: 'p1',
        slot: slot(),
      }),
    ).toMatchObject({ provider_id: 'p1' });

    expect(() =>
      HoldSlotInputSchema.parse({
        provider_id: 'p1',
        slot: { start: datetimeNoOffset, end: tWithOffset2 },
      }),
    ).toThrow();
  });

  it('BookInputSchema accepts valid and rejects missing key', () => {
    expect(
      BookInputSchema.parse({ hold_id: 'h1', idempotency_key: 'k1' }),
    ).toEqual({ hold_id: 'h1', idempotency_key: 'k1' });
    expect(() => BookInputSchema.parse({ hold_id: 'h1' })).toThrow();
  });

  it('GetBookingStatusInputSchema rejects {} and accepts either key', () => {
    expect(() => GetBookingStatusInputSchema.parse({})).toThrow();
    expect(GetBookingStatusInputSchema.parse({ hold_id: 'h1' })).toEqual({ hold_id: 'h1' });
    expect(GetBookingStatusInputSchema.parse({ idempotency_key: 'k1' })).toEqual({
      idempotency_key: 'k1',
    });
  });

  it('CancelInputSchema accepts valid and rejects empty booking_id', () => {
    expect(
      CancelInputSchema.parse({ booking_id: 'b1', idempotency_key: 'k1' }),
    ).toEqual({ booking_id: 'b1', idempotency_key: 'k1' });
    expect(() => CancelInputSchema.parse({ booking_id: '', idempotency_key: 'k1' })).toThrow();
  });

  it('RescheduleInputSchema accepts valid and rejects bad slot', () => {
    expect(
      RescheduleInputSchema.parse({
        booking_id: 'b1',
        slot: slot(),
        idempotency_key: 'k1',
      }),
    ).toMatchObject({ booking_id: 'b1' });

    expect(() =>
      RescheduleInputSchema.parse({
        booking_id: 'b1',
        slot: { start: datetimeNoOffset, end: tWithOffset2 },
        idempotency_key: 'k1',
      }),
    ).toThrow();
  });

  it('ListBookingsInputSchema accepts valid and rejects empty user_id', () => {
    expect(ListBookingsInputSchema.parse({ user_id: 'u1' })).toEqual({ user_id: 'u1' });
    expect(() => ListBookingsInputSchema.parse({ user_id: '' })).toThrow();
  });
});

describe('TOOL_CONTRACTS registry', () => {
  it('has exactly the 8 tool names with paths /tools/<name>', () => {
    const names = Object.keys(TOOL_CONTRACTS);
    expect(names).toHaveLength(8);
    const toolNames = new Set(ToolNameSchema.options);
    for (const name of names) {
      expect(toolNames.has(name as (typeof ToolNameSchema.options)[number])).toBe(true);
      expect(TOOL_CONTRACTS[name as keyof typeof TOOL_CONTRACTS].path).toBe(`/tools/${name}`);
    }
    expect(names.sort()).toEqual([...ToolNameSchema.options].sort());
  });
});

describe('TOOL_ERROR_HTTP_STATUS', () => {
  it('has an entry for every ToolErrorCode', () => {
    for (const code of ToolErrorCodeSchema.options) {
      expect(TOOL_ERROR_HTTP_STATUS[code]).toBeTypeOf('number');
    }
  });
});

describe('USER_ID_HEADER', () => {
  it('is fixed contract string', () => {
    expect(USER_ID_HEADER).toBe('x-user-id');
  });
});

describe('schema exports used by fixtures', () => {
  it('referenced schemas parse minimal valid payloads', () => {
    SlotSchema.parse(slot());
    ServiceSchema.parse('plumber');
    PriceSchema.parse(100);
    CurrencySchema.parse('INR');
    BookingStatusSchema.parse('confirmed');
    ReviewSchema.parse({ author: 'a', rating: 5, text: 'ok' });
    ProviderSummarySchema.parse({
      id: 'p1',
      name: 'P',
      service: 'plumber',
      area: 'A',
      price: 100,
      currency: 'INR',
      rating: 4.5,
      slots: [slot()],
      attributes: ['fast'],
    });
    ProviderDetailSchema.parse({
      id: 'p1',
      name: 'P',
      service: 'plumber',
      area: 'A',
      price: 100,
      currency: 'INR',
      rating: 4.5,
      slots: [slot()],
      attributes: ['fast'],
      description: 'd',
      years_active: 2,
      reviews: [{ author: 'a', rating: 5, text: 'ok' }],
    });
    HoldSchema.parse({
      hold_id: 'h1',
      provider_id: 'p1',
      user_id: 'u1',
      slot: slot(),
      price: 100,
      search_price: 90,
      currency: 'INR',
      expires_at: tWithOffset2,
    });
    BookingSchema.parse({
      booking_id: 'b1',
      user_id: 'u1',
      provider_id: 'p1',
      provider_name: 'P',
      service: 'plumber',
      slot: slot(),
      price: 100,
      currency: 'INR',
      status: 'confirmed',
      created_at: tWithOffset,
      updated_at: tWithOffset2,
    });
  });
});
