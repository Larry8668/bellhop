import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../src/trace/cost.js';

describe('estimateCostUsd', () => {
  it('returns 0 for local Ollama models', () => {
    expect(estimateCostUsd('qwen3.5:9b', 1_000_000, 1_000_000)).toBe(0);
  });

  it('returns a positive cost for a known hosted model', () => {
    expect(estimateCostUsd('gpt-4o', 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it('returns 0 for an unknown hosted model', () => {
    expect(estimateCostUsd('some-unlisted-model', 1_000_000, 1_000_000)).toBe(0);
  });
});
