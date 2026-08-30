/**
 * State-machine invariants: the terminal-state lattice executeRun writes,
 * parity with the frozen RunManifest/ArtifactReceipt JSON Schemas, and the
 * non-negotiable rule that blocked/not_evaluated/cancelled/failed never
 * render as passed. Manifests are validated against the on-disk schema
 * (required keys, enums, id patterns) without pulling a validator dep.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NON_PASSING_STATES } from "@rig-testlab/catalog";
import type { RunManifest } from "@rig-testlab/catalog";
import { executeRun, TERMINAL_STATES, type ReceiptSealer } from "./index.js";
import { fakeSpawner, makeAdapter, queuedManifest, repoRoot } from "./test-harness.js";

const schema = (name: string): {
  properties: Record<string, { enum?: unknown[]; pattern?: string; type?: unknown }>;
  required: string[];
} => JSON.parse(readFileSync(join(repoRoot(), "schemas", name), "utf8"));

const runSchema = schema("RunManifest.v1.schema.json");
const receiptSchema = schema("ArtifactReceipt.v1.schema.json");

const tmpDirs: string[] = [];
const freshDir = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `rl-sm-${label}-`));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const RECEIPT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function validateManifest(run: RunManifest): string[] {
  const errors: string[] = [];
  for (const key of runSchema.required) {
    if (!(key in run)) errors.push(`missing required key ${key}`);
  }
  const stateEnum = runSchema.properties.state?.enum as unknown[] | undefined;
  if (!stateEnum?.includes(run.state)) errors.push(`state ${run.state} not in schema enum`);
  if (run.commands.some((c) => c.argv.length < 1)) errors.push("command argv must be non-empty");
  if (run.commands.some((c) => c.exitCode !== null && !Number.isInteger(c.exitCode))) {
    errors.push("exitCode must be integer or null");
  }
  const kindEnum = receiptSchema.properties.kind?.enum as unknown[] | undefined;
  for (const a of run.artifacts) {
    if (!RECEIPT_ID_RE.test(a.id)) errors.push(`receipt id ${a.id} violates pattern`);
    if (!kindEnum?.includes(a.kind)) errors.push(`receipt kind ${a.kind} not in enum`);
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) errors.push("sha256 must be 64 hex");
    if (a.path.startsWith("/") || a.path.includes("..")) {
      errors.push(`receipt path ${a.path} must be relative and traversal-free`);
    }
    if (!Number.isInteger(a.sizeBytes) || a.sizeBytes < 0) errors.push("sizeBytes invalid");
    if (typeof a.redacted !== "boolean") errors.push("redacted must be boolean");
    if (Number.isNaN(Date.parse(a.capturedAt))) errors.push("capturedAt must be date-time");
  }
  if (run.state === "passed") {
    if (typeof run.finishedAt !== "string") errors.push("passed requires finishedAt string");
    if (run.redactionApplied !== true) errors.push("passed requires redactionApplied true");
    if (!("failureDetail" in run)) errors.push("passed requires failureDetail key present");
  }
  return errors;
}

describe("terminal-state lattice", () => {
  it("TERMINAL_STATES ∪ {queued, running} equals the schema state enum", () => {
    const enumStates = runSchema.properties.state?.enum as string[];
    expect([...enumStates].sort()).toEqual(
      [...TERMINAL_STATES, "queued", "running"].sort(),
    );
  });

  it("nothing executeRun terminates in can be aggregated as passed", async () => {
    const cases: Array<() => Promise<RunManifest>> = [
      // blocked (allowlist)
      () =>
        executeRun(queuedManifest("sm.blocked"), makeAdapter(), {
          argv: ["/bin/false"],
          baseDir: freshDir("base"),
          storeRoot: freshDir("store"),
          spawner: fakeSpawner(),
          sealer: async () => {
            throw new Error("must not seal");
          },
        }),
      // cancelled (pre-abort)
      async () => {
        const c = new AbortController();
        c.abort();
        return executeRun(queuedManifest("sm.cancelled"), makeAdapter(), {
          argv: ["/bin/echo"],
          baseDir: freshDir("base"),
          storeRoot: freshDir("store"),
          spawner: fakeSpawner(),
          sealer: fakeSpawnerSealer(),
          signal: c.signal,
        });
      },
      // failed (missing evidence)
      () =>
        executeRun(queuedManifest("sm.failed"), makeAdapter(), {
          argv: ["/bin/echo"],
          baseDir: freshDir("base"),
          storeRoot: freshDir("store"),
          spawner: fakeSpawner({ stdout: ["x\n"] }),
          sealer: fakeSpawnerSealer(),
          redactor: (s) => ({ text: s, hitCount: 0, kinds: [] }),
          requiredEvidence: ["video"],
        }),
    ];
    for (const produce of cases) {
      const run = await produce();
      expect(TERMINAL_STATES).toContain(run.state);
      expect(run.state).not.toBe("passed");
      expect(NON_PASSING_STATES).toContain(run.state);
      expect(validateManifest(run)).toEqual([]);
    }
  });

  it("passed manifests satisfy the RunManifest schema contract", async () => {
    const run = await executeRun(queuedManifest("sm.passed"), makeAdapter(), {
      argv: ["/bin/echo", "ok"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner: fakeSpawner({ stdout: ["ok\n"] }),
      sealer: fakeSpawnerSealer(),
      redactor: (s) => ({ text: s, hitCount: 0, kinds: [] }),
      requiredEvidence: ["log"],
    });
    expect(run.state).toBe("passed");
    expect(NON_PASSING_STATES).not.toContain(run.state);
    expect(validateManifest(run)).toEqual([]);
  });

  it("not_evaluated remains reserved: executeRun never emits it, schema knows it", async () => {
    const stateEnum = runSchema.properties.state?.enum as string[];
    expect(stateEnum).toContain("not_evaluated");
    expect(TERMINAL_STATES).toContain("not_evaluated");
    // A whole battery of outcomes must not spontaneously produce not_evaluated.
    const run = await executeRun(queuedManifest("sm.noteval"), makeAdapter(), {
      argv: ["/bin/echo"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner: fakeSpawner(),
      sealer: fakeSpawnerSealer(),
      redactor: (s) => ({ text: s, hitCount: 0, kinds: [] }),
    });
    expect(run.state).not.toBe("not_evaluated");
  });
});

function fakeSpawnerSealer(): ReceiptSealer {
  return async (p) => ({
    id: p.id,
    runId: p.runId,
    kind: p.kind,
    path: `runs/${p.runId}/artifacts/${p.id}`,
    sha256: "a".repeat(64),
    sizeBytes: 2,
    capturedAt: p.capturedAt,
    redacted: true,
  });
}
