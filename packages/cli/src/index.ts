/**
 * rig-testlab entry: argv → route table → command context → exit code.
 *
 * run() is the test seam (inject every dep); main.ts binds process globals.
 * Exit taxonomy: 0 success · 1 honest failure/refusal · 2 usage/validation.
 */
import type { ParseArgsOptionsConfig } from "node:util";

import type { CliDeps } from "./deps.js";
import type { Ctx } from "./context.js";
import { CliError, HelpRequested, UsageError } from "./errors.js";
import { parseOpts, str, type OptValues } from "./opts.js";
import { Reporter } from "./output.js";
import { resolvePaths } from "./paths.js";
import { doctor, DOCTOR_HELP } from "./commands/doctor.js";
import {
  catalogSync,
  catalogVerify,
  catalogSearch,
  catalogShow,
  catalogStats,
  CATALOG_HELP,
  catalogSubHelp,
} from "./commands/catalog.js";
import { sourceStatus, sourceHydrate, SOURCE_HELP } from "./commands/source.js";
import { adapterList, adapterHealth, adapterPromote, ADAPTER_HELP } from "./commands/adapter.js";
import { suiteCompile, suiteRun, runWait, SUITE_HELP, RUN_HELP } from "./commands/suite.js";
import { evidenceVerify, evidenceReport, EVIDENCE_HELP } from "./commands/evidence.js";
import { installGlobal, INSTALL_HELP } from "./commands/install.js";

export const GLOBAL_HELP = `rig-testlab — governed AI user-testing

  doctor                              environment + lock + index + adapter checks
  catalog <sync|verify|search|show|stats>
  source  <status|hydrate>
  adapter <list|health|promote>
  suite   <compile|run>
  run     wait
  evidence <verify|report>
  install-global                      six-harness agent installer (operator only)
  help    [command]

Global flags: --json (machine output) · --root <dir> (repo-root override)
Exit codes: 0 success · 1 honest failure · 2 usage/validation`;

type Handler = (ctx: Ctx) => Promise<number>;

interface Route {
  handler: Handler;
  help: string;
  flags: ParseArgsOptionsConfig;
}

const s = { type: "string" } as const;
const b = { type: "boolean" } as const;

/** Flags each command module actually reads (inventoried against src/commands). */
const ROUTES: Record<string, Route> = {
  doctor: { handler: doctor, help: DOCTOR_HELP, flags: { lock: s } },
  "catalog sync": { handler: catalogSync, help: catalogSubHelp["sync"] ?? CATALOG_HELP, flags: { fixture: s, out: s, nested: b, lock: s } },
  "catalog verify": { handler: catalogVerify, help: catalogSubHelp["verify"] ?? CATALOG_HELP, flags: { fixture: s, lock: s } },
  "catalog search": { handler: catalogSearch, help: CATALOG_HELP, flags: { fixture: s, lock: s, limit: s } },
  "catalog show": { handler: catalogShow, help: CATALOG_HELP, flags: { fixture: s, lock: s } },
  "catalog stats": { handler: catalogStats, help: CATALOG_HELP, flags: { fixture: s, lock: s } },
  "source status": { handler: sourceStatus, help: SOURCE_HELP, flags: { all: b, lock: s, fixture: s } },
  "source hydrate": { handler: sourceHydrate, help: SOURCE_HELP, flags: { all: b, confirm: b, lock: s, fixture: s } },
  "adapter list": { handler: adapterList, help: ADAPTER_HELP, flags: { "adapters-dir": s } },
  "adapter health": { handler: adapterHealth, help: ADAPTER_HELP, flags: { "adapters-dir": s, id: s } },
  "adapter promote": { handler: adapterPromote, help: ADAPTER_HELP, flags: { "adapters-dir": s, by: s, note: s, id: s } },
  "suite compile": {
    handler: suiteCompile,
    help: SUITE_HELP,
    flags: { project: s, scenarios: s, estimates: s, "adapters-dir": s, lock: s, fixture: s, out: s, store: s, "budget-credits": s, "budget-scenarios": s },
  },
  "suite run": {
    handler: suiteRun,
    help: SUITE_HELP,
    flags: { project: s, scenarios: s, estimates: s, "adapters-dir": s, lock: s, store: s, "budget-credits": s, "budget-scenarios": s, all: b },
  },
  "run wait": { handler: runWait, help: RUN_HELP, flags: { all: b, "interval-ms": s, "timeout-s": s, store: s } },
  "evidence verify": { handler: evidenceVerify, help: EVIDENCE_HELP, flags: { store: s, all: b } },
  "evidence report": { handler: evidenceReport, help: EVIDENCE_HELP, flags: { store: s, out: s, all: b } },
  "install-global": {
    handler: installGlobal,
    help: INSTALL_HELP,
    flags: { manifest: s, home: s, check: b, apply: b, "i-understand-operator-only": b },
  },
};

function resolveRoute(positionals: readonly string[]): { path: string; rest: readonly string[] } {
  const [first, second] = positionals;
  if (first === undefined) return { path: "", rest: [] };
  if (first === "help") {
    const topic = second === undefined ? "" : positionals.slice(1).join(" ");
    throw new HelpRequested(topic === "" ? GLOBAL_HELP : (ROUTES[topic]?.help ?? GLOBAL_HELP));
  }
  if (first === "run" && second === "wait") return { path: "run wait", rest: positionals.slice(2) };
  if (first === "install-global") return { path: "install-global", rest: positionals.slice(1) };
  if (first === "doctor") return { path: "doctor", rest: positionals.slice(1) };
  if (second !== undefined && ROUTES[`${first} ${second}`] !== undefined) {
    return { path: `${first} ${second}`, rest: positionals.slice(2) };
  }
  if (ROUTES[first] !== undefined) return { path: first, rest: positionals.slice(1) };
  const known = [...new Set(Object.keys(ROUTES).map((r) => r.split(" ")[0]))].join(", ");
  throw new UsageError("UNKNOWN_COMMAND", `unknown command: ${positionals.join(" ")} (known: ${known})`, GLOBAL_HELP);
}

/** Flags valid for every route (read by run() itself, not by command modules). */
const GLOBAL_FLAGS: ParseArgsOptionsConfig = { json: b, root: s };

export async function run(deps: CliDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const argv = [...deps.argv];

  // Pre-scan for --json/--root so reporting + path resolution work before route parsing.
  const json = argv.includes("--json");
  const rep = new Reporter(json, out, err);

  let command = "";
  try {
    const { path, rest } = resolveRoute(argv);
    if (path === "") throw new HelpRequested(GLOBAL_HELP);
    const route = ROUTES[path]!;
    command = path;
    const { values, positionals } = parseOpts(rest, { ...GLOBAL_FLAGS, ...route.flags }, path, route.help);
    if (values["help"] === true || positionals[0] === "help") throw new HelpRequested(route.help);
    const cwd = deps.cwd ?? process.cwd();
    const paths = resolvePaths({
      root: str(values, "root") ?? deps.root,
      lock: str(values, "lock"),
      store: str(values, "store"),
      adaptersDir: str(values, "adapters-dir"),
      cwd,
    });
    const ctx: Ctx = {
      deps,
      env: deps.env ?? process.env,
      paths,
      rep,
      command: path,
      help: route.help,
      values: values as OptValues,
      positionals,
    };
    return await route.handler(ctx);
  } catch (e) {
    if (e instanceof HelpRequested) {
      rep.line(e.text);
      return 0;
    }
    if (e instanceof CliError) {
      if (!json) {
        err(`error[${e.errorName}]: ${e.message}`);
        for (const d of e.details) err(`  ${d}`);
        if (e instanceof UsageError && e.help !== "") err(e.help);
      }
      rep.failure(command || "rig-testlab", e);
      return e.exitCode;
    }
    throw e;
  }
}

export type { CliDeps } from "./deps.js";
export type { Ctx } from "./context.js";
export { CliError, UsageError, CommandFailure, HelpRequested } from "./errors.js";
