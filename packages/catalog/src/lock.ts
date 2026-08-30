/**
 * CatalogLock construction and byte-stable canonical serialization.
 *
 * writeLock output is deterministic: entries/pins/catalogs sorted by id,
 * provenance edges sorted, every object key emitted in sorted order.
 * Two builds from the same inputs produce byte-identical files.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AdoptionTier, CatalogEntry, CatalogLock, ResolutionStatus, SourcePin } from "./types.js";

const STATUS_ORDER: readonly ResolutionStatus[] = [
  "active", "redirected", "rate_limited", "blocked_by_provider", "dead", "unresolved", "quarantined",
];
const TIER_ORDER: readonly AdoptionTier[] = [
  "core_runner", "approved_adapter", "optional_adapter", "reference", "watchlist", "quarantined",
];

export interface LockInput {
  entries: CatalogEntry[];
  pins: SourcePin[];
  nestedCatalogs: CatalogLock["nestedCatalogs"];
  generatedFrom: CatalogLock["generatedFrom"];
}

/** Assemble a CatalogLock with computed statistics, sorted for canonical output. */
export function buildLock(input: LockInput): CatalogLock {
  const entries = [...input.entries].sort((a, b) => a.id.localeCompare(b.id));
  for (const e of entries) {
    e.provenance.sort(
      (a, b) =>
        a.sourceCatalogId.localeCompare(b.sourceCatalogId) ||
        a.depth - b.depth ||
        a.urlAsLinked.localeCompare(b.urlAsLinked),
    );
  }
  const pins = [...input.pins].sort((a, b) => a.entryId.localeCompare(b.entryId));
  const byResolutionStatus: Partial<Record<ResolutionStatus, number>> = {};
  for (const s of STATUS_ORDER) {
    const n = entries.filter((e) => e.resolutionStatus === s).length;
    if (n > 0) byResolutionStatus[s] = n;
  }
  const byAdoptionTier: Partial<Record<AdoptionTier, number>> = {};
  for (const t of TIER_ORDER) {
    const n = entries.filter((e) => e.adoptionTier === t).length;
    if (n > 0) byAdoptionTier[t] = n;
  }
  return {
    schemaVersion: 1,
    generatedFrom: input.generatedFrom,
    nestedCatalogs: [...input.nestedCatalogs].sort((a, b) => a.id.localeCompare(b.id)),
    entries,
    pins,
    statistics: {
      firstLevelCount: entries.filter((e) => e.provenance.some((p) => p.depth === 1)).length,
      uniqueRepos: pins.length,
      byResolutionStatus,
      byAdoptionTier,
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Deterministic serialization: sorted collections, recursively sorted keys, 2-space indent, trailing newline. */
export function serializeLock(lock: CatalogLock): string {
  const ordered: CatalogLock = {
    ...lock,
    nestedCatalogs: [...lock.nestedCatalogs].sort((a, b) => a.id.localeCompare(b.id)),
    entries: [...lock.entries].sort((a, b) => a.id.localeCompare(b.id)),
    pins: [...lock.pins].sort((a, b) => a.entryId.localeCompare(b.entryId)),
  };
  return `${JSON.stringify(canonicalize(ordered), null, 2)}\n`;
}

export function writeLock(lock: CatalogLock, filePath: string): string {
  const text = serializeLock(buildLock({
    entries: lock.entries,
    pins: lock.pins,
    nestedCatalogs: lock.nestedCatalogs,
    generatedFrom: lock.generatedFrom,
  }));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
  return text;
}

export function readLock(filePath: string): CatalogLock {
  return JSON.parse(readFileSync(filePath, "utf8")) as CatalogLock;
}

/** Repo root = first ancestor containing pnpm-workspace.yaml (never hardcoded). */
export function repoRoot(startDir: string = import.meta.dirname): string {
  let dir = startDir;
  for (;;) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error(`pnpm-workspace.yaml not found above ${startDir} (import ${fileURLToPath(import.meta.url)})`);
      }
      dir = parent;
    }
  }
}

export function schemasDir(): string {
  return join(repoRoot(), "schemas");
}
