import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScenarioSpec } from "@rig-testlab/catalog";
import { CompileError, compileSuite, summarizeRuns } from "./compile.js";
import type { CompileSuiteInput, CompileSuiteResult } from "./compile.js";
import { getValidator } from "./manifest-schema.js";
import type { ProjectManifest } from "./project-manifest.js";
import type { SelectableAdapter } from "./select.js";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../testdata/${name}`, import.meta.url), "utf8")) as T;

const projectManifest = (): ProjectManifest => fixture<ProjectManifest>("project.json");
const adapters = (): SelectableAdapter[] => fixture<SelectableAdapter[]>("adapters.json");
const baseScenarios = (): ScenarioSpec[] => fixture<ScenarioSpec[]>("scenarios.json");

function compile(partial: Partial<CompileSuiteInput> = {}): CompileSuiteResult {
  return compileSuite({
    projectManifest: projectManifest(),
    scenarios: baseScenarios(),
    adapters: adapters(),
    adapterCreditEstimates: {},
    ...partial
  });
}

function scenarioWith(overrides: Partial<ScenarioSpec>): ScenarioSpec {
  return {
    ...structuredClone(baseScenarios()[1]!),
    ...overrides,
    id: overrides.id ?? "s-single"
  };
}

describe("compileSuite — happy path", () => {
  it("compiles every scenario into a queued manifest with the tier-preferred adapter", () => {
    const { manifests, refusals } = compile({ adapterCreditEstimates: { "core-runner": 4 } });
    expect(refusals).toEqual([]);
    expect(manifests).toHaveLength(2);
    expect(manifests.map((m) => m.state)).toEqual(["queued", "queued"]);
    expect(manifests.map((m) => m.adapterId)).toEqual(["core-runner", "core-runner"]);
    expect(manifests.map((m) => m.runId)).toEqual(["s-checkout-1", "s-signin-1"]);
    expect(manifests[0]!.credits).toEqual({ estimated: 4, consumed: 0 });
    expect(manifests.every((m) => m.startedAt === null && m.finishedAt === null)).toBe(true);
    expect(manifests.every((m) => m.commands.length === 0 && m.artifacts.length === 0)).toBe(true);
  });

  it("defaults estimated credits to 0 for adapters with no credit estimate", () => {
    const { manifests } = compile();
    expect(manifests[0]!.credits.estimated).toBe(0);
  });

  it("every generated manifest validates against the frozen RunManifest schema", () => {
    const runManifest = getValidator("RunManifest.v1.schema.json");
    const { manifests } = compile();
    for (const manifest of manifests) {
      expect(runManifest(manifest), JSON.stringify(runManifest.errors)).toBe(true);
    }
  });

  it("mints unique runIds for repeated scenario ids", () => {
    const scenarios = [...baseScenarios(), structuredClone(baseScenarios()[1]!)];
    const { manifests } = compile({ scenarios });
    expect(manifests.map((m) => m.runId)).toEqual(["s-checkout-1", "s-signin-1", "s-signin-2"]);
  });
});

describe("compileSuite — refusals", () => {
  it("refuses scenarios whose required adapter is unknown", () => {
    const { manifests, refusals } = compile({
      scenarios: [scenarioWith({ requiredAdapters: ["ghost-runner"] })]
    });
    expect(manifests).toEqual([]);
    expect(refusals).toEqual([{ scenarioId: "s-single", reason: "unknown_adapter:ghost-runner" }]);
  });

  it("refuses experimental and retired adapters (reviewed-only)", () => {
    const experimental = scenarioWith({ id: "s-exp", requiredAdapters: ["experimental-runner"] });
    const retired = scenarioWith({ id: "s-ret", requiredAdapters: ["retired-runner"] });
    const mixed = scenarioWith({
      id: "s-mixed",
      requiredAdapters: ["core-runner", "experimental-runner"]
    });
    const { refusals } = compile({ scenarios: [experimental, retired, mixed] });
    expect(refusals).toEqual([
      { scenarioId: "s-exp", reason: "adapter_not_reviewed:experimental-runner" },
      { scenarioId: "s-ret", reason: "adapter_not_reviewed:retired-runner" },
      { scenarioId: "s-mixed", reason: "adapter_not_reviewed:experimental-runner" }
    ]);
  });

  it("refuses a paid adapter when the scenario has no budget and paidGuards do not cover the estimate", () => {
    const paid = scenarioWith({
      id: "s-paid",
      platforms: ["ai"],
      requiredAdapters: ["paid-runner"],
      requiredEvidence: ["json_report"]
    });
    const refused = compile({ scenarios: [paid], adapterCreditEstimates: { "paid-runner": 50 } });
    expect(refused.refusals).toEqual([{ scenarioId: "s-paid", reason: "budget_required:paid-runner" }]);
    expect(refused.manifests).toEqual([]);

    const withBudget = compile({
      scenarios: [{ ...paid, budget: { maxScenarios: 9, maxEstimatedCredits: 60 } }],
      adapterCreditEstimates: { "paid-runner": 50 }
    });
    expect(withBudget.refusals).toEqual([]);
    expect(withBudget.manifests[0]!.state).toBe("queued");
    expect(withBudget.manifests[0]!.credits.estimated).toBe(50);
  });

  it("accepts a paid adapter without scenario budget when its paidGuards cover the estimate", () => {
    const paidCheap = scenarioWith({
      id: "s-paid-cheap",
      platforms: ["ai"],
      requiredAdapters: ["paid-runner"],
      requiredEvidence: ["json_report"]
    });
    const guarded = scenarioWith({
      id: "s-paid-guarded",
      requiredAdapters: ["paid-guarded"],
      requiredEvidence: ["json_report"]
    });
    const { refusals, manifests } = compile({
      scenarios: [paidCheap, guarded],
      adapterCreditEstimates: { "paid-runner": 5, "paid-guarded": 50 }
    });
    expect(refusals).toEqual([]);
    expect(manifests.map((m) => m.state)).toEqual(["queued", "queued"]);
  });

  it("refuses with no_compatible_adapter when selection finds nothing (empty requiredEvidence gate)", () => {
    const apiOnly = scenarioWith({ id: "s-api", platforms: ["api"], requiredAdapters: ["core-runner"] });
    const { refusals } = compile({ scenarios: [apiOnly] });
    expect(refusals).toEqual([{ scenarioId: "s-api", reason: "no_compatible_adapter" }]);
  });
});

describe("compileSuite — maxScenarios cap", () => {
  it("lands scenarios beyond the cap in not_evaluated, never passed, without consuming slots for refusals", () => {
    const scenarios = baseScenarios().map((s, i) =>
      i === 0 ? { ...structuredClone(s), budget: { maxScenarios: 2 } } : structuredClone(s)
    );
    scenarios.push(scenarioWith({ id: "s-third", requiredAdapters: ["core-runner"], requiredEvidence: ["screenshot"] }));
    const ghost = scenarioWith({ id: "s-ghost", requiredAdapters: ["ghost-runner"] });
    // Refusal arrives before the cap gate: it must NOT consume a scheduled slot.
    scenarios.push(ghost, scenarioWith({ id: "s-fourth", requiredAdapters: ["approved-runner"], requiredEvidence: ["screenshot"] }));

    const { manifests, refusals } = compile({ scenarios });
    expect(refusals).toEqual([{ scenarioId: "s-ghost", reason: "unknown_adapter:ghost-runner" }]);
    expect(manifests.map((m) => m.state)).toEqual(["queued", "queued", "not_evaluated", "not_evaluated"]);
    expect(manifests.map((m) => m.runId)).toEqual([
      "s-checkout-1",
      "s-signin-1",
      "s-third-1",
      "s-fourth-1"
    ]);
    expect(manifests[2]!.failureDetail).toBe("scenario_budget_exhausted");
    expect(manifests[3]!.failureDetail).toBe("scenario_budget_exhausted");
    expect(manifests.slice(0, 2).every((m) => m.failureDetail === undefined)).toBe(true);
    expect(summarizeRuns(manifests).passed).toBe(0);
  });
});

describe("summarizeRuns", () => {
  it("buckets every state exactly", () => {
    const summary = summarizeRuns([
      { state: "passed" },
      { state: "passed" },
      { state: "failed" },
      { state: "blocked" },
      { state: "not_evaluated" },
      { state: "not_evaluated" },
      { state: "cancelled" },
      { state: "running" },
      { state: "queued" }
    ]);
    expect(summary).toEqual({
      passed: 2,
      failed: 1,
      blocked: 1,
      notEvaluated: 2,
      cancelled: 1,
      running: 1,
      queued: 1
    });
  });

  it("planted: blocked, not_evaluated, cancelled, running, queued, failed NEVER count as passed", () => {
    for (const state of ["blocked", "not_evaluated", "cancelled", "running", "queued", "failed"] as const) {
      expect(summarizeRuns([{ state }, { state }, { state }]).passed, `state=${state}`).toBe(0);
    }
    expect(summarizeRuns([{ state: "passed" }, { state: "blocked" }]).passed).toBe(1);
  });
});

describe("compileSuite — malformed inputs throw CompileError with a JSON pointer", () => {
  it("scenario step missing `expected`", () => {
    const broken = scenarioWith({ steps: [{ action: "click", target: "#x" } as ScenarioSpec["steps"][number]] });
    try {
      compile({ scenarios: [broken] });
      expect.unreachable("expected CompileError");
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      const failure = err as CompileError;
      expect(failure.name).toBe("CompileError");
      expect(failure.pointer).toBe("/steps/0/expected");
      expect(failure.input).toBe("scenarios[0]");
      expect(failure.message).toContain("/steps/0/expected");
    }
  });

  it("scenario id violating the slug pattern", () => {
    const broken = scenarioWith({ id: "BAD_ID" });
    try {
      compile({ scenarios: [broken] });
      expect.unreachable("expected CompileError");
    } catch (err) {
      expect((err as CompileError).pointer).toBe("/id");
    }
  });

  it("project manifest missing repo", () => {
    const pm = structuredClone(projectManifest()) as unknown as Record<string, unknown>;
    delete pm["repo"];
    try {
      compile({ projectManifest: pm as unknown as ProjectManifest });
      expect.unreachable("expected CompileError");
    } catch (err) {
      const failure = err as CompileError;
      expect(failure.input).toBe("projectManifest");
      expect(failure.pointer).toBe("/repo");
    }
  });

  it("adapter missing limits", () => {
    const broken = structuredClone(adapters()[0]!) as unknown as Record<string, unknown>;
    delete broken["limits"];
    try {
      compile({ adapters: [broken as unknown as SelectableAdapter] });
      expect.unreachable("expected CompileError");
    } catch (err) {
      const failure = err as CompileError;
      expect(failure.input).toBe("adapters[0]");
      expect(failure.pointer).toBe("/limits");
    }
  });
});
