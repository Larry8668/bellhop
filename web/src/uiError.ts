import { ApiError } from './api/client.js';

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.message} (${err.status})`;
  return fallback;
}
