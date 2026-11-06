import { z } from 'zod';
import { endpoints } from './endpoints.js';
import type { Api, ChatStreamEvent } from './contract.js';
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

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  createdAt: z.string(),
});

const traceEventSchema = z.object({
  ts: z.string(),
  type: z.string(),
  summary: z.string(),
  detail: z.unknown().optional(),
});

const factSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  kind: z.enum(['explicit', 'inferred']),
  status: z.enum(['active', 'unconfirmed', 'forgotten']),
});

const bookingSchema = z.object({
  id: z.string(),
  providerName: z.string(),
  service: z.string(),
  slot: z.object({
    start: z.string(),
    end: z.string(),
  }),
  price: z.number(),
  status: z.enum(['confirmed', 'cancelled', 'rescheduled']),
  when: z.enum(['past', 'upcoming']),
});

const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
});

const createApiKeySchema = apiKeySchema.extend({
  plaintextKey: z.string(),
});

const errorBodySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

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
      message =
        parsed.data.message ?? parsed.data.error ?? parsed.data.code ?? message;
      code = parsed.data.code ?? code;
    }
  } catch {
    // ignore
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

  me: () => fetchJson(endpoints.me, undefined, userSchema.nullable(), 'me'),

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

  approve: (proposalId) =>
    fetchOk(endpoints.approve(proposalId), { method: 'POST' }),

  decline: (proposalId) =>
    fetchOk(endpoints.decline(proposalId), { method: 'POST' }),

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

  listApiKeys: () =>
    fetchJson(endpoints.apiKeys, undefined, z.array(apiKeySchema), 'apiKeys'),

  createApiKey: (name) =>
    fetchJson(
      endpoints.apiKeys,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
      createApiKeySchema,
      'createApiKey',
    ),
};
