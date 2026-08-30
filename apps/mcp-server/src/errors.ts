/**
 * Machine-readable failure envelopes for every tool.
 *
 * Honesty rule: a failure is reported as `{error:{code,message,pointer?}}`
 * with `isError:true` — never a stack trace, never a fake `passed`. Unknown
 * exceptions collapse to INTERNAL_ERROR with their message only.
 */

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "LOCK_INVALID"
  | "ENTRY_NOT_FOUND"
  | "NO_SOURCE_PIN"
  | "CONFIRMATION_REQUIRED"
  | "SOURCE_NOT_HYDRATED"
  | "PATH_TRAVERSAL"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "SCENARIO_NOT_FOUND"
  | "SUITE_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "COMPILE_FAILED"
  | "INTERNAL_ERROR";

export interface ToolErrorEnvelope {
  error: {
    code: ToolErrorCode;
    message: string;
    pointer?: string;
  };
}

/** Expected, user-visible failure: carries a machine code instead of a stack. */
export class ToolFailure extends Error {
  readonly code: ToolErrorCode;
  readonly pointer?: string;

  constructor(code: ToolErrorCode, message: string, pointer?: string) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    if (pointer !== undefined) this.pointer = pointer;
  }
}

export function failureEnvelope(code: ToolErrorCode, message: string, pointer?: string): ToolErrorEnvelope {
  const error: ToolErrorEnvelope["error"] = { code, message };
  if (pointer !== undefined) error.pointer = pointer;
  return { error };
}

/** Map any thrown value onto the structured envelope; stack traces never escape. */
export function toFailureEnvelope(err: unknown): ToolErrorEnvelope {
  if (err instanceof ToolFailure) {
    return failureEnvelope(err.code, err.message, err.pointer);
  }
  const message = err instanceof Error ? err.message : String(err);
  return failureEnvelope("INTERNAL_ERROR", message);
}
