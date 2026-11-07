/**
 * Reference price table for trace cost estimation (plan §13). Local Ollama
 * models are free; only hosted models we might swap in for comparison are
 * priced. Prices are USD per 1M tokens, checked against provider pricing
 * pages at plan time (2026-11-06) — re-verify before trusting for billing.
 */
export const COST_TABLE_USD_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

const LOCAL_MODEL_PATTERN = /qwen|gemma|llama/i;

function isLocalModel(model: string): boolean {
  return LOCAL_MODEL_PATTERN.test(model) || model.endsWith(':local');
}

/**
 * Estimates USD cost for a model call. Unknown and local models cost 0 —
 * Ollama models run on the host for free, and we don't guess at pricing for
 * models not in the reference table.
 */
export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  if (isLocalModel(model)) return 0;

  const pricing = COST_TABLE_USD_PER_1M_TOKENS[model];
  if (!pricing) return 0;

  return (tokensIn / 1_000_000) * pricing.input + (tokensOut / 1_000_000) * pricing.output;
}
