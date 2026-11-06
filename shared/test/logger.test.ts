import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, childLogger } from '../src/logger.js';

describe('logger', () => {
  const origIsTTY = process.stdout.isTTY;
  const origWrite = process.stdout.write;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: origIsTTY,
    });
    vi.unstubAllEnvs();
  });

  it('child includes module binding and redacts password in JSON output', async () => {
    let buffer = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    const log = createLogger({ name: 'test-app' });
    const modLog = childLogger(log, 'test-module');
    modLog.info({ account: { password: 'super-secret' }, ok: true }, 'hello');

    await new Promise((r) => setImmediate(r));

    const line = buffer.trim().split('\n').filter(Boolean).at(-1);
    expect(line).toBeDefined();
    const row = JSON.parse(line!) as {
      module?: string;
      ok?: boolean;
      account?: { password?: string };
    };
    expect(row.module).toBe('test-module');
    expect(row.ok).toBe(true);
    expect(row.account?.password).toBeUndefined();
  });
});
