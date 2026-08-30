/**
 * Adoption tier and execution policy defaults.
 *
 * Non-negotiable: missing/restrictive/unknown license ⇒ reference_only,
 * regardless of anything else. `allowlisted` is reserved for the reviewed
 * set WITH a runnable license (permissive/weak_permissive/copyleft).
 */
import type { AdoptionTier, ExecutionPolicy, LicenseInfo, LicenseKind } from "./types.js";

/**
 * The mission's reviewed-tool set (adapter-reviewed repo names, lowercase).
 * Match rule: repo name equals an entry, or starts with `<entry>-` / `<entry>_`
 * (so `mockserver-monorepo` matches `mockserver`).
 */
export const REVIEWED_TOOLS: readonly string[] = [
  "cypress",
  "watir",
  "appium",
  "testsprite",
  "promptfoo",
  "bruno",
  "zaproxy",
  "nuclei",
  "rrweb",
  "mockserver",
  "datamimic",
  "big-list-of-naughty-strings",
  "agentskeptic",
  "tenro-python",
  "axe-core",
  "cypress-axe",
  "wiremock",
  "keploy",
  "robot-framework",
  "bats-core",
  "foundry",
  "hardhat",
];

/** Quarantine candidates under observation — tier `watchlist`, never auto-quarantined. */
export const WATCHLIST: readonly string[] = [
  "beef", // browser exploitation framework (non-github canonical URL)
];

/**
 * Repos with a CONFIRMED security red flag. Empty by design: quarantined is
 * reachable only through an explicit flag, never a heuristic.
 */
export const SECURITY_RED_FLAGS: readonly string[] = [];

export function matchesReviewed(repoName: string): string | null {
  const n = repoName.toLowerCase();
  for (const tool of REVIEWED_TOOLS) {
    if (n === tool || n.startsWith(`${tool}-`) || n.startsWith(`${tool}_`)) return tool;
  }
  return null;
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function adoptionTierForRepo(repoName: string, securityRedFlag = false): AdoptionTier {
  if (securityRedFlag || SECURITY_RED_FLAGS.includes(repoName.toLowerCase())) return "quarantined";
  if (matchesReviewed(repoName) !== null) return "approved_adapter";
  const key = nameKey(repoName);
  if (WATCHLIST.includes(key) || WATCHLIST.includes(repoName.toLowerCase())) return "watchlist";
  return "reference";
}

const RUNNABLE_LICENSES: Record<LicenseKind, boolean> = {
  permissive: true,
  weak_permissive: true,
  copyleft: true,
  restrictive: false,
  missing: false,
  unknown: false,
};

export function executionPolicyForLicense(license: LicenseInfo, repoName?: string): ExecutionPolicy {
  if (!RUNNABLE_LICENSES[license.kind]) return "reference_only";
  if (repoName !== undefined && matchesReviewed(repoName) !== null) return "allowlisted";
  return "sandbox_required";
}
