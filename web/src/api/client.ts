import { z } from 'zod';
import { endpoints } from './endpoints.js';
import type { Api, ChatStreamEvent } from './contract.js';
import {
  apiKeysListResponseSchema,
  approveResponseSchema,
  bookingSchema,
  chatMessageSchema,
  createApiKeyResponseSchema,
  createProposalResponseSchema,
  factSchema,
  getTaskResponseSchema,
  listProposalsResponseSchema,
  meResponseSchema,
  okResponseSchema,
  traceEventSchema,
} from './schemas.js';
import type { CreateProposalInput } from './types.js';
import { log } from '../logger.js';

export interface ApiErrorShape {
  status: number;
  code: string;
  message: string;
}

export class ApiError extends Error implements ApiErrorShape {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const errorBodySchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    error: z
      .union([
        z.string(),
        z.object({
          code: z.string().optional(),
          message: z.string().optional(),
        }),
      ])
      .optional(),
  })
  .passthrough();

async function parseJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  context: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    log.error({ err, context }, 'failed to parse JSON');
    throw new ApiError(
      response.status,
      'parse_error',
      `Invalid JSON (${context})`,
      { cause: err },
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    log.error(
      { context, issues: parsed.error.flatten() },
      'response failed validation',
    );
    throw new ApiError(
      response.status,
      'invalid_response',
      `Unexpected response shape (${context})`,
    );
  }
  return parsed.data;
}

async function readError(response: Response): Promise<ApiError> {
  let message = response.statusText || 'Request failed';
  let code = `http_${response.status}`;
  try {
    const body = await response.json();
    const parsed = errorBodySchema.safeParse(body);
    if (parsed.success) {
      const d = parsed.data;
      const nested = d.error;
      if (nested !== undefined && typeof nested === 'object') {
        message = nested.message ?? message;
        code = nested.code ?? code;
      } else if (typeof nested === 'string') {
        message = nested;
      } else {
        message = d.message ?? d.code ?? message;
        code = d.code ?? code;
      }
    }
  } catch {
    // Body was not JSON; keep the HTTP status text.
  }
  return new ApiError(response.status, code, message);
}

async function fetchJson<T>(
  input: string,
  init: RequestInit | undefined,
  schema: z.ZodType<T>,
  context: string,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: 'include',
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return parseJson(response, schema, context);
}

async function fetchOk(
  input: string,
  init: RequestInit | undefined,
): Promise<void> {
  const response = await fetch(input, {
    ...init,
    credentials: 'include',
  });
  if (!response.ok) {
    throw await readError(response);
  }
}

function parseSseLine(
  data: string,
): ChatStreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    const res = traceEventSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

export const httpApi: Api = {
  signIn: (email, password) =>
    fetchOk(
      endpoints.signIn,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
    ),

  signUp: (email, password, name) =>
    fetchOk(
      endpoints.signUp,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      },
    ),

  signOut: () =>
    fetchOk(endpoints.signOut, { method: 'POST' }),

  me: async () => {
    const response = await fetch(endpoints.me, { credentials: 'include' });
    // Not signed in is an expected outcome here, not an error — the caller
    // (SessionProvider) should see `null`, not a thrown ApiError.
    if (response.status === 401) return null;
    if (!response.ok) throw await readError(response);
    const data = await parseJson(response, meResponseSchema, 'me');
    return data.user;
  },

  listMessages: () =>
    fetchJson(endpoints.messages, undefined, z.array(chatMessageSchema), 'messages'),

  sendMessage: (text) =>
    fetchJson(
      endpoints.sendMessage,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      chatMessageSchema,
      'sendMessage',
    ),

  streamEvents: (onEvent) => {
    const source = new EventSource(endpoints.events, { withCredentials: true });

    const onMessage = (ev: MessageEvent): void => {
      if (typeof ev.data !== 'string') return;
      const evt = parseSseLine(ev.data);
      if (evt) onEvent(evt);
    };

    source.onmessage = onMessage;

    source.onerror = (err) => {
      log.error({ err }, 'SSE connection error');
    };

    return () => {
      source.close();
    };
  },

  listProposals: async () => {
    const data = await fetchJson(
      endpoints.proposals,
      undefined,
      listProposalsResponseSchema,
      'listProposals',
    );
    return data.proposals;
  },

  createProposal: (input: CreateProposalInput) =>
    fetchJson(
      endpoints.proposals,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      createProposalResponseSchema,
      'createProposal',
    ).then((r) => r.proposal),

  approve: (proposalId, hash) =>
    fetchJson(
      endpoints.approve(proposalId),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      },
      approveResponseSchema,
      'approve',
    ),

  decline: async (proposalId) => {
    await fetchJson(
      endpoints.decline(proposalId),
      { method: 'POST' },
      okResponseSchema,
      'decline',
    );
  },

  simulateProviderCancel: async (bookingId) => {
    await fetchJson(
      endpoints.devProviderCancel(bookingId),
      { method: 'POST' },
      okResponseSchema,
      'devProviderCancel',
    );
  },

  getTask: async () => {
    const data = await fetchJson(
      endpoints.task,
      undefined,
      getTaskResponseSchema,
      'getTask',
    );
    return data.task;
  },

  listFacts: () =>
    fetchJson(endpoints.facts, undefined, z.array(factSchema), 'facts'),

  updateFact: (id, value) =>
    fetchOk(endpoints.fact(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }),

  forgetFact: (id) =>
    fetchOk(`${endpoints.fact(id)}/forget`, { method: 'POST' }),

  confirmFact: (id) =>
    fetchOk(`${endpoints.fact(id)}/confirm`, { method: 'POST' }),

  listBookings: () =>
    fetchJson(
      endpoints.bookings,
      undefined,
      z.array(bookingSchema),
      'bookings',
    ),

  listApiKeys: async () => {
    const data = await fetchJson(
      endpoints.apiKeys,
      undefined,
      apiKeysListResponseSchema,
      'apiKeys',
    );
    return data.keys;
  },

  createApiKey: async (name) => {
    const data = await fetchJson(
      endpoints.apiKeys,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
      createApiKeyResponseSchema,
      'createApiKey',
    );
    return { id: data.id, name: data.name, createdAt: data.createdAt, plaintextKey: data.key };
  },
};
