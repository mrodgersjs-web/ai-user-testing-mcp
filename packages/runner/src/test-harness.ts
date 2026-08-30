/**
 * Shared test scaffolding (not exported from the package barrel).
 * Provides the fake ProcessSpawner used to keep executeRun tests hermetic and
 * to prove "no spawn happened" on fail-closed refusals, plus deterministic
 * fixture builders for AdapterDescriptor / queued RunManifest.
 */
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterDescriptor, RunManifest } from "@rig-testlab/catalog";
import type { ProcessSpawner, SpawnHandle, SpawnSpec } from "./spawner.js";

export interface FakeChild {
  stdout?: readonly string[];
  stderr?: readonly string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** Never self-exits; only killTree resolves it (models a wedged child). */
  holdOpen?: boolean;
  /** Called synchronously inside spawn, before any exit — write fixtures into spec.cwd here. */
  onSpawn?: (spec: SpawnSpec) => void;
}

export interface FakeSpawner extends ProcessSpawner {
  calls: SpawnSpec[];
  kills: NodeJS.Signals[];
  lastPid: number;
}

/** Records every spawn request; emits scripted output; honors killTree. */
export function fakeSpawner(child: FakeChild = {}): FakeSpawner {
  const calls: SpawnSpec[] = [];
  const kills: NodeJS.Signals[] = [];
  let lastPid = 424200;
  return {
    calls,
    kills,
    get lastPid() {
      return lastPid;
    },
    spawn(spec: SpawnSpec): SpawnHandle {
      calls.push(spec);
      lastPid += 1;
      const pid = lastPid;
      const out = new Readable({ read() {} });
      const err = new Readable({ read() {} });
      let done = false;
      let resolveExited!: (r: { code: number | null; signal: NodeJS.Signals | null }) => void;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
        resolveExited = res;
      });
      child.onSpawn?.(spec);
      setImmediate(() => {
        for (const c of child.stdout ?? []) out.push(c);
        out.push(null);
        for (const c of child.stderr ?? []) err.push(c);
        err.push(null);
      });
      if (!child.holdOpen) {
        setImmediate(() => {
          if (done) return;
          done = true;
          resolveExited({ code: child.exitCode ?? 0, signal: child.signal ?? null });
        });
      }
      return {
        pid,
        stdout: out,
        stderr: err,
        exited,
        killTree(signal: NodeJS.Signals): void {
          kills.push(signal);
          if (done) return;
          done = true;
          resolveExited({ code: null, signal });
        },
      };
    },
  };
}

/** A conforming reviewed adapter; override any field per test. */
export function makeAdapter(overrides: Partial<AdapterDescriptor> = {}): AdapterDescriptor {
  return {
    id: "adapter.test",
    name: "Test Adapter",
    adapterVersion: "1.0.0",
    sourceEntryId: "entry.test",
    status: "reviewed",
    commandAllowlist: [["/bin/echo"]],
    networkAllowlist: [],
    limits: { maxCpuMs: 5000, maxMemoryMb: 256, maxWallClockS: 30, maxOutputBytes: 65536 },
    credentialMode: "none",
    paidProvider: false,
    fixtures: {
      passing: "fixtures/pass.sh",
      plantedFailing: "fixtures/fail.sh",
      unavailableDependency: "fixtures/missing-dep.sh",
    },
    evidenceKinds: ["log"],
    ...overrides,
  };
}

/** A compiled, queued RunManifest skeleton (executeRun fills the rest). */
export function queuedManifest(runId = "run.test-1"): RunManifest {
  return {
    runId,
    scenarioId: "scn.test",
    adapterId: "adapter.test",
    sandbox: {
      homeDir: "/pending",
      worktree: "/pending",
      readOnlySource: true,
      limitsApplied: true,
    },
    state: "queued",
    startedAt: null,
    finishedAt: null,
    commands: [],
    networkUsed: [],
    credits: { estimated: 0, consumed: 0 },
    failureDetail: null,
    artifacts: [],
    redactionApplied: false,
  };
}

/** Repo root resolved by walking up to pnpm-workspace.yaml (no hardcoded paths). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("pnpm-workspace.yaml not found above module");
      dir = parent;
    }
  }
}
