/**
 * Adapter-set acceptance: schema validity, catalog provenance, and real
 * sandboxed execution through @rig-testlab/runner. Fixtures emulate tools with
 * node stdlib; paid/credential gates are proven with counting fake spawners.
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { executeRun, childProcessSpawner } from "@rig-testlab/runner";
import { verifyReceipt } from "@rig-testlab/evidence";
import { validateAgainstSchema } from "@rig-testlab/catalog";
import type { AdapterDescriptor, ArtifactKind, RunManifest } from "@rig-testlab/catalog";

const ROOT = resolve(import.meta.dirname, "..");
const LOCK = JSON.parse(readFileSync(join(ROOT, "catalog.lock.json"), "utf8")) as {
  entries: Array<{ id: string }>;
};
const LOCK_IDS = new Set(LOCK.entries.map((e) => e.id));

/**
 * Mission-designated core adapters whose TOOL REPO is not linked by
 * awesome-testing (docs-site links only, or absent entirely), plus the
 * first-party fixture pack. Rationale: the mission names these as required
 * reviewed adapters; their provenance is the mission directive itself, not a
 * catalog row — asserted here so the exemption is explicit, not silent.
 */
const MISSION_CORE_SOURCES: Record<string, true> = {
  "mission.core.cypress": true,
  "mission.core.cypress-axe": true,
  "mission.core.testsprite": true,
  "rig-testlab.first-party.malformed-fixtures": true,
};

const ADAPTER_SCHEMA_ID = "https://rig-testlab.dev/schemas/AdapterDescriptor/v1";

function loadAdapters(): Array<{ id: string; descriptor: AdapterDescriptor }> {
  return readdirSync(join(ROOT, "adapters"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      id: d.name,
      descriptor: JSON.parse(
        readFileSync(join(ROOT, "adapters", d.name, "adapter.json"), "utf8"),
      ) as AdapterDescriptor,
    }));
}

/**
 * Sandbox contract: argv may only name absolute paths inside baseDir, so
 * fixtures are staged beside the sandbox before execution (same lane the CLI
 * suite.run uses for scenario inputs).
 */
function stageFixture(baseDir: string, adapterId: string, relPath: string): string {
  const staged = join(baseDir, `fixture-${adapterId}.mjs`);
  copyFileSync(join(ROOT, "adapters", adapterId, relPath), staged);
  return staged;
}

function queuedManifest(runId: string, adapterId: string, estimatedCredits = 0): RunManifest {
  return {
    runId,
    scenarioId: `${runId}-scenario`,
    adapterId,
    sandbox: { homeDir: `runs/${runId}/home`, worktree: `runs/${runId}/worktree`, readOnlySource: true, limitsApplied: false },
    state: "queued",
    startedAt: null,
    finishedAt: null,
    commands: [],
    networkUsed: [],
    credits: { estimated: estimatedCredits, consumed: 0 },
    artifacts: [],
    redactionApplied: false,
  };
}

const ADAPTERS = loadAdapters();

describe("adapter descriptors", () => {
  it("24 adapters present, every one schema-valid with valid fixture refs", () => {
    expect(ADAPTERS).toHaveLength(24);
    for (const { id, descriptor } of ADAPTERS) {
      expect(descriptor.id).toBe(id);
      const result = validateAgainstSchema(ADAPTER_SCHEMA_ID, descriptor);
      expect(result.ok, `${id}: ${result.errors.join("; ")}`).toBe(true);
      for (const ref of Object.values(descriptor.fixtures)) {
        expect(() =>
          readFileSync(join(ROOT, "adapters", id, ref), "utf8"),
        ).not.toThrow();
      }
    }
  });

  it("every sourceEntryId resolves in the lock or the frozen mission-core set", () => {
    for (const { id, descriptor } of ADAPTERS) {
      const resolved = LOCK_IDS.has(descriptor.sourceEntryId) || MISSION_CORE_SOURCES[descriptor.sourceEntryId] === true;
      expect(resolved, `${id} -> ${descriptor.sourceEntryId}`).toBe(true);
    }
  });

  it("allowlist hygiene: no absolute paths; non-first-party adapters have a real tool lane", () => {
    for (const { id, descriptor } of ADAPTERS) {
      expect(descriptor.commandAllowlist.length).toBeGreaterThanOrEqual(1);
      for (const row of descriptor.commandAllowlist) {
        for (const token of row) expect(token.startsWith("/"), `${id}: ${row}`).toBe(false);
      }
      if (id !== "malformed-fixtures") {
        expect(
          descriptor.commandAllowlist.some((row) => row.length >= 2),
          `${id} lacks a multi-token tool lane`,
        ).toBe(true);
      }
    }
  });

  it("unavailable fixtures exit 127 deterministically", () => {
    for (const id of ["cypress", "testsprite", "owasp-zap"]) {
      const { descriptor } = ADAPTERS.find((a) => a.id === id)!;
      let code = 0;
      try {
        execFileSync("node", [join(ROOT, "adapters", id, descriptor.fixtures.unavailableDependency)], { stdio: "pipe" });
      } catch (e) {
        code = (e as { status?: number }).status ?? -1;
      }
      expect(code).toBe(127);
    }
  });
});

describe("sandboxed execution through the real runner", () => {
  it("cypress passing fixture → passed, every receipt verifies", async () => {
    const { descriptor } = ADAPTERS.find((a) => a.id === "cypress")!;
    const baseDir = mkdtempSync(join(tmpdir(), "rt-adapter-pass-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "rt-adapter-store-"));
    const run = await executeRun(queuedManifest("cypress-pass", "cypress"), descriptor, {
      argv: ["node", stageFixture(baseDir, "cypress", descriptor.fixtures.passing)],
      baseDir,
      storeRoot,
      requiredEvidence: descriptor.evidenceKinds,
      spawner: childProcessSpawner(),
    });
    expect(run.state).toBe("passed");
    expect(run.finishedAt).not.toBeNull();
    expect(run.redactionApplied).toBe(true);
    expect(run.artifacts.length).toBeGreaterThanOrEqual(descriptor.evidenceKinds.length);
    for (const receipt of run.artifacts) {
      expect(verifyReceipt(receipt, storeRoot), receipt.path).toBe(true);
    }
  });

  it("cypress planted-failing fixture → failed with detail, receipts still sealed", async () => {
    const { descriptor } = ADAPTERS.find((a) => a.id === "cypress")!;
    const baseDir = mkdtempSync(join(tmpdir(), "rt-adapter-fail-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "rt-adapter-store-"));
    const run = await executeRun(queuedManifest("cypress-fail", "cypress"), descriptor, {
      argv: ["node", stageFixture(baseDir, "cypress", descriptor.fixtures.plantedFailing)],
      baseDir,
      storeRoot,
      requiredEvidence: descriptor.evidenceKinds,
      spawner: childProcessSpawner(),
    });
    expect(run.state).toBe("failed");
    expect(run.failureDetail).toBeTruthy();
    expect(run.artifacts.length).toBeGreaterThan(0);
    for (const receipt of run.artifacts) {
      expect(verifyReceipt(receipt, storeRoot), receipt.path).toBe(true);
    }
  });

  it("testsprite over-budget → blocked credit_budget_exceeded with ZERO spawns", async () => {
    const { descriptor } = ADAPTERS.find((a) => a.id === "testsprite")!;
    let spawns = 0;
    const countingSpawner = (() => {
      spawns++;
      throw new Error("spawner must never be reached");
    }) as unknown as typeof childProcessSpawner;
    const run = await executeRun(
      queuedManifest("ts-overbudget", "testsprite", 11),
      descriptor,
      (() => { const baseDir = mkdtempSync(join(tmpdir(), "rt-adapter-budget-")); return {
        argv: ["node", stageFixture(baseDir, "testsprite", descriptor.fixtures.passing)],
        baseDir,
        storeRoot: mkdtempSync(join(tmpdir(), "rt-adapter-store-")),
        requiredEvidence: descriptor.evidenceKinds as readonly ArtifactKind[],
        spawner: countingSpawner,
        credentialResolver: () => "fixture-credential-never-used",
      }; })(),
    );
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toContain("credit_budget_exceeded");
    expect(spawns).toBe(0);
  });

  it("testsprite without credentials → blocked credential_missing with ZERO spawns", async () => {
    const { descriptor } = ADAPTERS.find((a) => a.id === "testsprite")!;
    let spawns = 0;
    const countingSpawner = (() => {
      spawns++;
      throw new Error("spawner must never be reached");
    }) as unknown as typeof childProcessSpawner;
    const credBase = mkdtempSync(join(tmpdir(), "rt-adapter-cred-"));
    const run = await executeRun(queuedManifest("ts-nocred", "testsprite", 1), descriptor, {
      argv: ["node", stageFixture(credBase, "testsprite", descriptor.fixtures.passing)],
      baseDir: credBase,
      storeRoot: mkdtempSync(join(tmpdir(), "rt-adapter-store-")),
      requiredEvidence: descriptor.evidenceKinds as readonly ArtifactKind[],
      spawner: countingSpawner,
      credentialResolver: () => undefined,
    });
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toContain("credential_missing");
    expect(spawns).toBe(0);
  });
});
