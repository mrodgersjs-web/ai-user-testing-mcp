import { afterAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactReceipt } from "@rig-testlab/catalog";
import { credentialEnvVarName, executeRun, type ReceiptSealer } from "./index.js";
import { childProcessSpawner, type SpawnSpec } from "./spawner.js";
import { fakeSpawner, makeAdapter, queuedManifest } from "./test-harness.js";

const tmpDirs: string[] = [];
const freshDir = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `rl-run-${label}-`));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Hermetic sealer for tests that are not about evidence itself. */
function fakeReceiptSealer(): ReceiptSealer & { sealed: ArtifactReceipt[] } {
  const sealed: ArtifactReceipt[] = [];
  const sealer = async (p: Parameters<ReceiptSealer>[0]): Promise<ArtifactReceipt> => {
    const receipt: ArtifactReceipt = {
      id: p.id,
      runId: p.runId,
      kind: p.kind,
      path: `runs/${p.runId}/artifacts/${p.id}`,
      sha256: "f".repeat(64),
      sizeBytes: 1,
      capturedAt: p.capturedAt,
      redacted: true,
    };
    sealed.push(receipt);
    return receipt;
  };
  return Object.assign(sealer, { sealed });
}

const noRedact = (s: string) => ({ text: s, hitCount: 0, kinds: [] as string[] });

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

describe("executeRun fail-closed refusals (no spawn, no side effects)", () => {
  it("argv off the allowlist: blocked, zero spawns, clean base+store", async () => {
    const base = freshDir("base");
    const store = freshDir("store");
    const spawner = fakeSpawner();
    const run = await executeRun(queuedManifest(), makeAdapter(), {
      argv: ["/bin/rm", "-rf", "/"],
      baseDir: base,
      storeRoot: store,
      spawner,
      sealer: fakeReceiptSealer(),
    });
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toBe("command_not_allowlisted");
    expect(spawner.calls).toHaveLength(0);
    expect(run.commands).toHaveLength(0);
    expect(run.redactionApplied).toBe(false);
    expect(readdirSync(base)).toHaveLength(0);
    expect(readdirSync(store)).toHaveLength(0);
  });

  it("absolute path outside baseDir: path_escape_denied without spawning", async () => {
    const base = freshDir("base");
    const store = freshDir("store");
    const spawner = fakeSpawner();
    const run = await executeRun(queuedManifest(), makeAdapter({ commandAllowlist: [["/bin/cat"]] }), {
      argv: ["/bin/cat", "/etc/passwd"],
      baseDir: base,
      storeRoot: store,
      spawner,
      sealer: fakeReceiptSealer(),
    });
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toBe("path_escape_denied");
    expect(spawner.calls).toHaveLength(0);
    expect(readdirSync(base)).toHaveLength(0);
  });

  it("paths inside the sandbox base are allowed through (non-vacuity)", async () => {
    const base = freshDir("base");
    const spawner = fakeSpawner();
    const run = await executeRun(queuedManifest(), makeAdapter(), {
      argv: ["/bin/echo", join(base, "inputs", "seed.txt")],
      baseDir: base,
      storeRoot: freshDir("store"),
      spawner,
      sealer: fakeReceiptSealer(),
      redactor: noRedact,
    });
    expect(run.state).toBe("passed");
    expect(spawner.calls).toHaveLength(1);
  });

  it("empty networkAllowlist + egress intent: refused", async () => {
    const base = freshDir("base");
    const spawner = fakeSpawner();
    const run = await executeRun(
      queuedManifest(),
      makeAdapter({ commandAllowlist: [["node"]] }),
      {
        argv: ["node", "fetch", "https://api.example.com/collect"],
        baseDir: base,
        storeRoot: freshDir("store"),
        spawner,
        sealer: fakeReceiptSealer(),
      },
    );
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toBe("network_not_declared");
    expect(spawner.calls).toHaveLength(0);
  });

  it("credential_missing: env_store adapter, no resolvable credential", async () => {
    const spawner = fakeSpawner();
    const run = await executeRun(
      queuedManifest(),
      makeAdapter({ credentialMode: "env_store" }),
      {
        argv: ["/bin/echo", "hi"],
        baseDir: freshDir("base"),
        storeRoot: freshDir("store"),
        spawner,
        sealer: fakeReceiptSealer(),
        env: {},
      },
    );
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toBe("credential_missing");
    expect(spawner.calls).toHaveLength(0);
  });

  it("dependency_unavailable when the executable cannot be found", async () => {
    const run = await executeRun(
      queuedManifest(),
      makeAdapter({ commandAllowlist: [["ghost-bin-zz9"]] }),
      {
        argv: ["ghost-bin-zz9"],
        baseDir: freshDir("base"),
        storeRoot: freshDir("store"),
        spawner: fakeSpawner(),
        sealer: fakeReceiptSealer(),
      },
    );
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toBe("dependency_unavailable");
  });

  it("credit_budget_exceeded: manifest estimate over paidGuards ceiling", async () => {
    const manifest = queuedManifest();
    manifest.credits.estimated = 50;
    const run = await executeRun(
      manifest,
      makeAdapter({ paidProvider: true, paidGuards: { maxScenarios: 5, maxEstimatedCredits: 10 } }),
      {
        argv: ["/bin/echo"],
        baseDir: freshDir("base"),
        storeRoot: freshDir("store"),
        spawner: fakeSpawner(),
        sealer: fakeReceiptSealer(),
      },
    );
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toBe("credit_budget_exceeded");
  });

  it("target_missing via the injected existence hook", async () => {
    const run = await executeRun(queuedManifest(), makeAdapter(), {
      argv: ["/bin/echo"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner: fakeSpawner(),
      sealer: fakeReceiptSealer(),
      targetExists: () => false,
    });
    expect(run.state).toBe("blocked");
    expect(run.failureDetail).toBe("target_missing");
  });
});

describe("executeRun resource caps", () => {
  it("wall-clock breach kills the whole process group (real spawner, sleep child)", async () => {
    // Deliberate real-clock integration test: fake timers cannot kill a real
    // OS process group. The poll below awaits the real death condition (ESRCH),
    // the setTimeout is retry backoff only, and the 1s cap keeps CI cost <2s.
    const base = freshDir("base");
    const real = childProcessSpawner();
    let childPid = -1;
    const spawner = {
      spawn(spec: SpawnSpec) {
        const h = real.spawn(spec);
        childPid = h.pid;
        return h;
      },
    };
    const adapter = makeAdapter({
      commandAllowlist: [["/bin/sleep"]],
      limits: { maxCpuMs: 5000, maxMemoryMb: 256, maxWallClockS: 1, maxOutputBytes: 65536 },
    });
    const t0 = Date.now();
    const run = await executeRun(queuedManifest("run.wall"), adapter, {
      argv: ["/bin/sleep", "30"],
      baseDir: base,
      storeRoot: freshDir("store"),
      spawner,
      sealer: fakeReceiptSealer(),
      redactor: noRedact,
    });
    expect(Date.now() - t0).toBeLessThan(9000);
    expect(run.state).toBe("failed");
    expect(run.failureDetail).toContain("wall_clock_exceeded");
    // The detached child must be gone: signal 0 raises ESRCH once dead.
    let dead = false;
    for (let i = 0; i < 60 && !dead; i++) {
      try {
        process.kill(childPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        dead = true;
      }
    }
    expect(dead).toBe(true);
    expect(readdirSync(base)).toHaveLength(0);
  });

  it("output cap breach kills the child and fails the run", async () => {
    const spawner = fakeSpawner({ stdout: Array.from({ length: 100 }, () => "x".repeat(1024)) });
    const run = await executeRun(
      queuedManifest("run.output"),
      makeAdapter({
        limits: { maxCpuMs: 5000, maxMemoryMb: 256, maxWallClockS: 30, maxOutputBytes: 4096 },
      }),
      {
        argv: ["/bin/echo", "spam"],
        baseDir: freshDir("base"),
        storeRoot: freshDir("store"),
        spawner,
        sealer: fakeReceiptSealer(),
        redactor: noRedact,
      },
    );
    expect(run.state).toBe("failed");
    expect(run.failureDetail).toContain("output_limit_exceeded");
    expect(spawner.kills).toContain("SIGTERM");
  });
});

describe("executeRun evidence integrity", () => {
  it("secret in stdout is redacted in the persisted log receipt (real evidence)", async () => {
    const secret = "ghp_Ab1cDe2fGh3iJk4lMn5oPq6rSt7uVw8xYz90";
    const store = freshDir("store");
    const spawner = fakeSpawner({
      stdout: [`Authorization: Bearer abcdef.abcdefghijklmnopqrstuvw\nreport done ${secret}\n`],
      stderr: ["all good\n"],
    });
    const run = await executeRun(queuedManifest("run.secret"), makeAdapter(), {
      argv: ["/bin/echo", "go"],
      baseDir: freshDir("base"),
      storeRoot: store,
      spawner,
      requiredEvidence: ["log"],
    });
    expect(run.state).toBe("passed");
    expect(run.redactionApplied).toBe(true);
    const logReceipts = run.artifacts.filter((r) => r.kind === "log");
    expect(logReceipts.length).toBeGreaterThan(0);
    expect(logReceipts.some((r) => r.redacted)).toBe(true);
    // Nothing raw survives anywhere under the store root.
    for (const f of listFilesRecursive(store)) {
      const body = readFileSync(f, "utf8");
      expect(body).not.toContain(secret);
      expect(body).not.toContain("abcdefghijklmnopqrstuvw");
    }
    expect(JSON.stringify(run)).not.toContain(secret);
  });

  it("exit 0 with missing required evidence is failed, never passed", async () => {
    const run = await executeRun(queuedManifest("run.missing"), makeAdapter(), {
      argv: ["/bin/echo", "done"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner: fakeSpawner({ stdout: ["done\n"] }),
      sealer: fakeReceiptSealer(),
      redactor: noRedact,
      requiredEvidence: ["screenshot"],
    });
    expect(run.state).toBe("failed");
    expect(run.failureDetail).toBe("missing_required_evidence:screenshot");
  });

  it("kind-directory convention seals screenshot + json_report evidence", async () => {
    const run = await executeRun(queuedManifest("run.kinds"), makeAdapter(), {
      argv: ["/bin/echo", "ok"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner: fakeSpawner({
        onSpawn: (spec) => {
          mkdirSync(join(spec.cwd, "artifacts", "screenshot"), { recursive: true });
          mkdirSync(join(spec.cwd, "artifacts", "json_report"), { recursive: true });
          writeFileSync(join(spec.cwd, "artifacts", "screenshot", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          writeFileSync(join(spec.cwd, "artifacts", "json_report", "r.json"), "{\"ok\":true}");
        },
      }),
      sealer: fakeReceiptSealer(),
      redactor: noRedact,
      requiredEvidence: ["log", "screenshot", "json_report"],
    });
    expect(run.state).toBe("passed");
    const kinds = run.artifacts.map((r) => r.kind).sort();
    expect(kinds).toEqual(["json_report", "log", "log", "screenshot"]);
    for (const r of run.artifacts) {
      expect(r.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(r.id).toMatch(/^ev-\d+-/);
    }
  });

  it("nonzero exit fails with exit_code detail", async () => {
    // /bin/kill -0 <my pid>: pure exit-1 probe (macOS has no /bin/false).
    const run = await executeRun(
      queuedManifest("run.exit1"),
      makeAdapter({ commandAllowlist: [["/bin/kill"]] }),
      {
        argv: ["/bin/kill", "-0", String(process.pid)],
        baseDir: freshDir("base"),
        storeRoot: freshDir("store"),
        spawner: fakeSpawner({ exitCode: 1 }),
        sealer: fakeReceiptSealer(),
        redactor: noRedact,
      },
    );
    expect(run.state).toBe("failed");
    expect(run.failureDetail).toBe("exit_code_1");
    expect(run.commands[0]?.exitCode).toBe(1);
  });
});

describe("executeRun sandbox hygiene", () => {
  it("child env is minimal: PATH + HOME(sandbox) + declared passthrough + credential only", async () => {
    const base = freshDir("base");
    const spawner = fakeSpawner();
    const credName = credentialEnvVarName("adapter.test");
    const run = await executeRun(
      queuedManifest("run.env"),
      makeAdapter({ credentialMode: "keychain" }),
      {
        argv: ["/bin/echo", "hi"],
        baseDir: base,
        storeRoot: freshDir("store"),
        spawner,
        sealer: fakeReceiptSealer(),
        redactor: noRedact,
        credentialResolver: () => "sekrit-credential-value",
        envPassthrough: { NODE_ENV: "production" },
        keepSandbox: true,
        env: { PATH: "/usr/bin:/bin", SECRET_HOME_DIR: "/should-not-leak" },
      },
    );
    const childEnv = spawner.calls[0]?.env as NodeJS.ProcessEnv;
    expect(Object.keys(childEnv).sort()).toEqual(
      ["HOME", "NODE_ENV", "PATH", credName].sort(),
    );
    expect(childEnv.HOME).toBe(run.sandbox.homeDir);
    expect(childEnv[credName]).toBe("sekrit-credential-value");
    // The credential value never appears in the manifest (the report).
    expect(JSON.stringify(run)).not.toContain("sekrit-credential-value");
    // keepSandbox preserves the sandbox dirs, with 0700 containment.
    expect(readdirSync(base)).toHaveLength(1);
    const root = join(base, readdirSync(base)[0]!);
    expect(statSync(join(root, "home")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "worktree")).mode & 0o777).toBe(0o700);
  });

  it("sandbox removed by default; evidence store preserved", async () => {
    const base = freshDir("base");
    const store = freshDir("store");
    const run = await executeRun(queuedManifest("run.cleanup"), makeAdapter(), {
      argv: ["/bin/echo", "hi"],
      baseDir: base,
      storeRoot: store,
      spawner: fakeSpawner({ stdout: ["hi\n"] }),
      requiredEvidence: ["log"],
    });
    expect(run.state).toBe("passed");
    expect(readdirSync(base)).toHaveLength(0);
    expect(listFilesRecursive(store).length).toBeGreaterThan(0);
  });

  it("aborted before spawn: cancelled, nothing ran", async () => {
    const spawner = fakeSpawner();
    const controller = new AbortController();
    controller.abort();
    const run = await executeRun(queuedManifest("run.preabort"), makeAdapter(), {
      argv: ["/bin/echo"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner,
      sealer: fakeReceiptSealer(),
      signal: controller.signal,
    });
    expect(run.state).toBe("cancelled");
    expect(spawner.calls).toHaveLength(0);
  });

  it("aborted during run: wedged child killed, state cancelled", async () => {
    const controller = new AbortController();
    // Deterministic "during run" abort: the fake wedges and aborts from
    // inside spawn — exercises the abort-vs-spawn race, no guessed delays.
    const spawner = fakeSpawner({ holdOpen: true, onSpawn: () => controller.abort() });
    const run = await executeRun(queuedManifest("run.midabort"), makeAdapter(), {
      argv: ["/bin/echo"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner,
      sealer: fakeReceiptSealer(),
      signal: controller.signal,
    });
    expect(run.state).toBe("cancelled");
    expect(run.failureDetail).toBe("cancelled_during_run");
    expect(spawner.kills).toContain("SIGTERM");
  });

  it("happy path fills the manifest honestly", async () => {
    const run = await executeRun(queuedManifest("run.happy"), makeAdapter(), {
      argv: ["/bin/echo", "ok"],
      baseDir: freshDir("base"),
      storeRoot: freshDir("store"),
      spawner: fakeSpawner({ stdout: ["ok\n"] }),
      sealer: fakeReceiptSealer(),
      redactor: noRedact,
      requiredEvidence: ["log"],
    });
    expect(run.state).toBe("passed");
    expect(run.failureDetail).toBeNull();
    expect(typeof run.startedAt).toBe("string");
    expect(typeof run.finishedAt).toBe("string");
    expect(run.sandbox.readOnlySource).toBe(true);
    expect(run.sandbox.limitsApplied).toBe(true);
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]?.argv).toEqual(["/bin/echo", "ok"]);
    expect(run.commands[0]?.exitCode).toBe(0);
    expect(run.credits).toEqual({ estimated: 0, consumed: 0 });
  });
});
