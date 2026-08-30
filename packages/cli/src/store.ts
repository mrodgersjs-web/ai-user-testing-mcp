/**
 * Run store: the single persistence point for RunManifests and evidence.
 *
 * Layout under <root>/.rig-testlab/store (gitignored):
 *   runs/<runId>/manifest.json      — the RunManifest, rewritten after execution
 *   runs/<runId>/artifacts/<...>    — sealed artifacts (evidence package writes here)
 *
 * Writes are tmp+rename (atomic): `run wait` must never observe a half-written
 * manifest. Reads of missing/corrupt manifests report honestly, never crash.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunManifest } from "@rig-testlab/catalog";

export function runDir(storeRoot: string, runId: string): string {
  return join(storeRoot, "runs", runId);
}

export function saveManifest(storeRoot: string, manifest: RunManifest): string {
  const path = join(runDir(storeRoot, manifest.runId), "manifest.json");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

export type ManifestRead = { ok: true; manifest: RunManifest } | { ok: false; reason: string };

export function readManifest(storeRoot: string, runId: string): ManifestRead {
  const path = join(runDir(storeRoot, runId), "manifest.json");
  if (!existsSync(path)) return { ok: false, reason: `no manifest at ${path}` };
  try {
    return { ok: true, manifest: JSON.parse(readFileSync(path, "utf8")) as RunManifest };
  } catch (err) {
    return { ok: false, reason: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function listRunIds(storeRoot: string): string[] {
  const runsDir = join(storeRoot, "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, "manifest.json")))
    .map((d) => d.name)
    .sort();
}

/** Append one JSON line to an append-only audit log; returns the file path. */
export function appendAudit(dir: string, file: string, entry: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a+" });
  return path;
}
