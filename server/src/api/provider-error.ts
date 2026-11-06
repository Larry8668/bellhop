import { TOOL_ERROR_HTTP_STATUS, type ToolErrorCode } from '@bellhop/shared/contracts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The provider's own status for `transient`/`timeout` (503/504, plan's
 * `TOOL_ERROR_HTTP_STATUS`) describes *its* failure. From the backend's
 * perspective talking to an upstream it doesn't control, both are a bad
 * gateway, so we report 502 to our own clients instead of forwarding the
 * provider's status verbatim.
 */
const GATEWAY_CODES: ReadonlySet<ToolErrorCode> = new Set(['transient', 'timeout']);

export function providerErrorStatus(code: ToolErrorCode): ContentfulStatusCode {
  if (GATEWAY_CODES.has(code)) return 502;
  return TOOL_ERROR_HTTP_STATUS[code] as ContentfulStatusCode;
}
