import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads defaults when env has no overrides', () => {
    const config = loadConfig({});

    expect(config.MODEL).toBe('qwen3.5:9b');
    expect(config.MODEL_FALLBACK).toBe('qwen3:8b');
    expect(config.OLLAMA_BASE_URL).toBe('http://localhost:11434');
    expect(config.NUM_CTX).toBe(8192);
    expect(config.LIMIT_MODEL_CALLS_PER_TURN).toBe(8);
    expect(config.LIMIT_TOOL_CALLS_PER_TURN).toBe(15);
    expect(config.LIMIT_TURN_WALL_CLOCK_MS).toBe(60000);
    expect(config.LIMIT_STATUS_CHECKS).toBe(3);
    expect(config.LIMIT_RETRIES_PER_TOOL).toBe(2);
    expect(config.CONTEXT_BUDGET_TOKENS).toBe(8192);
    expect(config.PROVIDER_URL).toBe('http://localhost:4010');
    expect(config.DB_PATH).toBe('./data/bellhop.db');
    expect(config.TRACES_DIR).toBe('../traces');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DEV_ROUTES).toBe(true);
    expect(config.PROACTIVE_POLL_MS).toBe(15000);
  });

  it('defaults DEV_ROUTES off in production and on when explicitly set', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).DEV_ROUTES).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', DEV_ROUTES: 'true' }).DEV_ROUTES).toBe(true);
    expect(loadConfig({ DEV_ROUTES: '0' }).DEV_ROUTES).toBe(false);
  });

  it('throws an error naming DEV_ROUTES or PROACTIVE_POLL_MS when the value is invalid', () => {
    expect(() => loadConfig({ DEV_ROUTES: 'yes' })).toThrowError(/DEV_ROUTES/);
    expect(() => loadConfig({ PROACTIVE_POLL_MS: '0' })).toThrowError(/PROACTIVE_POLL_MS/);
    expect(() => loadConfig({ PROACTIVE_POLL_MS: 'soon' })).toThrowError(/PROACTIVE_POLL_MS/);
  });

  it('coerces numeric env strings', () => {
    const config = loadConfig({ LIMIT_MODEL_CALLS_PER_TURN: '12' });
    expect(config.LIMIT_MODEL_CALLS_PER_TURN).toBe(12);
  });

  it('throws an error naming the bad key for an invalid numeric value', () => {
    expect(() => loadConfig({ LIMIT_MODEL_CALLS_PER_TURN: 'abc' })).toThrowError(
      /LIMIT_MODEL_CALLS_PER_TURN/,
    );
  });
});
