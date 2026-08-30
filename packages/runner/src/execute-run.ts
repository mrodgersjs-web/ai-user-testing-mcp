/**
 * executeRun — the sandboxed execution of one compiled RunManifest through one
 * reviewed adapter.
 *
 * Isolation model (no shell, no OS sandbox dependency):
 * - ephemeral HOME + WORKTREE (0700) under mkdtemp(baseDir); removed in
 *   `finally` unless opts.keepSandbox; the evidence storeRoot is NEVER touched
 *   by cleanup;
 * - spawn via the injected ProcessSpawner: argv array, no shell, cwd=worktree,
 *   env = {PATH, HOME=home} + adapter-declared passthrough + resolved
 *   credential ONLY;
 * - preflight re-runs fail-closed before the spawn (allowlist, path-escape,
 *   network, credentials, credits, deps);
 * - wall-clock cap: SIGTERM the process group, SIGKILL after a grace period;
 * - output cap: accumulated bytes over adapter.limits.maxOutputBytes kill the
 *   group and fail the run;
 * - forbidden-write contract: the sandbox cwd is the worktree and the source
 *   tree stays read-only OUTSIDE baseDir — enforced as a preflight refusal of
 *   any argv argument naming an absolute path outside baseDir
 *   (`path_escape_denied`). Deeper OS enforcement (macOS sandbox-exec profiles,
 *   Linux namespaces) is optional wave-2 hardening layered on top; this layer
 *   never *relies* on it.
 *
 * Terminal state rule: `passed` requires exitCode 0 AND every requiredEvidence
 * kind present among sealed receipts AND zero recorded violations. blocked /
 * not_evaluated / cancelled are distinct terminal states and never collapse
 * into passed. Secrets never persist: captured stdout/stderr and manifest argv
 * run through evidence `redactText` before writing, and every artifact is
 * persisted only via evidence `sealReceipt` (redacts text kinds pre-persist).
 */
import {
  chmodSync,
  statSync,
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { redactText, sealReceipt } from "@rig-testlab/evidence";
import type {
  AdapterDescriptor,
  ArtifactKind,
  ArtifactReceipt,
  RunManifest,
  RunState,
} from "@rig-testlab/catalog";
import {
  credentialEnvVarName,
  envCredentialResolver,
  extractEgressHosts,
  preflight,
  type CredentialResolver,
  type PreflightContext,
  type TargetProbe,
  type ToolChecker,
} from "./preflight.js";
import { childProcessSpawner, type ProcessSpawner, type SpawnHandle } from "./spawner.js";

/** States executeRun may terminate in (schema enum; not_evaluated is the evaluator's). */
export const TERMINAL_STATES: readonly RunState[] = [
  "passed",
  "failed",
  "blocked",
  "not_evaluated",
  "cancelled",
];

/** Artifact-kind directory convention under <worktree>/artifacts/<kind>/. */
const KNOWN_ARTIFACT_KINDS: Readonly<Record<ArtifactKind, true>> = {
  screenshot: true,
  video: true,
  rrweb: true,
  console_network_trace: true,
  accessibility_tree: true,
  model_transcript: true,
  log: true,
  json_report: true,
};

/** Folder-name aliases (plural + tool-conventional forms) → artifact kind. */
const ARTIFACT_FOLDER_ALIASES: Readonly<Record<string, ArtifactKind>> = {
  screenshot: "screenshot",
  screenshots: "screenshot",
  video: "video",
  videos: "video",
  rrweb: "rrweb",
  console_network_trace: "console_network_trace",
  trace: "console_network_trace",
  traces: "console_network_trace",
  accessibility_tree: "accessibility_tree",
  accessibility: "accessibility_tree",
  a11y: "accessibility_tree",
  model_transcript: "model_transcript",
  transcript: "model_transcript",
  transcripts: "model_transcript",
  log: "log",
  logs: "log",
  json_report: "json_report",
  json: "json_report",
  report: "json_report",
  reports: "json_report",
};

const MAX_ARTIFACT_FILES = 200;
const DEFAULT_KILL_GRACE_MS = 2000;

export type ReceiptSealer = (params: {
  runId: string;
  kind: ArtifactKind;
  storeRoot: string;
  srcPath: string;
  id: string;
  capturedAt: string;
}) => Promise<ArtifactReceipt>;

export type Redactor = (
  s: string,
) => { text: string; hitCount: number; kinds: string[] };

export interface ExecuteRunOptions {
  /** Full command line for this scenario run (already compiled). */
  argv: readonly string[];
  /** Parent dir for the ephemeral home+worktree; created if missing. */
  baseDir: string;
  /** Evidence store root; preserved across cleanup. */
  storeRoot: string;
  /** Evidence kinds the scenario demands for a `passed` verdict. */
  requiredEvidence?: readonly ArtifactKind[];
  /**
   * Optional CLI-trusted materializer called with the worktree path after
   * sandbox creation and BEFORE preflight (e.g. clone the pinned revision,
   * install dependencies). A throw blocks the run honestly with
   * source_provision_failed instead of spawning against an empty worktree.
   */
  provisionWorktree?: (worktree: string) => Promise<void> | void;
  /**
   * Optional app-under-test server: spawned in the worktree after provision,
   * awaited on readyUrl, killed (process group) in finally. Readiness failure
   * blocks the run as app_server_unavailable — never a fake pass, never a
   * misleading adapter exit.
   */
  startCommand?: { argv: readonly string[]; readyUrl: string; timeoutMs?: number };
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Adapter-declared env passthrough (names the review record allows). */
  envPassthrough?: Readonly<Record<string, string>>;
  /** Extra non-argv inputs scanned by preflight/egress recording. */
  inputs?: readonly string[];
  /** Scenario budget ceiling combined with adapter.paidGuards (min). */
  scenarioMaxCredits?: number;
  requireBinaries?: readonly string[];
  targetExists?: TargetProbe;
  /** External command seams; defaults: real spawner, evidence seal/redact. */
  spawner?: ProcessSpawner;
  sealer?: ReceiptSealer;
  redactor?: Redactor;
  credentialResolver?: CredentialResolver;
  toolChecker?: ToolChecker;
  /** Env for default resolver/toolchecker. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  keepSandbox?: boolean;
  signal?: AbortSignal;
  killGraceMs?: number;
}

export async function executeRun(
  manifest: RunManifest,
  adapter: AdapterDescriptor,
  opts: ExecuteRunOptions,
): Promise<RunManifest> {
  const run: RunManifest = structuredClone(manifest);
  const now = (): string => new Date().toISOString();
  const violations: string[] = [];
  const redact = opts.redactor ?? redactText;
  const redactedText = (text: string): string => redact(text).text;

  let sandboxRoot = "";
  let removeAbortListener: (() => void) | null = null;
  try {
    run.state = "running";
    run.startedAt = null;
    // Sandbox first so even a blocked manifest reports real, non-empty paths.
    mkdirSync(opts.baseDir, { recursive: true, mode: 0o700 });
    sandboxRoot = mkdtempSync(join(opts.baseDir, `${manifest.runId}-`));
    const home = join(sandboxRoot, "home");
    const worktree = join(sandboxRoot, "worktree");
    for (const dir of [home, worktree]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    run.sandbox = {
      homeDir: home,
      worktree,
      readOnlySource: true,
      limitsApplied: true,
    };
    if (opts.provisionWorktree !== undefined) {
      try {
        await opts.provisionWorktree(worktree);
      } catch (err) {
        run.state = "blocked";
        run.failureDetail = `source_provision_failed:${err instanceof Error ? err.message : String(err)}`;
        run.finishedAt = now();
        return run;
      }
    }

    let appServer: { stop: () => void } | null = null;
    if (opts.startCommand !== undefined) {
      try {
        appServer = await startAppServer(opts.startCommand, worktree, opts.fetchImpl ?? fetch);
      } catch (err) {
        run.state = "blocked";
        run.failureDetail = `app_server_unavailable:${err instanceof Error ? err.message : String(err)}`;
        run.finishedAt = now();
        return run;
      }
    }
    // Evidence baseline AFTER provision/server boot: only files the adapter
    // run itself creates or modifies are sealed. The project's committed
    // artifacts/ history (fresh mtimes from clone) is NOT run evidence.
    const artifactBaseline = snapshotArtifactFiles(worktree);

    // Fail-closed gates before any spawn.
    const envSource = opts.env ?? process.env;
    const pctx: PreflightContext = {
      baseDir: opts.baseDir,
      inputs: opts.inputs,
      estimatedCredits: manifest.credits.estimated,
      scenarioMaxCredits: opts.scenarioMaxCredits,
      requireBinaries: opts.requireBinaries,
      targetExists: opts.targetExists,
      credentialResolver: opts.credentialResolver,
      toolChecker: opts.toolChecker,
      env: envSource,
    };
    const gate = preflight(adapter, opts.argv, pctx);
    if (!gate.ok) {
      run.state = "blocked";
      run.failureDetail = gate.reason;
      run.finishedAt = now();
      return run;
    }

    // Minimal child env: PATH + sandbox HOME + adapter-declared passthrough +
    // resolved credential (under the convention name). Nothing else leaks in.
    const childEnv: NodeJS.ProcessEnv = {
      PATH: envSource.PATH ?? "/usr/bin:/bin",
      HOME: home,
    };
    for (const [name, value] of Object.entries(opts.envPassthrough ?? {})) {
      childEnv[name] = value;
    }
    if (adapter.credentialMode === "keychain" || adapter.credentialMode === "env_store") {
      const name = credentialEnvVarName(adapter.id);
      const value =
        opts.credentialResolver?.(name) ?? envCredentialResolver(name, envSource);
      // Preflight guaranteed presence; re-resolve for the child env only.
      if (value) childEnv[name] = value;
    }

    if (opts.signal?.aborted === true) {
      run.state = "cancelled";
      run.failureDetail = "cancelled_before_spawn";
      run.finishedAt = now();
      return run;
    }

    run.startedAt = now();
    run.networkUsed = extractEgressHosts(opts.argv, opts.inputs);

    const spawner = opts.spawner ?? childProcessSpawner();
    const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    let handle: SpawnHandle | null = null;
    let cancelRequested = false;
    let killTimerScheduled = false;
    const scheduleKill = (): void => {
      // Repeat-safe against the process group: an abort that fires while
      // spawn() is still in flight sees a null handle, so later calls must
      // still land the SIGTERM. The SIGKILL escalation is scheduled once.
      handle?.killTree("SIGTERM");
      if (!killTimerScheduled) {
        killTimerScheduled = true;
        setTimeout(() => handle?.killTree("SIGKILL"), graceMs).unref?.();
      }
    };
    const onAbort = (): void => {
      cancelRequested = true;
      scheduleKill();
    };
    if (opts.signal !== undefined) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      const signal = opts.signal;
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }

    try {
      handle = spawner.spawn({ argv: [...opts.argv], cwd: worktree, env: childEnv });
      // The listener stays for the WHOLE run: a live cancel must win over the
      // child's signal-death exit mapping. Removed in the outer finally.
      if (cancelRequested) scheduleKill(); // abort fired during spawn

      const limit = adapter.limits.maxOutputBytes;
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let seenBytes = 0;
      let outputLimitHit = false;
      const collect = (chunk: Buffer, store: Buffer[]): void => {
        seenBytes += chunk.length;
        if (outputLimitHit) return;
        if (seenBytes > limit) {
          outputLimitHit = true;
          violations.push("output_limit_exceeded");
          scheduleKill();
          return;
        }
        store.push(chunk);
      };
      handle.stdout?.on("data", (c: Buffer) => collect(c, outChunks));
      handle.stderr?.on("data", (c: Buffer) => collect(c, errChunks));

      const wallTimer = setTimeout(() => {
        violations.push("wall_clock_exceeded");
        scheduleKill();
      }, adapter.limits.maxWallClockS * 1000);
      wallTimer.unref?.();

      const result = await handle.exited;
      clearTimeout(wallTimer);

      const finished = now();
      run.commands.push({
        argv: opts.argv.map((tok) => redactedText(tok)),
        exitCode: result.code,
        startedAt: run.startedAt,
        finishedAt: finished,
      });
      if (result.error !== undefined) violations.push(`spawn_failed:${result.error}`);

      // Console evidence: redact BEFORE any write, then seal for persistence.
      const logDir = join(worktree, "artifacts", "log");
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(logDir, `${manifest.runId}-stdout.log`),
        redactedText(Buffer.concat(outChunks).toString("utf8")),
      );
      writeFileSync(
        join(logDir, `${manifest.runId}-stderr.log`),
        redactedText(Buffer.concat(errChunks).toString("utf8")),
      );

      run.artifacts.push(...(await sealArtifacts(run, worktree, opts, violations, artifactBaseline)));

      // Verdict: passed only with exit 0, all required evidence sealed, and
      // zero recorded violations. Anything else is an honest non-passing state.
      if (cancelRequested) {
        run.state = "cancelled";
        run.failureDetail = "cancelled_during_run";
      } else if (violations.length > 0) {
        run.state = "failed";
        run.failureDetail = violations.join(";");
      } else if (result.code !== 0) {
        run.state = "failed";
        run.failureDetail =
          result.code !== null
            ? `exit_code_${result.code}`
            : `terminated_signal_${result.signal ?? "unknown"}`;
      } else {
        const sealedKinds = new Set(run.artifacts.map((r) => r.kind));
        const missing = (opts.requiredEvidence ?? []).filter(
          (k) => !sealedKinds.has(k),
        );
        if (missing.length > 0) {
          run.state = "failed";
          run.failureDetail = `missing_required_evidence:${missing.join(",")}`;
        } else {
          run.state = "passed";
          run.failureDetail = null;
        }
      }
      // True iff sandboxed execution persisted its artifacts through the
      // redacting seal pipeline (per-file hit info lives on receipts.redacted).
      run.redactionApplied = true;
      run.finishedAt = finished;
      return run;
    } catch (err) {
      run.state = "failed";
      run.failureDetail = `spawn_failed:${err instanceof Error ? err.message : String(err)}`;
      run.finishedAt = now();
      return run;
    } finally {
      appServer?.stop();
    }
  } finally {
    removeAbortListener?.();
    if (!opts.keepSandbox && sandboxRoot.length > 0) {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
    // Evidence storeRoot is never part of cleanup.
  }
}

async function sealArtifacts(
  run: RunManifest,
  worktree: string,
  opts: ExecuteRunOptions,
  violations: string[],
  baseline: Map<string, { mtimeMs: number; size: number }>,
): Promise<ArtifactReceipt[]> {
  // Tools write under <root>/artifacts/** where <root> may be the worktree or
  // a nested project dir (e.g. cypress runs in worktree/e2e). Discover every
  // 'artifacts' directory up to depth 3; receipts' rel paths stay rooted at
  // the worktree so provenance is unambiguous.
  const artifactRoots = findArtifactDirs(worktree, 3);
  const receipts: ArtifactReceipt[] = [];
  let files: string[] = [];
  for (const rootDir of artifactRoots) {
    files.push(...walkFiles(rootDir));
  }
  files = files.filter((f) => {
    const before = baseline.get(f);
    if (before === undefined) return true; // created by the run
    try {
      const st = statSync(f);
      return st.mtimeMs !== before.mtimeMs || st.size !== before.size; // modified by the run
    } catch {
      return false;
    }
  });
  const artifactsRoot = worktree;
  if (files.length > MAX_ARTIFACT_FILES) {
    violations.push(`artifact_limit_exceeded:${files.length}`);
    files = files.slice(0, MAX_ARTIFACT_FILES);
  }
  const seal = opts.sealer ?? defaultSeal;
  const capturedAt = new Date().toISOString();
  for (const [i, file] of files.entries()) {
    const rel = relative(artifactsRoot, file).split(sep).join("/");
    try {
      receipts.push(
        await seal({
          runId: run.runId,
          kind: inferArtifactKind(rel),
          storeRoot: opts.storeRoot,
          srcPath: file,
          id: `ev-${i}-${sanitizeIdFragment(rel)}`,
          capturedAt,
        }),
      );
    } catch {
      // A file we cannot seal into the store is a violation, never a silent skip.
      violations.push(`artifact_seal_failed:${rel}`);
    }
  }
  return receipts;
}

/** Recursive file walk. Symlinks are never followed (no escape from worktree). */
/** Spawn + readiness-poll + process-group teardown for the app under test. */
async function startAppServer(
  cmd: { argv: readonly string[]; readyUrl: string; timeoutMs?: number },
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<{ stop: () => void }> {
  const { spawn } = await importSpawn();
  const child = spawn(cmd.argv[0]!, [...cmd.argv.slice(1)], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = (): void => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const timeoutMs = cmd.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt";
  const exitedEarly = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited early (code ${String(code)})`)));
    child.once("error", (err) => reject(err));
  });
  const ready = (async (): Promise<void> => {
    while (Date.now() < deadline) {
      try {
        const res = await fetchImpl(cmd.readyUrl, { signal: AbortSignal.timeout(2_000) });
        if (res.status > 0) return;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      const { promise: tick, resolve: tickDone } = Promise.withResolvers<void>();
      setImmediate(tickDone);
      await tick;
    }
    throw new Error(`server not ready at ${cmd.readyUrl} within ${String(timeoutMs)}ms (${lastError})`);
  })();
  try {
    await Promise.race([ready, exitedEarly]);
  } catch (e) {
    stop();
    throw e;
  }
  return { stop };
}

// node:child_process spawn is imported lazily here ONLY to keep the hot
// preflight path free of the import cost in library consumers.
const importSpawn = (): Promise<typeof import("node:child_process")> => import("node:child_process");

/** path → {mtimeMs,size} for every file under every discovered artifacts dir. */
function snapshotArtifactFiles(worktree: string): Map<string, { mtimeMs: number; size: number }> {
  const snap = new Map<string, { mtimeMs: number; size: number }>();
  for (const rootDir of findArtifactDirs(worktree, 3)) {
    for (const f of walkFiles(rootDir)) {
      try {
        const st = statSync(f);
        snap.set(f, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // vanished between walk and stat — not evidence either way
      }
    }
  }
  return snap;
}

function findArtifactDirs(root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".git")) continue;
      const full = join(dir, e.name);
      if (e.name === "artifacts") found.push(full);
      else visit(full, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

/** artifacts/<kind>/... convention wins; else .json → json_report; else log. */
function inferArtifactKind(relPath: string): ArtifactKind {
  const segments = relPath.split("/").filter((seg) => seg.length > 0);
  for (const seg of segments) {
    const kind = ARTIFACT_FOLDER_ALIASES[seg];
    if (kind !== undefined) return kind;
  }
  return relPath.endsWith(".json") ? "json_report" : "log";
}

function sanitizeIdFragment(relPath: string): string {
  const cleaned = relPath
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(-80);
  return cleaned.length > 0 ? cleaned : "artifact";
}

const defaultSeal: ReceiptSealer = (params) => sealReceipt(params);
