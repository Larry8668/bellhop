/**
 * Redacts untrusted free text before it reaches a trace file (plan §10, §13).
 * Reviews and similar fields come straight from the provider's mock data,
 * which deliberately includes prompt-injection attempts — traces must never
 * carry that text, even sanitized tool results shown in the UI.
 */

const REDACT_KEYS = new Set(['reviews', 'review', 'notes', 'description', 'bio']);
const MAX_STRING_LENGTH = 500;
const TRUNCATION_SUFFIX = '…[truncated]';
const REDACTED_PLACEHOLDER = '[redacted: free text]';

function sanitizeString(value: string, key: string | undefined): string {
  if (key !== undefined && REDACT_KEYS.has(key)) return REDACTED_PLACEHOLDER;
  if (value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATION_SUFFIX}`;
  }
  return value;
}

function sanitizeValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') return sanitizeString(value, key);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

/**
 * Deep-clones a tool result, redacting free-text fields by key name and
 * truncating any other long string. Non-container values passed directly
 * (no enclosing object) are returned unchanged.
 */
export function sanitizeToolResult(result: unknown): unknown {
  if (Array.isArray(result) || (result !== null && typeof result === 'object')) {
    return sanitizeValue(result, undefined);
  }
  return result;
}
