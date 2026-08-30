/**
 * Shared command context assembled once per invocation by run().
 */
import type { CliDeps } from "./deps.js";
import type { Paths } from "./paths.js";
import type { Reporter } from "./output.js";
import type { OptValues } from "./opts.js";

export interface Ctx {
  deps: CliDeps;
  env: NodeJS.ProcessEnv;
  paths: Paths;
  rep: Reporter;
  /** Full command path, e.g. "catalog sync". */
  command: string;
  /** Command-specific help text, printed on `help` and on usage errors. */
  help: string;
  values: OptValues;
  positionals: string[];
}
