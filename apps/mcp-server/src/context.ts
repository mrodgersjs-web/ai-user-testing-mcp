/**
 * LabContext — the file-backed world the MCP server operates on.
 *
 * Startup contract: constructing the context reads ONLY catalog.lock.json
 * (parse + schema validation). No clone, no index build, no store writes.
 * Everything else (FTS index, suites, runs, evidence) is created lazily on
 * first use, under `storeRoot` (conventionally `.rig-testlab/`).
 *
 * Seams for tests (and for operator environments): injected spawner,
 * credential resolver, tool checker, clock, and `sourcesRoot`. Credentials
 * are resolved BY NAME only; values never persist in any returned structure.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildFtsIndex, repoRoot, searchIndex, validateLock } from "@rig-testlab/catalog";
import type {
  AdapterDescriptor,
  CatalogEntry,
  CatalogLock,
  SearchHit,
  SourcePin,
  RunManifest,
} from "@rig-testlab/catalog";
import type { CompileRefusal, ProjectManifest } from "@rig-testlab/scenario-compiler";
import {
  childProcessSpawner,
  defaultToolChecker,
  type CredentialResolver,
  type ExecuteRunOptions,
  type ProcessSpawner,
  type ToolChecker,
} from "@rig-testlab/runner";
import { ToolFailure } from "./errors.js";

export interface LabServerOptions {
  /** Path to the committed catalog.lock.json. Read at startup, nothing else. */
  lockPath: string;
  /** Root for index.db, suites/, runs/, evidence/, sandbox/. Created lazily. */
  storeRoot: string;
  /** Directory of reviewed AdapterDescriptor JSON files. */
  adaptersDir: string;
  /** Directory containing the submodule tree; submodulePath values are relative to it. Defaults to <repoRoot>. */
  sourcesRoot?: string;
  spawner?: ProcessSpawner;
  credentialResolver?: CredentialResolver;
  toolChecker?: ToolChecker;
  /** Injectable clock; tests pin it for deterministic timestamps. */
  now?: () => Date;
}

export interface AdapterFileLoad {
  file: string;
  descriptor?: AdapterDescriptor;
  reason?: string;
}

export interface StoredSuite {
  schemaVersion: 1;
  suiteId: string;
  compiledAt: string;
  project: ProjectManifest;
  manifests: RunManifest[];
  refusals: CompileRefusal[];
}

/** Required-key check mirroring AdapterDescriptor.v1.schema.json; ajv re-validates at compile. */
function adapterShapeErrors(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["not an object"];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["id", "name", "adapterVersion", "sourceEntryId", "status", "credentialMode"] as const) {
    if (typeof obj[key] !== "string") errors.push(`${key}: expected string`);
  }
  if (typeof obj.paidProvider !== "boolean") errors.push("paidProvider: expected boolean");
  if (!Array.isArray(obj.commandAllowlist) || obj.commandAllowlist.length === 0) {
    errors.push("commandAllowlist: expected non-empty array");
  }
  if (!Array.isArray(obj.networkAllowlist)) errors.push("networkAllowlist: expected array");
  if (!Array.isArray(obj.evidenceKinds)) errors.push("evidenceKinds: expected array");
  if (typeof obj.limits !== "object" || obj.limits === null) errors.push("limits: expected object");
  if (typeof obj.fixtures !== "object" || obj.fixtures === null) errors.push("fixtures: expected object");
  return errors;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Write-and-rename so concurrent readers never see a half-written manifest. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export class LabContext {
  readonly lock: CatalogLock;
  readonly lockPath: string;
  readonly storeRoot: string;
  readonly adaptersDir: string;
  readonly sourcesRoot: string;
  readonly repoRoot: string;
  /** sha256 of the lock FILE bytes — index-cache key and provenance anchor. */
  readonly lockHash: string;

  readonly spawner: ProcessSpawner;
  readonly credentialResolver: CredentialResolver | undefined;
  readonly toolChecker: ToolChecker;
  private readonly clock: () => Date;

  private readonly entriesById: Map<string, CatalogEntry>;
  private readonly pinsByEntryId: Map<string, SourcePin>;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(opts: LabServerOptions) {
    this.lockPath = resolve(opts.lockPath);
    this.storeRoot = resolve(opts.storeRoot);
    this.adaptersDir = resolve(opts.adaptersDir);
    this.repoRoot = repoRoot(this.lockPath);
    this.sourcesRoot = resolve(opts.sourcesRoot ?? this.repoRoot);
    this.clock = opts.now ?? (() => new Date());
    this.spawner = opts.spawner ?? childProcessSpawner();
    this.credentialResolver = opts.credentialResolver;
    this.toolChecker = opts.toolChecker ?? defaultToolChecker;

    let raw: string;
    try {
      raw = readFileSync(this.lockPath, "utf8");
    } catch (err) {
      throw new ToolFailure(
        "LOCK_INVALID",
        `cannot read catalog lock at ${this.lockPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.lockHash = createHash("sha256").update(raw, "utf8").digest("hex");
    let parsed: CatalogLock;
    try {
      parsed = JSON.parse(raw) as CatalogLock;
    } catch (err) {
      throw new ToolFailure(
        "LOCK_INVALID",
        `catalog lock is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const verdict = validateLock(parsed);
    if (!verdict.ok) {
      throw new ToolFailure(
        "LOCK_INVALID",
        `catalog lock failed schema validation: ${verdict.errors.slice(0, 5).join("; ")}`,
      );
    }
    this.lock = parsed;
    this.entriesById = new Map(parsed.entries.map((e) => [e.id, e]));
    this.pinsByEntryId = new Map(parsed.pins.map((p) => [p.entryId, p]));
  }

  nowIso(): string {
    return this.clock().toISOString();
  }

  entry(id: string): CatalogEntry | undefined {
    return this.entriesById.get(id);
  }

  pinFor(entryId: string): SourcePin | undefined {
    return this.pinsByEntryId.get(entryId);
  }

  /** The exact operator command to hydrate a pin. The server never runs git itself. */
  hydrateCommand(pin: SourcePin): string {
    return `git submodule update --init -- ${pin.submodulePath}`;
  }

  // ── FTS index (lazy, cached by lock-bytes hash) ──────────────────────────

  indexDbPath(): string {
    return join(this.storeRoot, "index.db");
  }

  /** Rebuild only when the persisted index was built from different lock bytes. */
  ensureIndex(): string {
    const dbPath = this.indexDbPath();
    const metaPath = join(this.storeRoot, "index.meta.json");
    try {
      const meta = readJsonFile(metaPath) as { lockHash?: unknown };
      if (meta.lockHash === this.lockHash && existsSync(dbPath)) return dbPath;
    } catch {
      /* no cache yet — fall through to rebuild */
    }
    const rows = buildFtsIndex(this.lock, dbPath);
    writeJsonAtomic(metaPath, { lockHash: this.lockHash, builtAt: this.nowIso(), rows });
    return dbPath;
  }

  search(query: string, limit: number): SearchHit[] {
    return searchIndex(this.ensureIndex(), query, limit);
  }

  // ── adapters ──────────────────────────────────────────────────────────────

  loadAdapterFiles(): { dirPresent: boolean; loads: AdapterFileLoad[] } {
    if (!existsSync(this.adaptersDir)) return { dirPresent: false, loads: [] };
    const loads: AdapterFileLoad[] = [];
    // Repo-canonical layout: adapters/<id>/adapter.json (same as the CLI loader).
    for (const dir of readdirSync(this.adaptersDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      const full = join(this.adaptersDir, dir, "adapter.json");
      if (!existsSync(full)) {
        loads.push({ file: `${dir}/adapter.json`, reason: "missing adapter.json" });
        continue;
      }
      let raw: unknown;
      try {
        raw = readJsonFile(full);
      } catch (err) {
        loads.push({ file: `${dir}/adapter.json`, reason: `unparseable JSON: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const errors = adapterShapeErrors(raw);
      if (errors.length > 0) {
        loads.push({ file: `${dir}/adapter.json`, reason: errors.join("; ") });
        continue;
      }
      loads.push({ file: `${dir}/adapter.json`, descriptor: raw as AdapterDescriptor });
    }
    return { dirPresent: true, loads };
  }

  adapters(): AdapterDescriptor[] {
    return this.loadAdapterFiles().loads.flatMap((l) => (l.descriptor ? [l.descriptor] : []));
  }

  // ── store: scenarios, suites, runs ────────────────────────────────────────

  scenarioPath(scenarioId: string): string {
    return join(this.storeRoot, "scenarios", `${scenarioId}.json`);
  }

  readScenario(scenarioId: string): unknown {
    try {
      return readJsonFile(this.scenarioPath(scenarioId));
    } catch {
      throw new ToolFailure(
        "SCENARIO_NOT_FOUND",
        `no scenario '${scenarioId}' in ${this.scenarioPath(scenarioId)}; provide an inline spec or store one first`,
      );
    }
  }

  suitePath(suiteId: string): string {
    return join(this.storeRoot, "suites", `${suiteId}.json`);
  }

  readSuite(suiteId: string): StoredSuite {
    try {
      return readJsonFile(this.suitePath(suiteId)) as StoredSuite;
    } catch {
      throw new ToolFailure(
        "SUITE_NOT_FOUND",
        `no compiled suite '${suiteId}' at ${this.suitePath(suiteId)}; run suite.compile first`,
      );
    }
  }

  saveSuite(suite: StoredSuite): void {
    writeJsonAtomic(this.suitePath(suite.suiteId), suite);
  }

  listSuites(): string[] {
    return this.listStoreIds(join(this.storeRoot, "suites"));
  }

  runPath(runId: string): string {
    return join(this.storeRoot, "runs", `${runId}.json`);
  }

  readRun(runId: string): RunManifest | undefined {
    try {
      return readJsonFile(this.runPath(runId)) as RunManifest;
    } catch {
      return undefined;
    }
  }

  saveRun(manifest: RunManifest): void {
    writeJsonAtomic(this.runPath(manifest.runId), manifest);
  }

  listRuns(): string[] {
    return this.listStoreIds(join(this.storeRoot, "runs"));
  }

  private listStoreIds(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }

  // ── active-run registry (cancellation seam) ───────────────────────────────

  beginRun(runId: string): AbortController {
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    return controller;
  }

  endRun(runId: string): void {
    this.activeRuns.delete(runId);
  }

  isRunning(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  /** Abort every in-flight run; executeRun lands each manifest in 'cancelled'. */
  cancelActiveRuns(): number {
    const count = this.activeRuns.size;
    for (const controller of this.activeRuns.values()) controller.abort();
    return count;
  }
  // ── execution paths under storeRoot ───────────────────────────────────────

  get evidenceRoot(): string {
    return join(this.storeRoot, "evidence");
  }

  get sandboxRoot(): string {
    return join(this.storeRoot, "sandbox");
  }

  /** executeRun with this context's seams pre-wired. */
  executeRunOptions(extra: Omit<ExecuteRunOptions, "baseDir" | "storeRoot" | "spawner">): ExecuteRunOptions {
    return {
      ...extra,
      baseDir: this.sandboxRoot,
      storeRoot: this.evidenceRoot,
      spawner: this.spawner,
      credentialResolver: this.credentialResolver,
      toolChecker: this.toolChecker,
    };
  }
}
