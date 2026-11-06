import { httpApi } from './client.js';
import { mockApi } from './mock.js';
import type { Api } from './contract.js';

const useMock = import.meta.env.VITE_USE_MOCK === 'true';

export const api: Api = useMock ? mockApi : httpApi;

export type { Api } from './contract.js';
export { ApiError } from './client.js';
