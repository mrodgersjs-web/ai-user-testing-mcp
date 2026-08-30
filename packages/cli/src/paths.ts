/**
 * Filesystem layout for one rig-testlab invocation.
 *
 * Repo root = first ancestor containing pnpm-workspace.yaml (walk-up, never
 * hardcoded). Everything generated lives under <root>/.rig-testlab/ (gitignored);
 * the committed lock lives at <root>/catalog.lock.json and every path
 * is overridable per command (--lock / --fixture / --root / --store).
 */
import { join } from "node:path";
import { findRepoRoot } from "@rig-testlab/scenario-compiler";

export interface Paths {
  /** Discovered repo root; null when not inside a workspace and no --root. */
  root: string | null;
  /** Resolved lock path; null when neither root nor an explicit override exists. */
  lockPath: string | null;
  adaptersDir: string | null;
  storeRoot: string | null;
  sandboxBase: string | null;
  auditDir: string | null;
  indexDb: string | null;
  indexKey: string | null;
}

export interface PathOverrides {
  root?: string;
  lock?: string;
  adaptersDir?: string;
  store?: string;
  cwd: string;
}

export function resolvePaths(ov: PathOverrides): Paths {
  let root: string | null;
  try {
    root = ov.root ?? findRepoRoot(ov.cwd);
  } catch {
    root = null; // not inside a workspace: commands needing a root fail with ROOT_NOT_FOUND
  }
  return {
    root,
    lockPath: ov.lock ?? (root === null ? null : join(root, "catalog.lock.json")),
    adaptersDir: root === null ? null : join(root, "adapters"),
    storeRoot: root === null ? null : join(root, ".rig-testlab", "store"),
    sandboxBase: root === null ? null : join(root, ".rig-testlab", "sandbox"),
    auditDir: root === null ? null : join(root, ".rig-testlab", "audit"),
    indexDb: root === null ? null : join(root, ".rig-testlab", "index.db"),
    indexKey: root === null ? null : join(root, ".rig-testlab", "index.key"),
  };
}
