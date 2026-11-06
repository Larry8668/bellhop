import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@bellhop/shared/contracts';
import { startTestProvider } from '../../src/testing.js';

describe('provider request id middleware', () => {
  it('generates and echoes x-request-id on health when absent', async () => {
    const tp = await startTestProvider();
    try {
      const res = await fetch(new URL('/health', tp.url));
      expect(res.status).toBe(200);
      const echoed = res.headers.get(REQUEST_ID_HEADER);
      expect(echoed).toBeTruthy();
      expect(echoed).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    } finally {
      await tp.close();
    }
  });

  it('accepts a valid incoming id and echoes it', async () => {
    const tp = await startTestProvider();
    try {
      const id = 'req_abc-01';
      const res = await fetch(new URL('/health', tp.url), { headers: { [REQUEST_ID_HEADER]: id } });
      expect(res.status).toBe(200);
      expect(res.headers.get(REQUEST_ID_HEADER)).toBe(id);
    } finally {
      await tp.close();
    }
  });

  it('replaces an invalid incoming id — response header is not the bad value', async () => {
    const tp = await startTestProvider();
    try {
      const bad = '!!!bad';
      const res = await fetch(new URL('/health', tp.url), { headers: { [REQUEST_ID_HEADER]: bad } });
      expect(res.status).toBe(200);
      const echoed = res.headers.get(REQUEST_ID_HEADER);
      expect(echoed).toBeTruthy();
      expect(echoed).not.toBe(bad);
    } finally {
      await tp.close();
    }
  });
});
