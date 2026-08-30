/**
 * Fail-closed catalog guards: no command proceeds on invalid data.
 *
 * loadLockFailClosed — read + ajv schema validation + integrity checks. Any
 * failure prints EVERY ajv error with its JSON-pointer instancePath and exits
 * 2 (validation failure): a malformed lock is a broken input, not a runtime
 * condition. Missing lock is distinct (exit 1, actionable: sync or --lock).
 *
 * ensureIndex — the FTS index is derived state keyed by the sha256 of the
 * lock FILE bytes: any lock byte change invalidates it; identical bytes reuse.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildFtsIndex,
  readLock,
  validateLock,
  verifyLock,
  type CatalogLock,
} from "@rig-testlab/catalog";
import type { CliDeps } from "./deps.js";
import { CommandFailure, UsageError } from "./errors.js";

export function loadLockFailClosed(lockPath: string): CatalogLock {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CommandFailure(
        "CATALOG_LOCK_MISSING",
        `no catalog lock at ${lockPath}; run \`rig-testlab catalog sync\` or pass --lock <file>`,
      );
    }
    throw new UsageError("CATALOG_LOCK_UNREADABLE", `${lockPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      "CATALOG_LOCK_INVALID",
      `${lockPath} is not valid JSON`,
      "",
      [`/: ${err instanceof Error ? err.message : String(err)}`],
    );
  }
  const schema = validateLock(parsed);
  if (!schema.ok) {
    throw new UsageError(
      "CATALOG_LOCK_INVALID",
      `${lockPath} failed schema validation (${schema.errors.length} violation${schema.errors.length === 1 ? "" : "s"}); no command proceeds on invalid data`,
      "",
      schema.errors.map((e) => `schema ${e}`),
    );
  }
  const integrity = verifyLock(parsed as CatalogLock);
  if (!integrity.ok) {
    throw new UsageError(
      "CATALOG_LOCK_INCONSISTENT",
      `${lockPath} failed integrity checks (${integrity.errors.length} violation${integrity.errors.length === 1 ? "" : "s"})`,
      "",
      integrity.errors.map((e) => `integrity ${e}`),
    );
  }
  return parsed as CatalogLock;
}

export function lockBytesSha256(lockPath: string): string {
  return createHash("sha256").update(readFileSync(lockPath)).digest("hex");
}

export interface IndexState {
  dbPath: string;
  /** True when the existing db was reused (no rebuild happened). */
  reused: boolean;
  rows: number;
}

/** Build .rig-testlab/index.db unless the cached key matches the lock's content hash. */
export function ensureIndex(lock: CatalogLock, lockPath: string, dbPath: string, keyPath: string, deps: CliDeps): IndexState {
  const key = lockBytesSha256(lockPath);
  if (existsSync(dbPath) && existsSync(keyPath) && readFileSync(keyPath, "utf8").trim() === key) {
    return { dbPath, reused: true, rows: -1 };
  }
  const build = deps.buildIndex ?? ((l, p) => buildFtsIndex(l, p));
  const rows = build(lock, dbPath);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${key}\n`);
  return { dbPath, reused: false, rows };
}
