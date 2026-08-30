/**
 * InstallManifest format + validation.
 *
 * Wire contract: schemas/InstallManifest.v1.schema.json (frozen). The repo root
 * is resolved by walking up from import.meta.dirname to the directory
 * containing pnpm-workspace.yaml — no hardcoded absolute paths. Validation here
 * is a hand-rolled structural checker mirroring that schema 1:1: ajv is not a
 * declared dependency for this package in pnpm-lock.yaml (its importer entry is
 * empty) and installs are parent-owned, so this module stays node-stdlib-only.
 * Drift between checker and schema is a build bug; tests assert parity.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Harness } from "@rig-testlab/catalog";

export interface InstallFileSpec {
  /** Payload source file: absolute or ~/ path. */
  src: string;
  /** Managed destination path: absolute or ~/ path. */
  dst: string;
}

export interface ConfigMergeSpec {
  /** Shared config file to merge into (absolute or ~/ path). */
  file: string;
  /** Whitespace-free id; block is delimited by `rig-installer:<marker>:begin|end` lines. */
  marker: string;
  /** Block body inserted between the marker lines. */
  block: string;
}

export interface AliasSpec {
  dst: string;
  /** Materialized as a one-line pointer file: `${pointsTo}\n`. */
  pointsTo: string;
}

export interface HarnessTarget {
  files: InstallFileSpec[];
  configMerge?: ConfigMergeSpec[];
  aliases?: AliasSpec[];
}

export interface InstallManifest {
  packageName: string;
  version: string;
  harnessTargets: Partial<Record<Harness, HarnessTarget>>;
}

export const HARNESS_VALUES: readonly Harness[] = [
  "codex",
  "claude",
  "hermes",
  "omp",
  "orca",
  "prime",
];

const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PATH_SPEC_RE = /^[/~][^\0]*$/; // refined below; kept explicit:
const ABS_OR_HOME_RE = /^(\/|~\/|~$)[^\0]*$/;
const MARKER_RE = /^[a-z0-9][a-z0-9._:-]{0,80}$/;

/** Expand a `~`/`~/`-prefixed manifest path against the installer home. */
export function expandHomePath(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home === "/" ? "" : home}/${p.slice(2)}`;
  return p;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural validation mirroring schemas/InstallManifest.v1.schema.json. */
export function validateInstallManifest(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObj(value)) {
    return { ok: false, errors: ["root: expected object"] };
  }
  const { packageName, version, harnessTargets } = value;

  if (typeof packageName !== "string" || !PACKAGE_NAME_RE.test(packageName)) {
    errors.push("packageName: must match ^[a-z0-9][a-z0-9._-]*$");
  }
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    errors.push("version: must match ^\\d+\\.\\d+\\.\\d+$");
  }
  if (!isObj(harnessTargets)) {
    errors.push("harnessTargets: must be an object");
    return { ok: false, errors };
  }

  for (const key of Object.keys(harnessTargets)) {
    if (!(HARNESS_VALUES as readonly string[]).includes(key)) {
      errors.push(`harnessTargets.${key}: unknown harness`);
      continue;
    }
    const target = harnessTargets[key];
    const at = `harnessTargets.${key}`;
    if (!isObj(target)) {
      errors.push(`${at}: expected object`);
      continue;
    }
    const { files, configMerge, aliases } = target;
    if (!Array.isArray(files) || files.length < 1) {
      errors.push(`${at}.files: must be an array with at least 1 entry`);
    } else {
      files.forEach((f, i) => {
        const fat = `${at}.files[${i}]`;
        if (!isObj(f)) {
          errors.push(`${fat}: expected object`);
          return;
        }
        for (const k of ["src", "dst"] as const) {
          const v = f[k];
          if (typeof v !== "string" || !ABS_OR_HOME_RE.test(v)) {
            errors.push(`${fat}.${k}: must be an absolute or ~/ path`);
          }
        }
        for (const extra of Object.keys(f)) {
          if (extra !== "src" && extra !== "dst") errors.push(`${fat}.${extra}: unexpected key`);
        }
      });
    }
    if (configMerge !== undefined) {
      if (!Array.isArray(configMerge)) {
        errors.push(`${at}.configMerge: must be an array`);
      } else {
        configMerge.forEach((m, i) => {
          const mat = `${at}.configMerge[${i}]`;
          if (!isObj(m)) {
            errors.push(`${mat}: expected object`);
            return;
          }
          if (typeof m.file !== "string" || !ABS_OR_HOME_RE.test(m.file)) {
            errors.push(`${mat}.file: must be an absolute or ~/ path`);
          }
          if (typeof m.marker !== "string" || !MARKER_RE.test(m.marker)) {
            errors.push(`${mat}.marker: must match ^[a-z0-9][a-z0-9._:-]{0,80}$`);
          }
          if (typeof m.block !== "string") {
            errors.push(`${mat}.block: must be a string`);
          } else if (
            typeof m.marker === "string" &&
            m.marker.length > 0 &&
            (m.block.includes(`rig-installer:${m.marker}:begin`) ||
              m.block.includes(`rig-installer:${m.marker}:end`))
          ) {
            errors.push(`${mat}.block: must not contain its own delimiter lines`);
          }
        });
      }
    }
    if (aliases !== undefined) {
      if (!Array.isArray(aliases)) {
        errors.push(`${at}.aliases: must be an array`);
      } else {
        aliases.forEach((a, i) => {
          const aat = `${at}.aliases[${i}]`;
          if (!isObj(a)) {
            errors.push(`${aat}: expected object`);
            return;
          }
          if (typeof a.dst !== "string" || !ABS_OR_HOME_RE.test(a.dst)) {
            errors.push(`${aat}.dst: must be an absolute or ~/ path`);
          }
          if (typeof a.pointsTo !== "string" || a.pointsTo.length === 0) {
            errors.push(`${aat}.pointsTo: must be a non-empty string`);
          }
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Walk up from `fromDir` to the dir containing pnpm-workspace.yaml. */
export function findRepoRoot(fromDir: string = import.meta.dirname): string | null {
  let dir = fromDir;
  for (;;) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"), { flag: "r" });
      return dir;
    } catch {
      /* not here; walk up */
    }
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Absolute path of the frozen InstallManifest JSON Schema, or null outside the repo. */
export function installManifestSchemaPath(): string | null {
  const root = findRepoRoot();
  return root === null ? null : join(root, "schemas", "InstallManifest.v1.schema.json");
}
