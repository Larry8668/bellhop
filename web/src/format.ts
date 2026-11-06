/** Remaining time until a hold expires, for the approval card countdown. */
export function formatHoldCountdown(expiresAt: string, nowMs: number): string {
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return 'Hold expired';
  const delta = end - nowMs;
  if (delta <= 0) return 'Hold expired';
  const total = Math.floor(delta / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

export function formatLocalRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return `${start} → ${end}`;
  }
  return `${s.toLocaleString()} → ${e.toLocaleString()}`;
}
