/**
 * Default target roots for the six supported harnesses, parameterized by home
 * so every consumer (tests included) can point the installer at a fake home.
 * Pure path computation — no filesystem access.
 */
import { join } from "node:path";

import type { Harness } from "@rig-testlab/catalog";

export interface HarnessRoots {
  /** Harness config directory (e.g. <home>/.codex). */
  root: string;
  skillsDir: string;
  agentsDir: string;
}

export interface HarnessProfileOptions {
  /**
   * Absolute override for the Orca root (Orca state may live outside the home
   * dir); defaults to <home>/.orca. skillsDir/agentsDir are always
   * <root>/skills and <root>/agents relative to whatever root is used.
   */
  orcaRoot?: string;
}

/** Relative layout per harness: [rootSeg, skillsSeg, agentsSeg] under home. */
const HARNESS_LAYOUT: Record<Exclude<Harness, "orca">, readonly [string, string, string]> = {
  codex: [".codex", "skills", "agents"],
  claude: [".claude", "skills", "agents"],
  hermes: [".hermes", "skills", "agents"],
  omp: [".omp", "skills", "agents"],
  prime: [".prime", "skills", "agents"],
};

export function harnessRoots(
  harness: Harness,
  home: string,
  opts: HarnessProfileOptions = {},
): HarnessRoots {
  if (harness === "orca") {
    const root = opts.orcaRoot ?? join(home, ".orca");
    return { root, skillsDir: join(root, "skills"), agentsDir: join(root, "agents") };
  }
  const [rootSeg, skillsSeg, agentsSeg] = HARNESS_LAYOUT[harness];
  const root = join(home, rootSeg);
  return { root, skillsDir: join(root, skillsSeg), agentsDir: join(root, agentsSeg) };
}

/** All six harness roots at once (used to build six-harness manifests). */
export function allHarnessRoots(
  home: string,
  opts: HarnessProfileOptions = {},
): Record<Harness, HarnessRoots> {
  return {
    codex: harnessRoots("codex", home, opts),
    claude: harnessRoots("claude", home, opts),
    hermes: harnessRoots("hermes", home, opts),
    omp: harnessRoots("omp", home, opts),
    orca: harnessRoots("orca", home, opts),
    prime: harnessRoots("prime", home, opts),
  };
}
