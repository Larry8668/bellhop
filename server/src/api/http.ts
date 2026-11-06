import type { Context } from 'hono';
import { ZodError, type ZodType } from 'zod';

export type ParsedJsonBody<T> = { ok: true; body: T } | { ok: false; response: Response };

/**
 * Reads and validates a JSON request body against `schema`, returning the
 * same `{ error: { code: 'bad_request', message } }` envelope every route
 * used to build inline on a `ZodError` (plan §14). Callers do:
 *
 * ```ts
 * const parsed = await parseJsonBody(c, SomeSchema);
 * if (!parsed.ok) return parsed.response;
 * const body = parsed.body;
 * ```
 *
 * A malformed-JSON body throws `SyntaxError`, which `app.onError` already
 * converts to the same envelope — not caught here.
 */
export async function parseJsonBody<T>(c: Context, schema: ZodType<T>): Promise<ParsedJsonBody<T>> {
  try {
    const body = schema.parse(await c.req.json());
    return { ok: true, body };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        response: c.json(
          { error: { code: 'bad_request', message: err.issues[0]?.message ?? 'invalid request body' } },
          400,
        ),
      };
    }
    throw err;
  }
}
