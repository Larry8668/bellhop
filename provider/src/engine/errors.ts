import type { ToolErrorCode, ToolError as ToolErrorBody } from '@bellhop/shared/contracts';

export class ToolError extends Error {
  public readonly code: ToolErrorCode;
  public readonly details?: unknown;

  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function toErrorBody(err: ToolError): ToolErrorBody {
  return {
    error:
      err.details !== undefined
        ? { code: err.code, message: err.message, details: err.details }
        : { code: err.code, message: err.message },
  };
}

/** `user_id` must come from the session/API key and must be present (plan §2). */
export function assertUserId(userId: string): void {
  if (!userId || userId.trim().length === 0) {
    throw new ToolError('unauthorized', 'user_id is required');
  }
}
