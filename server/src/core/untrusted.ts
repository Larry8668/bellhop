import type { ProviderDetail } from '@bellhop/shared/contracts';

/**
 * Strips any `<<<`/`>>>` sequence the text already contains. Without this,
 * a malicious review could embed its own `<<<END-UNTRUSTED-REVIEW>>>` and
 * "close" our fence early, letting the rest of its text read as trusted
 * instructions again (plan §10).
 */
function stripForgedFences(text: string): string {
  return text.replaceAll('<<<', '').replaceAll('>>>', '');
}

/**
 * Wraps free text from an untrusted source (provider reviews, descriptions,
 * any provider-origin string) in a fence that marks it as data, never
 * instructions. `kind` names the source for the fence label, e.g. `'review'`
 * → `<<<UNTRUSTED-REVIEW>>>` (plan §10).
 */
export function fenceUntrusted(text: string, kind: string): string {
  const label = kind.toUpperCase();
  const safe = stripForgedFences(text);
  return `<<<UNTRUSTED-${label}>>>\n${safe}\n<<<END-UNTRUSTED-${label}>>>`;
}

/**
 * Returns a copy of `provider` with every review's `text` fenced as
 * untrusted. Pure — does not mutate `provider` or its `reviews` array.
 */
export function fenceReviews(provider: ProviderDetail): ProviderDetail {
  return {
    ...provider,
    reviews: provider.reviews.map((review) => ({
      ...review,
      text: fenceUntrusted(review.text, 'review'),
    })),
  };
}
