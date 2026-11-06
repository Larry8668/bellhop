import { Hono } from 'hono';
import type { RequestIdEnv } from './request-id.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { Clock } from '@bellhop/shared/clock';
import {
  TOOL_CONTRACTS,
  TOOL_ERROR_HTTP_STATUS,
  USER_ID_HEADER,
  type BookInput,
  type CancelInput,
  type GetBookingStatusInput,
  type GetProviderInput,
  type HoldSlotInput,
  type ListBookingsInput,
  type RescheduleInput,
  type SearchProvidersInput,
  type ToolName,
} from '@bellhop/shared/contracts';
import type { ProviderEngine } from '../engine/engine.js';
import { ToolError, toErrorBody } from '../engine/errors.js';
import type { TimeoutControl } from '../timeouts.js';

/** True outside production so a contract mismatch fails loudly in dev/test instead of shipping silently. */
const VALIDATE_OUTPUT = process.env.NODE_ENV !== 'production';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ToolHandler = (userId: string, input: unknown) => unknown;

/** Tool name → engine method, each casting its already-zod-validated body to the right input type. */
function buildToolHandlers(engine: ProviderEngine): Record<ToolName, ToolHandler> {
  return {
    search_providers: (userId, input) => engine.searchProviders(userId, input as SearchProvidersInput),
    get_provider: (userId, input) => engine.getProvider(userId, input as GetProviderInput),
    hold_slot: (userId, input) => engine.holdSlot(userId, input as HoldSlotInput),
    book: (userId, input) => engine.book(userId, input as BookInput),
    get_booking_status: (userId, input) => engine.getBookingStatus(userId, input as GetBookingStatusInput),
    cancel: (userId, input) => engine.cancel(userId, input as CancelInput),
    reschedule: (userId, input) => engine.reschedule(userId, input as RescheduleInput),
    list_bookings: (userId, input) => engine.listBookings(userId, input as ListBookingsInput),
  };
}

export function createToolRoutes(deps: {
  engine: ProviderEngine;
  clock: Clock;
  logger: Logger;
  timeouts: TimeoutControl;
}): Hono<RequestIdEnv> {
  const { engine, clock: _clock, logger, timeouts } = deps;
  void _clock; // engine owns timing for business logic; kept for a uniform route-factory signature.

  const log = childLogger(logger, 'http.tools');
  const app = new Hono<RequestIdEnv>();
  const handlers = buildToolHandlers(engine);

  /** Throws (→ 500 via onError) rather than silently shipping a body the contract doesn't describe. */
  function assertOutputMatchesContract(tool: ToolName, output: unknown): void {
    if (!VALIDATE_OUTPUT) return;
    const contract = TOOL_CONTRACTS[tool];
    const result = contract.output.safeParse(output);
    if (!result.success) {
      log.error({ tool, issues: result.error.issues }, 'engine output violates its own contract');
      throw new Error(`engine output for ${tool} does not match its output contract`);
    }
  }

  for (const toolName of Object.keys(TOOL_CONTRACTS) as ToolName[]) {
    const contract = TOOL_CONTRACTS[toolName];

    app.post(contract.path, async (c) => {
      const userId = c.req.header(USER_ID_HEADER);
      if (!userId || userId.trim().length === 0) {
        log.debug({ tool: toolName }, 'missing or empty user id header');
        return c.json(
          { error: { code: 'unauthorized', message: `${USER_ID_HEADER} header is required` } },
          401,
        );
      }

      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json({ error: { code: 'bad_request', message: 'request body must be JSON' } }, 400);
      }

      const parsed = contract.input.safeParse(rawBody);
      if (!parsed.success) {
        log.debug({ tool: toolName, issues: parsed.error.issues }, 'request body failed validation');
        return c.json(
          {
            error: {
              code: 'bad_request',
              message: 'request body failed validation',
              details: parsed.error.issues,
            },
          },
          400,
        );
      }

      // `book`'s timeout outcome has no contract shape of its own: the HTTP
      // response is a 504 regardless of whether the write actually landed
      // (plan §4) — the caller must re-check via `get_booking_status`.
      if (toolName === 'book') {
        let result: ReturnType<ProviderEngine['book']>;
        try {
          result = engine.book(userId, parsed.data as BookInput);
        } catch (err) {
          if (err instanceof ToolError) {
            return c.json(toErrorBody(err), TOOL_ERROR_HTTP_STATUS[err.code] as ContentfulStatusCode);
          }
          throw err;
        }

        if (result.outcome === 'timeout') {
          log.debug({ tool: toolName, booked: result.booked }, 'simulated book timeout');
          await sleep(timeouts.getDelayMs());
          return c.json({ error: { code: 'timeout', message: 'provider timed out' } }, 504);
        }

        assertOutputMatchesContract(toolName, result.output);
        return c.json(result.output as unknown as object, 200);
      }

      try {
        const output = handlers[toolName](userId, parsed.data);
        assertOutputMatchesContract(toolName, output);
        return c.json(output as object, 200);
      } catch (err) {
        if (err instanceof ToolError) {
          return c.json(toErrorBody(err), TOOL_ERROR_HTTP_STATUS[err.code] as ContentfulStatusCode);
        }
        throw err;
      }
    });
  }

  return app;
}
