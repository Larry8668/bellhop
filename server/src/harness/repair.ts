import type { LanguageModelV4ToolCall } from '@ai-sdk/provider';

/**
 * Deterministic, code-only repair of tool calls that a small local model gets
 * almost right (plan §9: invalid args are fed back once, but these two shapes
 * are common enough with qwen3.5:9b that fixing them in code saves a model call):
 *  - ISO datetimes without seconds ("2026-11-08T12:00+05:30") gain ":00";
 *  - a provider *name* in `provider_id` resolves to the id from this user's
 *    last search results. Nothing else is rewritten; anything still invalid is
 *    rejected by the strict schema as before.
 */

const lastSearch = new Map<string, Array<{ id: string; name: string }>>();

export function rememberSearchResults(userId: string, providers: Array<{ id: string; name: string }>): void {
  if (providers.length > 0) lastSearch.set(userId, providers.map((p) => ({ id: p.id, name: p.name })));
}

const NO_SECONDS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/;

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = NO_SECONDS.exec(value);
    return m ? `${m[1]}:00${m[2]}` : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

function resolveProviderId(userId: string, raw: string): string {
  if (/^prv_/i.test(raw)) return raw;
  const wanted = raw.trim().toLowerCase();
  const hit = (lastSearch.get(userId) ?? []).find(
    (p) => p.name.toLowerCase() === wanted || p.name.toLowerCase().includes(wanted) || wanted.includes(p.name.toLowerCase()),
  );
  return hit?.id ?? raw;
}

export function repairToolInput(userId: string, input: unknown): unknown {
  const fixed = normalize(input);
  if (fixed !== null && typeof fixed === 'object' && 'provider_id' in fixed) {
    const rec = fixed as Record<string, unknown>;
    if (typeof rec.provider_id === 'string') rec.provider_id = resolveProviderId(userId, rec.provider_id);
  }
  return fixed;
}

export function repairToolCallFor(userId: string) {
  return async ({ toolCall }: { toolCall: LanguageModelV4ToolCall }): Promise<LanguageModelV4ToolCall | null> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.input);
    } catch {
      return null;
    }
    const repaired = JSON.stringify(repairToolInput(userId, parsed));
    return repaired === toolCall.input ? null : { ...toolCall, input: repaired };
  };
}
