import type { Clock } from '@bellhop/shared/clock';
import type { ToolInput, ToolName, ToolOutput } from '@bellhop/shared/contracts';
import type { ProviderCallOptions, ProviderClient } from '../../provider-client/client.js';
import { ProviderError } from '../../provider-client/errors.js';
import { sanitizeToolResult } from '../../trace/sanitize.js';
import type { TraceWriter } from '../../trace/writer.js';

export interface TracedCallDeps {
  providerClient: ProviderClient;
  clock: Clock;
  trace: TraceWriter;
  /** Sent as the provider's request-id header on every call so provider logs join this run. */
  requestId?: string | undefined;
}

function errorSummary(err: unknown): unknown {
  if (err instanceof ProviderError) {
    return { error: { code: err.code, message: err.message, status: err.status, timed_out: err.timedOut } };
  }
  return { error: { message: err instanceof Error ? err.message : String(err) } };
}

export type TracedProviderCall = <N extends ToolName>(
  tool: N,
  userId: string,
  args: ToolInput<N>,
) => Promise<ToolOutput<N>>;

/** Every provider attempt — success or failure — emits one sanitized `tool_call` trace event (plan §13). */
export function createTracedCall(deps: TracedCallDeps): TracedProviderCall {
  const { providerClient, clock, trace } = deps;
  const options: ProviderCallOptions = deps.requestId === undefined ? {} : { requestId: deps.requestId };

  return async function tracedCall<N extends ToolName>(tool: N, userId: string, args: ToolInput<N>) {
    const startedMs = clock.nowMs();
    const call = providerClient[tool] as (
      userId: string,
      input: ToolInput<N>,
      options: ProviderCallOptions,
    ) => Promise<ToolOutput<N>>;
    try {
      const result = await call(userId, args, options);
      trace.emit({
        type: 'tool_call',
        tool,
        args,
        result_sanitized: sanitizeToolResult(result),
        latency_ms: clock.nowMs() - startedMs,
        ok: true,
      });
      return result;
    } catch (err) {
      trace.emit({
        type: 'tool_call',
        tool,
        args,
        result_sanitized: sanitizeToolResult(errorSummary(err)),
        latency_ms: clock.nowMs() - startedMs,
        ok: false,
      });
      throw err;
    }
  };
}
