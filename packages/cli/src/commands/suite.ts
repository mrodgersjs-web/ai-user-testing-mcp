/**
 * `rig-testlab suite compile|run` and `run wait`.
 *
 * compile — ProjectManifest + ScenarioSpec[] + adapter registry → queued
 *           RunManifests in the store. CompileError (bad input) exits 2 with
 *           the violating JSON pointer. Governance refusals are reported per
 *           scenario and never fake a schedulable run.
 * run     — compile, then execute queued manifests through @rig-testlab/runner
 *           (fail-closed preflight inside; spawner injectable). Paid adapters
 *           are refused at the CLI level unless --budget-scenarios AND
 *           --budget-credits are given (or the scenario declares its budget);
 *           the runner's preflight remains the last line of defense.
 * run wait— poll the store until every watched run is terminal; blocked /
 *           not_evaluated / cancelled render with their failureDetail and keep
 *           the exit code nonzero.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CompileError,
  compileSuite,
  summarizeRuns,
  type CompileRefusal,
  type CompileSuiteResult,
  type ProjectManifest,
  type SelectableAdapter,
} from "@rig-testlab/scenario-compiler";
import { childProcessSpawner, executeRun, TERMINAL_STATES } from "@rig-testlab/runner";
import type { AdapterDescriptor, RunManifest, ScenarioSpec } from "@rig-testlab/catalog";
import type { Ctx } from "../context.js";
import { CommandFailure, UsageError } from "../errors.js";
import type { AdapterDescriptor, RunManifest, RunState, ScenarioSpec } from "@rig-testlab/catalog";
import { bool, intOpt, str, strs } from "../opts.js";
import { catalogLockPath } from "./catalog.js";
import { loadAdapters, selectableAdapters } from "../adapters.js";
import { listRunIds, readManifest, saveManifest } from "../store.js";

export const SUITE_HELP = `rig-testlab suite <subcommand>

  compile --project <manifest.json> --scenarios <scenarios.json>
          [--adapters-dir <dir>] [--estimates <credits-by-adapter.json>]
          [--budget-scenarios N --budget-credits C] [--lock <file>] [--root <dir>] [--json]
  run     <same inputs> [--execute-id ...filter] [--json]
          Executes queued runs sequentially. Paid adapters REQUIRE
          --budget-scenarios and --budget-credits (or a scenario budget).`;

export const RUN_HELP = `rig-testlab run wait (--all | --run <runId> ...)
          [--timeout-s N] [--interval-ms N] [--store <dir>] [--json]

Polls <root>/.rig-testlab/store until every watched run reaches a terminal
state. Exit 0 only when all watched runs are terminal AND every one passed.`;

const TERMINAL_SET = new Set<string>(TERMINAL_STATES);
const RUN_STATES: readonly RunState[] = ["queued", "running", "passed", "failed", "blocked", "not_evaluated", "cancelled"];
interface SuiteInputs {
function isRunState(s: string): s is RunState {
  return (RUN_STATES as readonly string[]).includes(s);
}
  scenarios: ScenarioSpec[];
  adapters: SelectableAdapter[];
  descriptorsById: Record<string, AdapterDescriptor>;
  estimates: Record<string, number>;
}

function readJsonAs<T>(ctx: Ctx, flag: string, path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(
      "SUITE_INPUT_UNREADABLE",
      `${ctx.command}: cannot read --${flag} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      ctx.help,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new UsageError(
      "SUITE_INPUT_INVALID",
      `${ctx.command}: --${flag} ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ctx.help,
    );
  }
}

function suiteInputs(ctx: Ctx): SuiteInputs {
  const projectPath = str(ctx.values, "project");
  const scenariosPath = str(ctx.values, "scenarios");
  if (projectPath === undefined || scenariosPath === undefined) {
    throw new UsageError("USAGE", `${ctx.command}: --project and --scenarios are required`, ctx.help);
  }
  const project = readJsonAs<ProjectManifest>(ctx, "project", projectPath);
  const scenarios = readJsonAs<ScenarioSpec[]>(ctx, "scenarios", scenariosPath);
  if (!Array.isArray(scenarios)) {
    throw new UsageError("SUITE_INPUT_INVALID", `${ctx.command}: --scenarios must be a JSON array of ScenarioSpec`, ctx.help);
  }
  const adaptersDir = str(ctx.values, "adapters-dir") ?? ctx.paths.adaptersDir;
  if (adaptersDir === undefined) {
    throw new UsageError("ROOT_NOT_FOUND", `${ctx.command}: pass --adapters-dir <dir> or --root <dir>`, ctx.help);
  }
  const registry = loadAdapters(adaptersDir);
  if (registry.adapters.length === 0) {
    throw new CommandFailure("ADAPTERS_DIR_EMPTY", `suite: no adapter descriptors found under ${adaptersDir}`);
  }
  if (!registry.ok) {
    throw new CommandFailure("ADAPTER_REGISTRY_INVALID", "suite: adapter registry invalid; run `rig-testlab adapter list`", registry.adapters.flatMap((a) => a.errors));
  }
  let entries: Parameters<typeof selectableAdapters>[1] = [];
  try {
    const lockPath = str(ctx.values, "lock") ?? str(ctx.values, "fixture") ?? ctx.paths.lockPath;
    if (lockPath !== undefined) entries = loadLockFailClosed(lockPath).entries;
  } catch (err) {
    if (err instanceof UsageError) throw err; // malformed lock never degrades to hintless compile
    ctx.rep.warn(`suite: catalog lock unreadable (${err instanceof Error ? err.message : String(err)}); adapters compile untiered`);
  }
  const estimates =
    str(ctx.values, "estimates") === undefined
      ? {}
      : readJsonAs<Record<string, number>>(ctx, "estimates", str(ctx.values, "estimates")!);
  return {
    project,
    scenarios,
    adapters: selectableAdapters(registry, entries),
    descriptorsById: Object.fromEntries(registry.adapters.flatMap((a) => (a.descriptor === undefined ? [] : [[a.descriptor.id, a.descriptor]]))),
    estimates,
  };
}

/**
 * CLI-level paid gate (stricter than the compiler's per-scenario guard):
 * when any scenario's required adapters include a paid provider and that
 * scenario carries no budget, BOTH --budget-scenarios and --budget-credits
 * are required; the declared budgets are then injected into those scenarios.
 */
function applyPaidBudgetGate(ctx: Ctx, scenarios: ScenarioSpec[], adapters: readonly SelectableAdapter[]): void {
  const paidById: Record<string, SelectableAdapter> = {};
  for (const a of adapters) if (a.paidProvider) paidById[a.id] = a;
  const needsBudget = scenarios.filter((s) => s.budget === undefined && s.requiredAdapters.some((id) => paidById[id] !== undefined));
  if (needsBudget.length === 0) return;
  const maxScenarios = intOpt(ctx.values, "budget-scenarios", -1, 1, 100_000, ctx.command, ctx.help);
  const maxCredits = intOpt(ctx.values, "budget-credits", -1, 0, 1_000_000, ctx.command, ctx.help);
  if (maxScenarios === -1 || maxCredits === -1) {
    const paidIds = [...new Set(needsBudget.flatMap((s) => s.requiredAdapters.filter((id) => paidById[id] !== undefined)))];
    throw new CommandFailure(
      "BUDGET_REQUIRED",
      `suite ${ctx.command.split(" ")[1] ?? ""}: paid adapter(s) ${paidIds.join(", ")} selected without spend limits. Refusing to run paid providers; pass --budget-scenarios and --budget-credits (or give each scenario a budget).`.trim(),
    );
  }
  for (const s of needsBudget) {
    s.budget = { maxScenarios, maxEstimatedCredits: maxCredits };
  }
  ctx.rep.warn(`paid budget injected: maxScenarios=${String(maxScenarios)} maxEstimatedCredits=${String(maxCredits)} for ${String(needsBudget.length)} scenario(s)`);
}

function compileForCli(ctx: Ctx, inputs: SuiteInputs): CompileSuiteResult {
  try {
    return compileSuite({
      projectManifest: inputs.project,
      scenarios: inputs.scenarios,
      adapters: inputs.adapters,
      adapterCreditEstimates: inputs.estimates,
    });
  } catch (err) {
    if (err instanceof CompileError) {
      throw new UsageError("SUITE_COMPILE_INVALID", `${ctx.command}: ${err.message}`, ctx.help, [
        `${err.input} pointer: ${err.pointer}`,
      ]);
    }
    throw err;
  }
}

function reportCompile(ctx: Ctx, compiled: CompileSuiteResult, storeRoot: string): void {
  for (const m of compiled.manifests) {
    saveManifest(storeRoot, m);
    ctx.rep.line(`${m.state.padEnd(13)} ${m.runId}  ${m.scenarioId} -> ${m.adapterId} est=${String(m.credits.estimated)}cr`);
  }
  for (const r of compiled.refusals) {
    ctx.rep.line(`REFUSED     ${r.scenarioId}: ${r.reason}`);
  }
  const summary = summarizeRuns(compiled.manifests);
  ctx.rep.line(`compiled: ${String(compiled.manifests.length)} manifest(s) (queued=${String(summary.queued)} not_evaluated=${String(summary.notEvaluated)}), ${String(compiled.refusals.length)} refusal(s)`);
}

export async function suiteCompile(ctx: Ctx): Promise<number> {
  const inputs = suiteInputs(ctx);
  applyPaidBudgetGate(ctx, inputs.scenarios, inputs.adapters);
  const compiled = compileForCli(ctx, inputs);
  const storeRoot = requireStoreRoot(ctx);
  reportCompile(ctx, compiled, storeRoot);
  finishSuiteCommand(ctx, compiled);
  return compiledExitCode(compiled);
}

export async function suiteRun(ctx: Ctx): Promise<number> {
  const inputs = suiteInputs(ctx);
  applyPaidBudgetGate(ctx, inputs.scenarios, inputs.adapters);
  const compiled = compileForCli(ctx, inputs);
  const storeRoot = requireStoreRoot(ctx);
  reportCompile(ctx, compiled, storeRoot);
  const onlyIds = strs(ctx.values, "run");
  const executed: RunManifest[] = [];
  for (const manifest of compiled.manifests) {
    if (manifest.state !== "queued") {
      executed.push(manifest);
      continue;
    }
    if (onlyIds.length > 0 && !onlyIds.includes(manifest.runId)) continue;
    const descriptor = inputs.descriptorsById[manifest.adapterId];
    if (descriptor === undefined) {
      throw new CommandFailure("ADAPTER_REGISTRY_INVALID", `suite run: compiled manifest ${manifest.runId} references unknown adapter ${manifest.adapterId}`);
    }
    const argv = descriptor.commandAllowlist[0];
    if (argv === undefined || argv.length === 0) {
      manifest.state = "blocked";
      manifest.failureDetail = "empty_command_allowlist";
      saveManifest(storeRoot, manifest);
      executed.push(manifest);
      ctx.rep.line(`blocked      ${manifest.runId}  empty_command_allowlist`);
      continue;
    }
    const finished = await executeRun(manifest, descriptor, {
      argv,
      baseDir: join(ctx.paths.root ?? ctx.deps.cwd ?? ".", ".rig-testlab", "sandbox"),
      storeRoot,
      requiredEvidence: [],
      ...(intOpt(ctx.values, "budget-credits", -1, 0, 1_000_000, ctx.command, ctx.help) === -1
        ? {}
        : { scenarioMaxCredits: intOpt(ctx.values, "budget-credits", -1, 0, 1_000_000, ctx.command, ctx.help) }),
      ...(ctx.deps.spawner === undefined ? { spawner: childProcessSpawner() } : { spawner: ctx.deps.spawner }),
      ...(ctx.deps.toolChecker === undefined ? {} : { toolChecker: ctx.deps.toolChecker }),
      ...(ctx.env === undefined ? {} : { env: ctx.env }),
    });
    saveManifest(storeRoot, finished);
    executed.push(finished);
    ctx.rep.line(`${finished.state.padEnd(13)} ${finished.runId}  ${finished.failureDetail ?? ""}`.trimEnd());
  }
  finishSuiteCommand(ctx, { manifests: executed, refusals: compiled.refusals });
  return runStatesExitCode(executed, compiled.refusals);
}

function requireStoreRoot(ctx: Ctx): string {
  if (ctx.paths.storeRoot === null) {
    throw new UsageError("ROOT_NOT_FOUND", `${ctx.command}: the run store lives in the repo; pass --root <dir>`, ctx.help);
  }
  return ctx.paths.storeRoot;
}

function finishSuiteCommand(ctx: Ctx, compiled: CompileSuiteResult): void {
  ctx.rep.result("suite", {
    manifests: compiled.manifests,
    refusals: compiled.refusals,
    summary: summarizeRuns(compiled.manifests),
  });
}

function compiledExitCode(compiled: CompileSuiteResult): number {
  if (compiled.manifests.length === 0 && compiled.refusals.length > 0) return 1;
  return compiled.manifests.every((m) => m.state !== "failed" && m.state !== "blocked") ? 0 : 1;
}

function runStatesExitCode(runs: readonly RunManifest[], refusals: readonly CompileRefusal[]): number {
  const summary = summarizeRuns(runs);
  const nonPassing =
    summary.failed + summary.blocked + summary.notEvaluated + summary.cancelled + summary.running + summary.queued;
  if (refusals.length > 0 && runs.length === 0) return 1;
  return nonPassing === 0 ? 0 : 1;
}

export async function runWait(ctx: Ctx): Promise<number> {
  if (ctx.positionals[0] === "wait") ctx.positionals.shift();
  const storeRoot = str(ctx.values, "store") ?? ctx.paths.storeRoot;
  if (storeRoot === undefined || !existsSync(storeRoot)) {
    throw new CommandFailure("STORE_MISSING", `run wait: no run store${storeRoot === undefined ? "" : ` at ${storeRoot}`}; run \`rig-testlab suite run\` first`);
  }
  const ids = strs(ctx.values, "run");
  const watchAll = bool(ctx.values, "all");
  if (ids.length === 0 && !watchAll) {
    throw new UsageError("USAGE", "run wait: pass --run <runId> (repeatable) or --all", ctx.help);
  }
  const wanted = watchAll ? listRunIds(storeRoot) : ids;
  if (wanted.length === 0) throw new CommandFailure("RUN_NOT_FOUND", "run wait: run store contains no manifests");
  const timeoutS = intOpt(ctx.values, "timeout-s", 30, 1, 86_400, "run wait", ctx.help);
  const intervalMs = intOpt(ctx.values, "interval-ms", 100, 1, 60_000, "run wait", ctx.help);
  const sleep = ctx.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const deadline = Date.now() + timeoutS * 1000;
  let last: Array<{ id: string; state: string; failureDetail: string | null }> = [];
  for (;;) {
    last = wanted.map((id) => {
      const read = readManifest(storeRoot, id);
      if (!read.ok) return { id, state: "missing", failureDetail: read.reason };
      return { id, state: read.manifest.state, failureDetail: read.manifest.failureDetail ?? null };
    });
    const settled = last.every((r) => TERMINAL_SET.has(r.state));
    if (settled || Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  const missing = last.filter((r) => r.state === "missing");
  for (const r of last) ctx.rep.line(`${r.state.padEnd(13)} ${r.id}  ${r.failureDetail ?? ""}`.trimEnd());
  const summary = summarizeRuns(last.map((r) => ({ state: r.state }) as RunManifest));
  ctx.rep.result("run wait", { runs: last, settled: last.every((r) => TERMINAL_SET.has(r.state)), summary });
  if (missing.length > 0) {
    throw new CommandFailure("RUN_NOT_FOUND", `run wait: ${String(missing.length)} watched run(s) have no manifest`, missing.map((m) => m.failureDetail ?? m.id));
  }
  if (!last.every((r) => TERMINAL_SET.has(r.state))) {
    throw new CommandFailure("RUN_WAIT_TIMEOUT", `run wait: not terminal after ${String(timeoutS)}s`, last.filter((r) => !TERMINAL_SET.has(r.state)).map((r) => `${r.id}=${r.state}`));
  }
  return last.every((r) => r.state === "passed") ? 0 : 1;
}
