import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/engine/errors.js';
import { createTestEngine, TEST_USER } from './helpers.js';

describe('searchProviders', () => {
  it('returns 3-8 matching providers with slots only inside the requested range', () => {
    const { engine, clock } = createTestEngine();
    const from = clock.now().toISOString();
    const to = new Date(clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const out = engine.searchProviders(TEST_USER, {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });

    expect(out.providers.length).toBeGreaterThanOrEqual(3);
    expect(out.providers.length).toBeLessThanOrEqual(8);
    for (const provider of out.providers) {
      expect(provider.service).toBe('plumber');
      expect(provider.area).toBe('Indiranagar');
      expect(provider.slots.length).toBeGreaterThan(0);
      for (const slot of provider.slots) {
        const startMs = Date.parse(slot.start);
        expect(startMs).toBeGreaterThanOrEqual(Date.parse(from));
        expect(startMs).toBeLessThanOrEqual(Date.parse(to));
      }
    }
  });

  it('matches area case-insensitively', () => {
    const { engine, clock } = createTestEngine();
    const from = clock.now().toISOString();
    const to = new Date(clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const lower = engine.searchProviders(TEST_USER, {
      service: 'electrician',
      area: 'koramangala',
      date_range: { from, to },
    });
    const mixed = engine.searchProviders(TEST_USER, {
      service: 'electrician',
      area: 'KoRaMaNgAlA',
      date_range: { from, to },
    });

    expect(lower.providers.length).toBeGreaterThan(0);
    expect(lower.providers.map((p) => p.id)).toEqual(mixed.providers.map((p) => p.id));
  });

  it('returns no providers for a range with no open slots', () => {
    const { engine, clock } = createTestEngine();
    const farFuture = new Date(clock.nowMs() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const farFutureEnd = new Date(clock.nowMs() + 366 * 24 * 60 * 60 * 1000).toISOString();

    const out = engine.searchProviders(TEST_USER, {
      service: 'cleaning',
      area: 'Whitefield',
      date_range: { from: farFuture, to: farFutureEnd },
    });

    expect(out.providers).toEqual([]);
  });

  it('throws search_error when SEARCH_ERROR scenario is forced', () => {
    const { engine, scenarios, clock } = createTestEngine();
    scenarios.push(['SEARCH_ERROR']);
    const from = clock.now().toISOString();
    const to = new Date(clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();

    expect(() =>
      engine.searchProviders(TEST_USER, {
        service: 'carpenter',
        area: 'Jayanagar',
        date_range: { from, to },
      }),
    ).toThrow(ToolError);
  });

  it('rejects an empty user id', () => {
    const { engine, clock } = createTestEngine();
    const from = clock.now().toISOString();
    const to = new Date(clock.nowMs() + 86400000).toISOString();

    expect(() =>
      engine.searchProviders('', { service: 'plumber', area: 'Indiranagar', date_range: { from, to } }),
    ).toThrow(ToolError);
  });
});

describe('getProvider', () => {
  it('returns provider detail with slots and reviews', () => {
    const { engine, clock } = createTestEngine();
    const from = clock.now().toISOString();
    const to = new Date(clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const search = engine.searchProviders(TEST_USER, {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });
    const providerId = search.providers[0]!.id;

    const out = engine.getProvider(TEST_USER, { provider_id: providerId });
    expect(out.provider.id).toBe(providerId);
    expect(out.provider.reviews.length).toBeGreaterThan(0);
    expect(out.provider.slots.length).toBeGreaterThan(0);
  });

  it('throws provider_not_found for an unknown id', () => {
    const { engine } = createTestEngine();
    expect(() => engine.getProvider(TEST_USER, { provider_id: 'prv_does_not_exist' })).toThrow(ToolError);
    try {
      engine.getProvider(TEST_USER, { provider_id: 'prv_does_not_exist' });
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('provider_not_found');
    }
  });
});
