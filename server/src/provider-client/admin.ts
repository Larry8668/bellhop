import {
  ADMIN_PATHS,
  AdminStateResponseSchema,
  type AdminClockRequest,
  type AdminResetRequest,
  type AdminScenarioRequest,
  type AdminStateResponse,
} from '@bellhop/shared/contracts';

type FetchLike = typeof globalThis.fetch;

function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

async function readError(res: Response): Promise<never> {
  const text = await res.text();
  throw new Error(`${res.status} ${text}`);
}

export function createProviderAdminClient(opts: { baseUrl: string; fetch?: FetchLike }) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  return {
    async reset(body?: AdminResetRequest): Promise<void> {
      const url = joinBaseUrl(opts.baseUrl, ADMIN_PATHS.reset);
      const init: RequestInit =
        body === undefined
          ? { method: 'POST' }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            };
      const res = await fetchImpl(url, init);
      if (!res.ok) await readError(res);
    },

    async scenario(body: AdminScenarioRequest): Promise<void> {
      const url = joinBaseUrl(opts.baseUrl, ADMIN_PATHS.scenario);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) await readError(res);
    },

    async clock(body: AdminClockRequest): Promise<void> {
      const url = joinBaseUrl(opts.baseUrl, ADMIN_PATHS.clock);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) await readError(res);
    },

    async cancelBooking(id: string): Promise<void> {
      const url = joinBaseUrl(opts.baseUrl, ADMIN_PATHS.cancelBooking(id));
      const res = await fetchImpl(url, { method: 'POST' });
      if (!res.ok) await readError(res);
    },

    async state(): Promise<AdminStateResponse> {
      const url = joinBaseUrl(opts.baseUrl, ADMIN_PATHS.state);
      const res = await fetchImpl(url, { method: 'GET' });
      if (!res.ok) await readError(res);
      const json: unknown = await res.json();
      return AdminStateResponseSchema.parse(json);
    },
  };
}
