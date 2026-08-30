/**
 * Dual-mode reporting. Human mode streams lines; --json mode prints exactly
 * one machine object per invocation (result or failure) and nothing else.
 * `passed` semantics never live here — commands pass only honest payloads.
 */
import type { CliError } from "./errors.js";

export class Reporter {
  constructor(
    private readonly json: boolean,
    private readonly out: (line: string) => void,
    private readonly err: (line: string) => void,
  ) {}

  /** Print a human line; suppressed entirely in --json mode. */
  line(text = ""): void {
    if (!this.json) this.out(text);
  }
  /** Print a human diagnostic line; suppressed in --json mode (the JSON error object carries it). */
  warn(text: string): void {
    if (!this.json) this.err(text);
  }

  /** Terminal success object (json mode only; human mode already streamed lines). */
  result(command: string, payload: Record<string, unknown>): void {
    if (this.json) this.out(JSON.stringify({ command, ok: true, ...payload }, null, 2));
  }

  /** Terminal failure object (json mode only). */
  failure(command: string, error: CliError): void {
    if (!this.json) return;
    this.out(
      JSON.stringify(
        {
          command,
          ok: false,
          error: {
            name: error.errorName,
            message: error.message,
            exitCode: error.exitCode,
            ...(error.details.length > 0 ? { details: error.details } : {}),
          },
        },
        null,
        2,
      ),
    );
  }
}
