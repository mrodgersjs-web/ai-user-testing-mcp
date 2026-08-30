import type { RunManifest, ScenarioSpec } from "@rig-testlab/catalog";
import { firstViolationPointer, getValidator } from "./manifest-schema.js";
import type { SchemaName } from "./manifest-schema.js";
import { selectRunner } from "./select.js";
import type { SelectableAdapter } from "./select.js";
import type { ProjectManifest } from "./project-manifest.js";

/** Malformed input or fail-closed self-check failure; carries the first violating JSON pointer. */
export class CompileError extends Error {
  readonly input: string;
  readonly pointer: string;

  constructor(input: string, pointer: string, detail: string) {
    super(`${input} invalid at ${pointer}: ${detail}`);
    this.name = "CompileError";
    this.input = input;
    this.pointer = pointer;
  }
}

export interface CompileSuiteInput {
  projectManifest: ProjectManifest;
  scenarios: readonly ScenarioSpec[];
  adapters: readonly SelectableAdapter[];
  /** Estimated credits per scenario consumption per adapter id; missing entry ⇒ 0. */
  adapterCreditEstimates: Readonly<Record<string, number>>;
}

export interface CompileRefusal {
  scenarioId: string;
  reason: string;
}

export interface CompileSuiteResult {
  manifests: RunManifest[];
  refusals: CompileRefusal[];
}

/** Selection-hint keys stripped before validating an adapter against the frozen wire schema. */
const HINT_KEYS = ["adoptionTier", "platforms"] as const;

function withoutSelectionHints(adapter: SelectableAdapter): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...adapter };
  for (const key of HINT_KEYS) delete copy[key];
  return copy;
}

function assertValid(input: string, data: unknown, schema: SchemaName): void {
  const validate = getValidator(schema);
  if (validate(data)) return;
  const err = validate.errors?.[0];
  throw new CompileError(input, firstViolationPointer(validate.errors), err?.message ?? "no detail");
}

/**
 * Suite-wide scenario cap: the minimum `budget.maxScenarios` declared by any
 * scenario's budget (the budget travels with each scenario; the compiler
 * honors the tightest one). No declared cap ⇒ every schedulable scenario runs.
 */
function effectiveScenarioCap(scenarios: readonly ScenarioSpec[]): number {
  let cap = scenarios.length;
  for (const scenario of scenarios) {
    const max = scenario.budget?.maxScenarios;
    if (max !== undefined) cap = Math.min(cap, max);
  }
  return cap;
}

/**
 * A paid adapter may run only when the scenario carries a budget or the
 * adapter's own paidGuards demonstrably cover this run's estimated credits.
 */
function paidSpendGuarded(scenario: ScenarioSpec, adapter: SelectableAdapter, estimated: number): boolean {
  if (!adapter.paidProvider) return true;
  if (scenario.budget !== undefined) return true;
  const guards = adapter.paidGuards;
  return guards !== undefined && guards.maxScenarios >= 1 && guards.maxEstimatedCredits >= estimated;
}

/** First governance refusal for a scenario, in gate order: unknown → not-reviewed → unguarded-paid. */
function firstGateRefusal(
  scenario: ScenarioSpec,
  adaptersById: Record<string, SelectableAdapter>,
  estimates: Readonly<Record<string, number>>
): string | undefined {
  const missing = scenario.requiredAdapters.find((id: string) => adaptersById[id] === undefined);
  if (missing !== undefined) return `unknown_adapter:${missing}`;
  const unreviewed = scenario.requiredAdapters.find((id: string) => adaptersById[id]!.status !== "reviewed");
  if (unreviewed !== undefined) return `adapter_not_reviewed:${unreviewed}`;
  const unguarded = scenario.requiredAdapters.find(
    (id: string) => !paidSpendGuarded(scenario, adaptersById[id]!, estimates[id] ?? 0)
  );
  if (unguarded !== undefined) return `budget_required:${unguarded}`;
  return undefined;
}

function buildManifest(
  scenario: ScenarioSpec,
  adapter: SelectableAdapter,
  runId: string,
  estimated: number,
  capped: boolean
): RunManifest {
  const manifest: RunManifest = {
    runId,
    scenarioId: scenario.id,
    adapterId: adapter.id,
    sandbox: {
      homeDir: `runs/${runId}/home`,
      worktree: `runs/${runId}/worktree`,
      readOnlySource: true,
      limitsApplied: true
    },
    state: capped ? "not_evaluated" : "queued",
    startedAt: null,
    finishedAt: null,
    commands: [],
    networkUsed: [],
    credits: { estimated, consumed: 0 },
    artifacts: [],
    redactionApplied: false
  };
  if (capped) manifest.failureDetail = "scenario_budget_exhausted";
  return manifest;
}

/**
 * Compile project scenarios into queued RunManifests. Every schedulable
 * scenario yields exactly one manifest in input order; ungovernable scenarios
 * yield refusals (unknown_adapter / adapter_not_reviewed / budget_required /
 * no_compatible_adapter) and never consume cap slots. Scenarios beyond the cap
 * are still compiled but land in state 'not_evaluated' with failureDetail
 * 'scenario_budget_exhausted' — never as passed.
 */
export function compileSuite(input: CompileSuiteInput): CompileSuiteResult {
  assertValid("projectManifest", input.projectManifest, "ProjectManifest.v1.schema.json");
  input.scenarios.forEach((scenario, i) =>
    assertValid(`scenarios[${i}]`, scenario, "ScenarioSpec.v1.schema.json")
  );
  input.adapters.forEach((adapter, i) =>
    assertValid(`adapters[${i}]`, withoutSelectionHints(adapter), "AdapterDescriptor.v1.schema.json")
  );

  const adaptersById: Record<string, SelectableAdapter> = {};
  for (const adapter of input.adapters) {
    if (adaptersById[adapter.id] === undefined) adaptersById[adapter.id] = adapter;
  }

  const cap = effectiveScenarioCap(input.scenarios);
  const runCounters: Record<string, number> = {};
  const manifests: RunManifest[] = [];
  const refusals: CompileRefusal[] = [];
  let scheduled = 0;

  for (const scenario of input.scenarios) {
    const gateRefusal = firstGateRefusal(scenario, adaptersById, input.adapterCreditEstimates);
    if (gateRefusal !== undefined) {
      refusals.push({ scenarioId: scenario.id, reason: gateRefusal });
      continue;
    }
    const selection = selectRunner(scenario, input.adapters);
    if ("reason" in selection) {
      refusals.push({ scenarioId: scenario.id, reason: selection.reason });
      continue;
    }
    runCounters[scenario.id] = (runCounters[scenario.id] ?? 0) + 1;
    const capped = scheduled >= cap;
    if (!capped) scheduled++;
    manifests.push(
      buildManifest(
        scenario,
        selection,
        `${scenario.id}-${runCounters[scenario.id]}`,
        input.adapterCreditEstimates[selection.id] ?? 0,
        capped
      )
    );
  }

  manifests.forEach((manifest, i) =>
    assertValid(`output manifests[${i}]`, manifest, "RunManifest.v1.schema.json")
  );
  return { manifests, refusals };
}

export interface RunSummary {
  passed: number;
  failed: number;
  blocked: number;
  notEvaluated: number;
  cancelled: number;
  running: number;
  queued: number;
}

/**
 * Aggregate run states. `passed` counts ONLY state === 'passed' — blocked,
 * not_evaluated, cancelled, running, queued, and failed never inflate it.
 */
export function summarizeRuns(runs: readonly Pick<RunManifest, "state">[]): RunSummary {
  const summary: RunSummary = {
    passed: 0,
    failed: 0,
    blocked: 0,
    notEvaluated: 0,
    cancelled: 0,
    running: 0,
    queued: 0
  };
  for (const run of runs) {
    switch (run.state) {
      case "passed":
        summary.passed++;
        break;
      case "failed":
        summary.failed++;
        break;
      case "blocked":
        summary.blocked++;
        break;
      case "not_evaluated":
        summary.notEvaluated++;
        break;
      case "cancelled":
        summary.cancelled++;
        break;
      case "running":
        summary.running++;
        break;
      case "queued":
        summary.queued++;
        break;
    }
  }
  return summary;
}
