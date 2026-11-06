import { httpApi } from './client.js';
import { mockApi } from './mock.js';
import type { Api } from './contract.js';

/** Mock mode: `VITE_USE_MOCK=true` (Vitest, `.env.example`) or `VITE_API_MODE=mock`. */
const useMock =
  import.meta.env.VITE_USE_MOCK === 'true' || import.meta.env.VITE_API_MODE === 'mock';

export const api: Api = useMock ? mockApi : httpApi;

export type { Api } from './contract.js';
export { ApiError } from './client.js';
