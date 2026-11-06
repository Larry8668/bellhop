import type { MemoryFact } from './types.js';

/** Plan §9 starting allocation for the memories section of the prompt. */
export const MEMORY_TOKEN_BUDGET = 800;

type SelectionContext = { service?: string | null; area?: string | null };

/**
 * One fact as it is injected into the prompt. The token cap sums these lines
 * (each already ends in a newline), so the estimate matches the block the
 * harness will concatenate.
 */
export function renderFactLine(fact: Pick<MemoryFact, 'key' | 'value'>): string {
  return `- ${fact.key}: ${fact.value}\n`;
}

/** Plan §9: characters / 4, rounded up so a partial token still counts against the cap. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

/** Every token of `needle` appears in `key` (`preferred_electrician` matches service `electrician`). */
function keyMatches(key: string, needle: string | null | undefined): boolean {
  if (needle == null || needle.trim() === '') return false;
  const needleTokens = tokens(needle);
  if (needleTokens.length === 0) return false;
  const keyTokens = tokens(key);
  return needleTokens.every((part) => keyTokens.includes(part));
}

function tagValues(tags: readonly string[], prefix: 'service' | 'area'): string[] {
  const head = `${prefix}:`;
  const values: string[] = [];
  for (const tag of tags) {
    const lower = tag.trim().toLowerCase();
    if (!lower.startsWith(head)) continue;
    const value = norm(lower.slice(head.length));
    if (value.length > 0) values.push(value);
  }
  return values;
}

function hasGeneral(tags: readonly string[]): boolean {
  return tags.some((tag) => tag.trim().toLowerCase() === 'general');
}

/**
 * Active facts only (plan §11). A service or area tag is a constraint when
 * the turn has that dimension: `service:plumber` + `area:koramangala` is not
 * selected for a plumber in Indiranagar. `general` and untagged prefs are
 * included unless one of those tags conflicts. A key match counts only when
 * the fact has no service/area tag, so a tag always wins over the key.
 */
export function isRelevant(fact: MemoryFact, ctx: SelectionContext): boolean {
  if (fact.status !== 'active') return false;

  const service = ctx.service ? norm(ctx.service) : '';
  const area = ctx.area ? norm(ctx.area) : '';
  const serviceTags = tagValues(fact.tags, 'service');
  const areaTags = tagValues(fact.tags, 'area');

  if (service !== '' && serviceTags.length > 0 && !serviceTags.includes(service)) return false;
  if (area !== '' && areaTags.length > 0 && !areaTags.includes(area)) return false;

  if (fact.tags.length === 0 || hasGeneral(fact.tags)) return true;
  if (service !== '' && serviceTags.includes(service)) return true;
  if (area !== '' && areaTags.includes(area)) return true;

  const keyHit =
    (service !== '' && keyMatches(fact.key, ctx.service)) ||
    (area !== '' && keyMatches(fact.key, ctx.area));
  return keyHit && serviceTags.length === 0 && areaTags.length === 0;
}

/**
 * `facts` must already be newest-first. Facts that would exceed the remaining
 * budget are skipped, so one long fact does not discard smaller older ones
 * or push the total over {@link MEMORY_TOKEN_BUDGET}.
 */
export function selectFacts(facts: readonly MemoryFact[], ctx: SelectionContext): MemoryFact[] {
  const selected: MemoryFact[] = [];
  let used = 0;
  for (const fact of facts) {
    if (!isRelevant(fact, ctx)) continue;
    const cost = estimateTokens(renderFactLine(fact));
    if (used + cost > MEMORY_TOKEN_BUDGET) continue;
    selected.push(fact);
    used += cost;
  }
  return selected;
}
