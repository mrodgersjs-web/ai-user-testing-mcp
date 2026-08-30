/**
 * node:util parseArgs per-subcommand parsing. Every failure (unknown flag,
 * missing value, wrong type) converts to a UsageError carrying the
 * command-specific help text — usage mistakes always exit 2.
 */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { UsageError } from "./errors.js";

export type OptValues = Record<string, string | boolean | Array<string | boolean> | undefined>;

export function parseOpts(
  argv: readonly string[],
  options: ParseArgsOptionsConfig,
  command: string,
  help: string,
): { values: OptValues; positionals: string[] } {
  try {
    const parsed = parseArgs({ args: [...argv], options, allowPositionals: true });
    return { values: parsed.values as OptValues, positionals: parsed.positionals };
  } catch (err) {
    throw new UsageError(
      "USAGE",
      `${command}: ${err instanceof Error ? err.message : String(err)}`,
      help,
    );
  }
}

/** String option value (undefined when absent or wrong type). */
export function str(values: OptValues, key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" ? v : undefined;
}

export function bool(values: OptValues, key: string): boolean {
  return values[key] === true;
}

/** Multi-value string option (`--id a --id b`). */
export function strs(values: OptValues, key: string): string[] {
  const v = values[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Integer option with bounds; absent ⇒ default; malformed ⇒ UsageError. */
export function intOpt(
  values: OptValues,
  key: string,
  fallback: number,
  min: number,
  max: number,
  command: string,
  help: string,
): number {
  const v = values[key];
  if (v === undefined) return fallback;
  const n = Number(typeof v === "string" ? v : "");
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError("USAGE", `${command}: --${key} must be an integer in [${min}, ${max}]`, help);
  }
  return n;
}
