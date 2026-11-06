import {
  REQUEST_ID_HEADER,
  TOOL_CONTRACTS,
  ToolErrorSchema,
  USER_ID_HEADER,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from '@bellhop/shared/contracts';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import { z } from 'zod';
import { ProviderError } from './errors.js';

export type ProviderCallOptions = {
  requestId?: string;
};

export type ProviderClient = {
  [N in ToolName]: (
    userId: string,
    input: ToolInput<N>,
    options?: ProviderCallOptions,
  ) => Promise<ToolOutput<N>>;
};

type FetchLike = typeof globalThis.fetch;

function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

function isAbortOrTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

export function createProviderClient(opts: {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  fetch?: FetchLike;
}): ProviderClient {
  const log = childLogger(opts.logger, 'provider-client');
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  async function call<N extends ToolName>(
    name: N,
    userId: string,
    input: ToolInput<N>,
    options?: ProviderCallOptions,
  ): Promise<ToolOutput<N>> {
    const contract = TOOL_CONTRACTS[name];
    const started = performance.now();
    const request_id = options?.requestId;

    if (userId.length === 0) {
      log.debug(
        { tool: name, status: null, latency_ms: 0, ok: false, request_id },
        'provider call',
      );
      throw new ProviderError({
        tool: name,
        code: 'unauthorized',
        message: 'user id required',
        status: null,
      });
    }

    let parsedInput: ToolInput<N>;
    try {
      parsedInput = contract.input.parse(input) as ToolInput<N>;
    } catch (err) {
      log.debug(
        {
          tool: name,
          status: null,
          latency_ms: Math.round(performance.now() - started),
          ok: false,
          request_id,
        },
        'provider call',
      );
      if (err instanceof z.ZodError) {
        throw new ProviderError({
          tool: name,
          code: 'bad_request',
          message: 'invalid input',
          status: null,
          details: err.issues,
        });
      }
      throw err;
    }

    const url = joinBaseUrl(opts.baseUrl, contract.path);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [USER_ID_HEADER]: userId,
    };
    if (request_id !== undefined && request_id.length > 0) {
      headers[REQUEST_ID_HEADER] = request_id;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsedInput),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const latency_ms = Math.round(performance.now() - started);
      if (isAbortOrTimeout(err)) {
        log.warn(
          { tool: name, status: null, latency_ms, ok: false, request_id },
          'provider timeout',
        );
        throw new ProviderError({
          tool: name,
          code: 'timeout',
          message: err instanceof Error ? err.message : 'request timed out',
          status: null,
          timedOut: true,
          cause: err,
        });
      }
      log.warn(
        { tool: name, status: null, latency_ms, ok: false, request_id },
        'provider transient failure',
      );
      throw new ProviderError({
        tool: name,
        code: 'transient',
        message: err instanceof Error ? err.message : 'network error',
        status: null,
        cause: err,
      });
    }

    const latency_ms = Math.round(performance.now() - started);
    const status = response.status;
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      log.debug({ tool: name, status, latency_ms, ok: false, request_id }, 'provider call');
      throw new ProviderError({
        tool: name,
        code: 'internal',
        message: 'invalid provider response',
        status,
        details: { parseError: 'response body is not JSON' },
      });
    }

    if (response.ok) {
      const out = contract.output.safeParse(json);
      if (!out.success) {
        log.debug({ tool: name, status, latency_ms, ok: false, request_id }, 'provider call');
        throw new ProviderError({
          tool: name,
          code: 'internal',
          message: 'invalid provider response',
          status,
          details: out.error.issues,
        });
      }
      log.debug({ tool: name, status, latency_ms, ok: true, request_id }, 'provider call');
      return out.data as ToolOutput<N>;
    }

    const toolErr = ToolErrorSchema.safeParse(json);
    if (toolErr.success) {
      log.debug({ tool: name, status, latency_ms, ok: false, request_id }, 'provider call');
      throw new ProviderError({
        tool: name,
        code: toolErr.data.error.code,
        message: toolErr.data.error.message,
        status,
        details: toolErr.data.error.details,
      });
    }

    log.debug({ tool: name, status, latency_ms, ok: false }, 'provider call');
    throw new ProviderError({
      tool: name,
      code: 'internal',
      message: 'invalid provider response',
      status,
      details: json,
    });
  }

  const client = {} as Record<ToolName, unknown>;
  for (const name of Object.keys(TOOL_CONTRACTS) as ToolName[]) {
    client[name] = (userId: string, input: unknown, callOpts?: ProviderCallOptions) =>
      call(name, userId, input as ToolInput<typeof name>, callOpts);
  }
  return client as ProviderClient;
}
