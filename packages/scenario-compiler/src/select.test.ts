import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScenarioSpec } from "@rig-testlab/catalog";
import { NO_COMPATIBLE_ADAPTER, selectRunner } from "./select.js";
import type { SelectableAdapter } from "./select.js";

const adapters = (): SelectableAdapter[] =>
  JSON.parse(readFileSync(new URL("../testdata/adapters.json", import.meta.url), "utf8")) as SelectableAdapter[];

const scenarios = (): ScenarioSpec[] =>
  JSON.parse(readFileSync(new URL("../testdata/scenarios.json", import.meta.url), "utf8")) as ScenarioSpec[];

function spec(overrides: Partial<ScenarioSpec>): ScenarioSpec {
  return {
    id: "s-select",
    project: "transformfit",
    platforms: ["web"],
    title: "selection probe",
    steps: [{ action: "run", expected: "done" }],
    requiredAdapters: [],
    requiredEvidence: [],
    ...overrides
  };
}

describe("selectRunner", () => {
  it("prefers core_runner over approved_adapter over optional_adapter", () => {
    const chosen = selectRunner(scenarios()[0]!, adapters());
    expect("reason" in chosen).toBe(false);
    expect((chosen as SelectableAdapter).id).toBe("core-runner");
  });

  it("within a tier, higher requiredEvidence coverage wins even over lexical order", () => {
    const chosen = selectRunner(
      spec({ requiredAdapters: ["cov-zzz", "cov-aaa"], requiredEvidence: ["video", "screenshot"] }),
      adapters()
    );
    expect((chosen as SelectableAdapter).id).toBe("cov-zzz");
  });

  it("deterministic tie-break by adapter id ascending", () => {
    const pool = adapters();
    const forward = selectRunner(
      spec({ requiredAdapters: ["tie-aaa", "tie-zzz"], requiredEvidence: ["screenshot"] }),
      pool
    );
    const backward = selectRunner(
      spec({ requiredAdapters: ["tie-zzz", "tie-aaa"], requiredEvidence: ["screenshot"] }),
      [...pool].reverse()
    );
    expect((forward as SelectableAdapter).id).toBe("tie-aaa");
    expect((backward as SelectableAdapter).id).toBe("tie-aaa");
  });

  it("never selects experimental or retired adapters", () => {
    const chosen = selectRunner(
      spec({ requiredAdapters: ["experimental-runner", "retired-runner", "optional-runner"], requiredEvidence: ["screenshot"] }),
      adapters()
    );
    expect((chosen as SelectableAdapter).id).toBe("optional-runner");
  });

  it("respects the platform intersection when the adapter declares platforms", () => {
    const chosen = selectRunner(
      spec({ platforms: ["api"], requiredAdapters: ["core-runner"], requiredEvidence: ["screenshot"] }),
      adapters()
    );
    expect(chosen).toEqual({ reason: NO_COMPATIBLE_ADAPTER });
  });

  it("adapters without declared platforms are platform-neutral", () => {
    const chosen = selectRunner(
      spec({ platforms: ["api"], requiredAdapters: ["cov-zzz"], requiredEvidence: ["video"] }),
      adapters()
    );
    expect((chosen as SelectableAdapter).id).toBe("cov-zzz");
  });

  it("requires evidence intersection unless nothing is required", () => {
    const noEvidence = selectRunner(spec({ requiredAdapters: ["optional-runner"] }), adapters());
    expect((noEvidence as SelectableAdapter).id).toBe("optional-runner");
    const mismatch = selectRunner(
      spec({ requiredAdapters: ["optional-runner"], requiredEvidence: ["video"] }),
      adapters()
    );
    expect(mismatch).toEqual({ reason: NO_COMPATIBLE_ADAPTER });
  });

  it("only draws from spec.requiredAdapters", () => {
    const chosen = selectRunner(spec({ requiredAdapters: ["cov-aaa"], requiredEvidence: ["screenshot"] }), adapters());
    expect((chosen as SelectableAdapter).id).toBe("cov-aaa");
  });
});
