/**
 * Honest exit-code taxonomy for rig-testlab.
 *
 *   0 — command succeeded
 *   1 — command failure with honest state (CommandFailure: refusals,
 *       provider/tool unavailability, honest non-passing verdicts)
 *   2 — usage / validation failure (UsageError: bad flags, malformed lock,
 *       schema-invalid inputs — nothing downstream may proceed)
 *
 * Every error carries a distinct NAMED code so scripts and MCP callers can
 * branch on cause, never on prose.
 */
export abstract class CliError extends Error {
  abstract readonly exitCode: 1 | 2;
  abstract readonly errorName: string;
  /** Extra evidence lines (JSON-pointer paths, per-item failures). Printed under the headline. */
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.details = details;
  }
}

/** Exit 2: the invocation itself is invalid or its inputs fail validation. Carries command-specific help. */
export class UsageError extends CliError {
  readonly exitCode = 2 as const;
  readonly errorName: string;
  readonly help: string;

  constructor(errorName: string, message: string, help = "", details: readonly string[] = []) {
    super(message, details);
    this.errorName = errorName;
    this.help = help;
  }
}

/** Exit 1: a well-formed command that honestly could not succeed (or refused). */
export class CommandFailure extends CliError {
  readonly exitCode = 1 as const;
  readonly errorName: string;

  constructor(errorName: string, message: string, details: readonly string[] = []) {
    super(message, details);
    this.errorName = errorName;
  }
}

/** Control flow for explicit `help` requests — exit 0 after printing. */
export class HelpRequested extends Error {
  constructor(readonly text: string) {
    super("help requested");
    this.name = "HelpRequested";
  }
}
