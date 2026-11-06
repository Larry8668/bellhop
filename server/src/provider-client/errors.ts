import type { ToolErrorCode, ToolName } from '@bellhop/shared/contracts';

export class ProviderError extends Error {
  readonly tool: ToolName;
  readonly code: ToolErrorCode;
  readonly status: number | null;
  readonly details?: unknown;
  readonly timedOut: boolean;

  constructor(opts: {
    tool: ToolName;
    code: ToolErrorCode;
    message: string;
    status: number | null;
    details?: unknown;
    timedOut?: boolean;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.tool = opts.tool;
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.timedOut = opts.timedOut ?? false;
  }

  static isProviderError(err: unknown, code?: ToolErrorCode): err is ProviderError {
    return err instanceof ProviderError && (code === undefined || err.code === code);
  }
}
