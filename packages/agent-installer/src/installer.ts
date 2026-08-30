/**
 * Six-harness agent installer.
 *
 * Governance invariants:
 * - apply() is refuse-before-touch: any planned CONFLICT (a differing file at a
 *   dst that no prior receipt for this package lists) aborts the whole apply
 *   with zero mutations; the conflicting paths are reported individually.
 * - A BackupManifest JSON is written BEFORE the first mutation and covers every
 *   planned path (pre-image hash + backup copy, or 'absent').
 * - Every per-file mutation is tmp-file + rename in the destination dir, so any
 *   single path flips atomically.
 * - dryRun applies to every verb: plan output / intent report only, zero writes.
 * - rollback()/uninstall() restore or remove exactly the managed paths recorded
 *   in a receipt, verified byte-equal against the stored hashes.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { Harness } from "@rig-testlab/catalog";

import {
  expandHomePath,
  validateInstallManifest,
  type ConfigMergeSpec,
  type InstallManifest,
} from "./manifest-format.js";
import {
  listReceipts,
  readBackupManifest,
  readReceipt,
  sha256Hex,
  writeBackupManifest,
  writeReceipt,
  type BackupEntry,
  type BackupManifest,
  type InstallReceiptDoc,
  type ReceiptConfigEntry,
  type ReceiptContent,
} from "./receipts.js";

export interface InstallerOptions {
  manifest: InstallManifest;
  /** Home the installer manages (tests point this at a temp dir; never the real ~). */
  home: string;
  dryRun?: boolean;
  /** Receipt tree root; defaults to <home>/.rig-installer/receipts. */
  receiptDir?: string;
  /** Injectable clock for backup-manifest stamps. */
  now?: () => Date;
}

export type PlannedAction = "create" | "replace" | "nochange" | "conflict";
export type PlannedKind = "file" | "configMerge" | "alias";

export interface PlannedPath {
  harness: Harness;
  kind: PlannedKind;
  /** Resolved absolute destination (configMerge: the merged file). */
  path: string;
  action: PlannedAction;
  /** Planned backup location for create/replace; null for nochange/conflict. */
  backupPath: string | null;
  srcPath?: string;
  pointsTo?: string;
  marker?: string;
  /** Human-readable cause; present on conflict. */
  reason?: string;
}

/** Internal plan entry: PlannedPath plus the exact bytes apply() will write. */
interface PlanEntry extends PlannedPath {
  content: Buffer;
}

export interface ApplyResult {
  dryRun: boolean;
  planned: PlannedPath[];
  conflicts: PlannedPath[];
  receipts: InstallReceiptDoc[];
  /** One backup manifest per harness receipt, all written before the first mutation. */
  backupManifestPaths: string[];
}

export interface CheckEntry {
  harness: Harness;
  path: string;
  status: "ok" | "modified" | "missing";
  expectedSha256: string | null;
  actualSha256: string | null;
  detail?: string;
}

export interface CheckReport {
  clean: boolean;
  entries: CheckEntry[];
}

export interface RollbackResult {
  dryRun: boolean;
  restored: string[];
  removed: string[];
  /** True when every restore was re-hashed and matched the pre-image. */
  verified: boolean;
}

export interface UninstallResult {
  dryRun: boolean;
  removed: string[];
  stripped: string[];
  skipped: string[];
}

export function markerBeginLine(marker: string): string {
  return `rig-installer:${marker}:begin`;
}

export function markerEndLine(marker: string): string {
  return `rig-installer:${marker}:end`;
}

/**
 * Idempotent marker-block merge: if the block sits between the markers its body
 * is replaced in place; if identical the content is returned untouched;
 * otherwise the delimited block is appended, preserving surrounding content.
 */
export function mergeConfigBlock(current: string, marker: string, block: string): string {
  const begin = markerBeginLine(marker);
  const end = markerEndLine(marker);
  const lines = current.split("\n");
  const b = lines.findIndex((l) => l.includes(begin));
  if (b !== -1) {
    for (let i = b + 1; i < lines.length; i++) {
      if (lines[i]!.includes(end)) {
        if (lines.slice(b + 1, i).join("\n") === block) return current;
        return [...lines.slice(0, b + 1), ...block.split("\n"), ...lines.slice(i)].join("\n");
      }
    }
  }
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  return `${current}${sep}${begin}\n${block}\n${end}\n`;
}

/** Remove the marker-delimited block (inclusive of marker lines); no-op when absent. */
export function stripConfigBlock(current: string, marker: string): string {
  const begin = markerBeginLine(marker);
  const end = markerEndLine(marker);
  const lines = current.split("\n");
  const b = lines.findIndex((l) => l.includes(begin));
  if (b === -1) return current;
  for (let i = b + 1; i < lines.length; i++) {
    if (lines[i]!.includes(end)) {
      return [...lines.slice(0, b), ...lines.slice(i + 1)].join("\n");
    }
  }
  return current;
}

function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

type HarnessTarget = NonNullable<InstallManifest["harnessTargets"][Harness]>;

export class Installer {
  private readonly manifest: InstallManifest;
  private readonly home: string;
  private readonly dryRun: boolean;
  private readonly receiptDir: string;
  private readonly dotDir: string;
  private readonly createdAt: Date;
  private readonly stamp: string;
  private readonly backupDir: string;

  constructor(opts: InstallerOptions) {
    const validation = validateInstallManifest(opts.manifest);
    if (!validation.ok) {
      throw new Error(`invalid InstallManifest: ${validation.errors.join("; ")}`);
    }
    this.manifest = opts.manifest;
    this.home = opts.home;
    this.dryRun = opts.dryRun ?? false;
    this.dotDir = join(opts.home, ".rig-installer");
    this.receiptDir = opts.receiptDir ?? join(this.dotDir, "receipts");
    this.createdAt = (opts.now ?? (() => new Date()))();
    this.stamp = this.createdAt.toISOString().replace(/[:.]/g, "-");
    this.backupDir = join(this.dotDir, `backup-${this.manifest.packageName}-${this.stamp}`);
  }

  /** Current receipts for this package (all versions/harnesses). */
  receipts(): InstallReceiptDoc[] {
    return listReceipts(this.receiptDir, this.manifest.packageName);
  }

  plan(): PlannedPath[] {
    return this.buildPlan().map(({ content: _content, ...pub }) => pub);
  }

  apply(): ApplyResult {
    const entries = this.buildPlan();
    const planned = entries.map(({ content: _content, ...pub }) => pub);
    const conflicts = planned.filter((p) => p.action === "conflict");
    if (this.dryRun || conflicts.length > 0) {
      // Refuse before touching anything; conflicts are reported per-path.
      return { dryRun: this.dryRun, planned, conflicts, receipts: [], backupManifestPaths: [] };
    }

    // BackupManifest BEFORE the first mutation, covering EVERY planned path
    // (including nochange) so rollback is a true pre-apply snapshot.
    const backupEntries: BackupEntry[] = entries.map((e, i) =>
      isRegularFile(e.path)
        ? {
            dst: e.path,
            existed: true,
            sha256: sha256Hex(readFileSync(e.path)),
            backupPath: this.backupPathFor(i, e.path),
          }
        : { dst: e.path, existed: false, sha256: "", backupPath: "absent" },
    );
    mkdirSync(this.backupDir, { recursive: true });
    for (const entry of backupEntries) {
      if (entry.existed) copyFileSync(entry.dst, entry.backupPath);
    }
    // One backup manifest per harness receipt — rollback is receipt-scoped —
    // all written before the first mutation.
    const backupManifestPaths: string[] = [];
    for (const [harness] of this.targets()) {
      const path = this.backupManifestPathFor(harness);
      writeBackupManifest(path, {
        schemaVersion: 1,
        packageName: this.manifest.packageName,
        createdAt: this.createdAt.toISOString(),
        entries: backupEntries.filter((_, i) => entries[i]!.harness === harness),
      });
      backupManifestPaths.push(path);
    }

    for (const e of entries) {
      if (e.action === "nochange") continue;
      mkdirSync(dirname(e.path), { recursive: true });
      const tmp = `${e.path}.rig-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmp, e.content);
      renameSync(tmp, e.path);
    }

    const receipts: InstallReceiptDoc[] = [];
    for (const [harness, target] of this.targets()) {
      const content: ReceiptContent = {
        schemaVersion: 1,
        packageName: this.manifest.packageName,
        version: this.manifest.version,
        harness,
        home: this.home,
        files: entries
          .filter((e) => e.harness === harness && e.kind === "file")
          .map((e) => ({ dst: e.path, sha256: sha256Hex(e.content) })),
        configMerges: this.configReceiptEntries(harness, target, entries),
        aliases: entries
          .filter((e) => e.harness === harness && e.kind === "alias")
          .map((e) => ({ dst: e.path, sha256: sha256Hex(e.content), pointsTo: e.pointsTo! })),
      };
      receipts.push(writeReceipt(this.receiptDir, content, this.backupManifestPathFor(harness)));
    }
    return { dryRun: false, planned, conflicts, receipts, backupManifestPaths };
  }

  /** Drift report: live bytes vs receipt hashes for every managed path. */
  check(): CheckReport {
    const entries: CheckEntry[] = [];
    for (const receipt of this.receipts()) {
      const scan = (path: string, expected: string, kind: "file" | "alias") => {
        const actual = isRegularFile(path) ? sha256Hex(readFileSync(path)) : null;
        entries.push({
          harness: receipt.harness,
          path,
          status: actual === null ? "missing" : actual === expected ? "ok" : "modified",
          expectedSha256: expected,
          actualSha256: actual,
          detail: actual === null ? `${kind} not found on disk` : undefined,
        });
      };
      for (const f of receipt.files) scan(f.dst, f.sha256, "file");
      for (const a of receipt.aliases) scan(a.dst, a.sha256, "alias");
      for (const c of receipt.configMerges) {
        if (!isRegularFile(c.file)) {
          entries.push({
            harness: receipt.harness,
            path: c.file,
            status: "missing",
            expectedSha256: null,
            actualSha256: null,
            detail: `merged config file not found (marker ${c.marker})`,
          });
          continue;
        }
        const live = readFileSync(c.file, "utf8");
        const wantBlock = this.configBlock(receipt.harness, c.marker);
        const detail =
          wantBlock === null
            ? `marker ${c.marker} no longer declared in manifest`
            : mergeConfigBlock(live, c.marker, wantBlock) === live
              ? undefined
              : "marker block missing or differs from manifest block";
        entries.push({
          harness: receipt.harness,
          path: c.file,
          status: detail === undefined ? "ok" : "modified",
          expectedSha256: null,
          actualSha256: sha256Hex(live),
          detail,
        });
      }
    }
    return { clean: entries.every((e) => e.status === "ok"), entries };
  }

  /** Undo the apply that produced `receipt`: restore pre-images, delete created paths. */
  rollback(receipt: InstallReceiptDoc | string): RollbackResult {
    const doc = typeof receipt === "string" ? readReceipt(receipt) : receipt;
    const manifest = readBackupManifest(doc.backupManifestPath);
    const restored = manifest.entries.filter((e) => e.existed).map((e) => e.dst);
    const removed = manifest.entries.filter((e) => !e.existed).map((e) => e.dst);
    if (this.dryRun) return { dryRun: true, restored, removed, verified: false };

    for (const entry of manifest.entries) {
      if (entry.backupPath === "absent") {
        if (isRegularFile(entry.dst)) unlinkSync(entry.dst);
        continue;
      }
      const bytes = readFileSync(entry.backupPath);
      mkdirSync(dirname(entry.dst), { recursive: true });
      const tmp = `${entry.dst}.rig-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, entry.dst);
      if (sha256Hex(readFileSync(entry.dst)) !== entry.sha256) {
        throw new Error(
          `rollback verification failed for ${entry.dst}: bytes differ from backup ${entry.backupPath}`,
        );
      }
    }
    rmSync(dirname(doc.receiptPath), { recursive: true, force: true });
    return { dryRun: false, restored, removed, verified: true };
  }

  /** Remove managed files/aliases and strip merged config blocks; leaves everything else alone. */
  uninstall(receipt: InstallReceiptDoc | string): UninstallResult {
    const doc = typeof receipt === "string" ? readReceipt(receipt) : receipt;
    const result: UninstallResult = {
      dryRun: this.dryRun,
      removed: this.dryRun
        ? [...doc.files.map((f) => f.dst), ...doc.aliases.map((a) => a.dst)]
        : [],
      stripped: this.dryRun
        ? doc.configMerges.filter((c) => c.existedAtInstall).map((c) => c.file)
        : [],
      skipped: [],
    };
    if (this.dryRun) return result;

    const drop = (path: string) => {
      if (isRegularFile(path)) {
        unlinkSync(path);
        result.removed.push(path);
      } else {
        result.skipped.push(path);
      }
    };
    for (const f of doc.files) drop(f.dst);
    for (const a of doc.aliases) drop(a.dst);
    for (const c of doc.configMerges) {
      if (!c.existedAtInstall) {
        // The installer created this file for its block; removal is the clean inverse.
        drop(c.file);
        continue;
      }
      if (!isRegularFile(c.file)) {
        result.skipped.push(c.file);
        continue;
      }
      const live = readFileSync(c.file, "utf8");
      const stripped = stripConfigBlock(live, c.marker);
      if (stripped === live) {
        result.skipped.push(c.file);
        continue;
      }
      const tmp = `${c.file}.rig-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmp, stripped);
      renameSync(tmp, c.file);
      result.stripped.push(c.file);
    }
    rmSync(dirname(doc.receiptPath), { recursive: true, force: true });
    return result;
  }

  private targets(): Array<[Harness, HarnessTarget]> {
    return Object.entries(this.manifest.harnessTargets) as Array<[Harness, HarnessTarget]>;
  }

  /** dst paths managed by any prior receipt of this package, per harness. */
  private managedPaths(): Map<Harness, Set<string>> {
    const map = new Map<Harness, Set<string>>();
    for (const r of this.receipts()) {
      let set = map.get(r.harness);
      if (!set) {
        set = new Set();
        map.set(r.harness, set);
      }
      for (const f of r.files) set.add(f.dst);
      for (const a of r.aliases) set.add(a.dst);
      for (const c of r.configMerges) set.add(c.file);
    }
    return map;
  }

  private backupPathFor(index: number, dst: string): string {
    return join(this.backupDir, `${index}__${basename(dst)}`);
  }

  private backupManifestPathFor(harness: Harness): string {
    return join(this.dotDir, `backup-${this.manifest.packageName}-${this.stamp}-${harness}.json`);
  }

  private buildPlan(): PlanEntry[] {
    const managed = this.managedPaths();
    const out: PlanEntry[] = [];
    const resolve = (p: string): string => {
      const r = expandHomePath(p, this.home);
      if (!isAbsolute(r)) {
        throw new Error(`manifest path ${p} does not resolve to an absolute destination`);
      }
      return r;
    };

    const push = (base: Omit<PlanEntry, "content">, content: Buffer): void => {
      out.push({ ...base, content });
    };
    const planPath = (
      harness: Harness,
      kind: PlannedKind,
      dst: string,
      want: Buffer,
      isManaged: boolean,
      extra: Pick<PlanEntry, "srcPath" | "pointsTo" | "marker">,
      conflictReason: string,
    ): void => {
      let action: PlannedAction;
      let reason: string | undefined;
      if (!existsSync(dst)) action = "create";
      else if (!isRegularFile(dst)) {
        action = "conflict";
        reason = `path ${dst} exists but is not a regular file`;
      } else if (readFileSync(dst).equals(want)) action = "nochange";
      else if (isManaged) action = "replace";
      else {
        action = "conflict";
        reason = conflictReason;
      }
      const idx = out.length;
      push(
        {
          harness,
          kind,
          path: dst,
          action,
          backupPath: action === "create" || action === "replace" ? this.backupPathFor(idx, dst) : null,
          reason,
          ...extra,
        },
        want,
      );
    };

    for (const [harness, target] of this.targets()) {
      const managedSet = managed.get(harness) ?? new Set<string>();
      for (const f of target.files) {
        const srcPath = resolve(f.src);
        if (!isRegularFile(srcPath)) throw new Error(`payload source missing: ${srcPath}`);
        const dst = resolve(f.dst);
        planPath(harness, "file", dst, readFileSync(srcPath), managedSet.has(dst), { srcPath },
          `existing file at ${dst} is not covered by any prior receipt for package ${this.manifest.packageName}; refusing to overwrite`);
      }
      for (const a of target.aliases ?? []) {
        const dst = resolve(a.dst);
        planPath(harness, "alias", dst, Buffer.from(`${a.pointsTo}\n`, "utf8"), managedSet.has(dst), { pointsTo: a.pointsTo },
          `existing file at ${dst} is not covered by any prior receipt for package ${this.manifest.packageName}; refusing to overwrite`);
      }
      for (const m of target.configMerge ?? []) {
        const file = resolve(m.file);
        const current = isRegularFile(file) ? readFileSync(file, "utf8") : null;
        const desired =
          current === null
            ? `${markerBeginLine(m.marker)}\n${m.block}\n${markerEndLine(m.marker)}\n`
            : mergeConfigBlock(current, m.marker, m.block);
        const action: PlannedAction =
          current === null ? "create" : desired === current ? "nochange" : "replace";
        const idx = out.length;
        push(
          {
            harness,
            kind: "configMerge",
            path: file,
            marker: m.marker,
            action,
            backupPath: action === "create" || action === "replace" ? this.backupPathFor(idx, file) : null,
          },
          Buffer.from(desired, "utf8"),
        );
      }
    }
    return out;
  }

  /** The manifest block a receipt's marker should currently contain. */
  private configBlock(harness: Harness, marker: string): string | null {
    const found = this.manifest.harnessTargets[harness]?.configMerge?.find((m) => m.marker === marker);
    return found ? found.block : null;
  }

  private configReceiptEntries(harness: Harness, target: HarnessTarget, entries: PlanEntry[]): ReceiptConfigEntry[] {
    const prior = this.receipts().filter((r) => r.harness === harness);
    return (target.configMerge ?? []).map((m: ConfigMergeSpec) => {
      const file = expandHomePath(m.file, this.home);
      const carried = prior.flatMap((r) => r.configMerges).find((c) => c.file === file && c.marker === m.marker);
      const planned = entries.find((e) => e.kind === "configMerge" && e.path === file && e.marker === m.marker);
      return {
        file,
        marker: m.marker,
        // Carry the original creation fact across reinstalls so the receipt stays stable.
        existedAtInstall: carried ? carried.existedAtInstall : planned?.action === "replace",
      };
    });
  }
}
