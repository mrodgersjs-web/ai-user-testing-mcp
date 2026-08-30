import type { Platform } from "@rig-testlab/catalog";

/** Wire shape of schemas/ProjectManifest.v1.schema.json. */
export interface ProjectRepoPin {
  url: string;
  /** Exact commit SHA (lowercase hex, 7–64 chars). */
  revision: string;
}

export interface ProjectSuite {
  /** Path (within the project repo) to the scenario file set. */
  path: string;
  scenarioIds: string[];
}

/**
 * Project-owned manifest consumed by compileSuite. Plain JSON; validated
 * against schemas/ProjectManifest.v1.schema.json before compilation.
 */
export interface ProjectManifest {
  id: string;
  repo: ProjectRepoPin;
  platforms: Platform[];
  suites: ProjectSuite[];
  requiredAdapters: string[];
}
