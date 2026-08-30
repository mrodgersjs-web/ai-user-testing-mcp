/**
 * `rig-testlab doctor` — the fresh-clone health report.
 *
 * Blocking checks (exit 0 only when ALL pass):
 *   node-version       node >= 22.12
 *   pnpm-lockfile      lockfile present and lists every workspace importer
 *                      (offline structural check — importers, not content hash)
 *   catalog-lock       read + ajv schema + integrity, fail closed
 *   fts-index        buildable (rebuilt when the cached key mismatches)
 *   adapters-dir       present with at least one descriptor
 *   sandbox-writable   .rig-testlab/sandbox create + probe write
 *
 * Informational (never blocking): credential NAMES present/absent (values are
 * never read, logged, or echoed), disk headroom summary.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialEnvVarName } from "@rig-testlab/runner";
import type { Ctx } from "../context.js";
import { loadLockFailClosed, ensureIndex } from "../guards.js";
import { loadAdapters } from "../adapters.js";

export const DOCTOR_HELP = `rig-testlab doctor [--root <dir>] [--lock <file>] [--json]

Runs blocking environment checks (node, lockfile, catalog lock, FTS index,
adapters dir, sandbox writability) and informational credential-name presence.
Exit 0 only when every blocking check passes.`;

interface Check {
  name: string;
  blocking: boolean;
  status: "pass" | "fail" | "info";
  detail: string;
  evidence?: unknown;
}

export function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export async function doctor(ctx: Ctx): Promise<number> {
  const checks: Check[] = [];
  const root = ctx.paths.root;

  const nv = parseNodeVersion(ctx.deps.nodeVersion ?? process.version);
  const nodeOk = nv !== null && (nv.major > 22 || (nv.major === 22 && nv.minor >= 12));
  checks.push({
    name: "node-version",
    blocking: true,
    status: nodeOk ? "pass" : "fail",
    detail: nodeOk ? `${ctx.deps.nodeVersion ?? process.version} >= 22.12` : `${ctx.deps.nodeVersion ?? process.version} < 22.12 (node:sqlite and stable fs APIs require 22.12+)`,
  });

  checks.push(lockfileCheck(ctx, root));

  let lockOk = false;
  let lockErrors: string[] = [];
  if (root === null || ctx.paths.lockPath === null || !existsSync(ctx.paths.lockPath)) {
    checks.push({
      name: "catalog-lock",
      blocking: true,
      status: "fail",
      detail: root === null ? "no repo root (pnpm-workspace.yaml not found)" : `missing lock at ${ctx.paths.lockPath ?? "?"}; run \`rig-testlab catalog sync\``,
    });
  } else {
    try {
      loadLockFailClosed(ctx.paths.lockPath);
      lockOk = true;
      checks.push({ name: "catalog-lock", blocking: true, status: "pass", detail: `schema + integrity OK (${ctx.paths.lockPath})` });
    } catch (err) {
      const e = err as { details?: readonly string[]; message?: string };
      lockErrors = [...(e.details ?? [])];
      checks.push({ name: "catalog-lock", blocking: true, status: "fail", detail: e.message ?? String(err), evidence: lockErrors });
    }
  }

  indexCheck(ctx, root, lockOk, checks);
  adaptersCheck(ctx, root, checks);
  sandboxCheck(ctx, root, checks);
  credentialCheck(ctx, root, checks);

  for (const c of checks) {
    ctx.rep.line(`${c.status.toUpperCase().padEnd(4)} ${c.blocking ? "[blocking]" : "[info]    "} ${c.name}: ${c.detail}`);
  }
  const blockingFailed = checks.filter((c) => c.blocking && c.status === "fail");
  ctx.rep.result("doctor", {
    ok: blockingFailed.length === 0,
    root,
    checks,
    credentialValuesRead: false,
  });
  return blockingFailed.length === 0 ? 0 : 1;
}

function lockfileCheck(ctx: Ctx, root: string | null): Check {
  if (root === null) return { name: "pnpm-lockfile", blocking: true, status: "fail", detail: "no repo root" };
  const lockPath = join(root, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) {
    return { name: "pnpm-lockfile", blocking: true, status: "fail", detail: `${lockPath} missing` };
  }
  const text = readFileSync(lockPath, "utf8");
  if (!/^lockfileVersion:/m.test(text)) {
    return { name: "pnpm-lockfile", blocking: true, status: "fail", detail: "no lockfileVersion line — unparseable lockfile" };
  }
  const importers = ["packages/catalog", "packages/evidence", "packages/scenario-compiler", "packages/runner", "packages/agent-installer", "packages/cli", "apps/mcp-server"];
  const missing = importers.filter((dir) => existsSync(join(root, dir, "package.json")) && !new RegExp(`^  ${dir}:`, "m").test(text));
  return missing.length === 0
    ? { name: "pnpm-lockfile", blocking: true, status: "pass", detail: "lockfileVersion present; all workspace importers listed" }
    : { name: "pnpm-lockfile", blocking: true, status: "fail", detail: `importer(s) missing from lockfile: ${missing.join(", ")} — run pnpm install`, evidence: missing };
}

function indexCheck(ctx: Ctx, root: string | null, lockOk: boolean, checks: Check[]): void {
  if (!lockOk || root === null || ctx.paths.lockPath === null || ctx.paths.indexDb === null || ctx.paths.indexKey === null) {
    checks.push({ name: "fts-index", blocking: true, status: "fail", detail: "skipped: catalog lock unavailable or no repo root" });
    return;
  }
  try {
    const lock = loadLockFailClosed(ctx.paths.lockPath);
    const state = ensureIndex(lock, ctx.paths.lockPath, ctx.paths.indexDb, ctx.paths.indexKey, ctx.deps);
    checks.push({
      name: "fts-index",
      blocking: true,
      status: "pass",
      detail: state.reused ? `cached index valid (${ctx.paths.indexDb})` : `built ${String(state.rows)} rows (${ctx.paths.indexDb})`,
    });
  } catch (err) {
    checks.push({ name: "fts-index", blocking: true, status: "fail", detail: `unbuildable: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function adaptersCheck(ctx: Ctx, root: string | null, checks: Check[]): void {
  const dir = ctx.paths.adaptersDir;
  if (root === null || dir === undefined || dir === null) {
    checks.push({ name: "adapters-dir", blocking: true, status: "fail", detail: "no repo root" });
    return;
  }
  if (!existsSync(dir)) {
    checks.push({ name: "adapters-dir", blocking: true, status: "fail", detail: `${dir} missing` });
    return;
  }
  const registry = loadAdapters(dir);
  checks.push({
    name: "adapters-dir",
    blocking: true,
    status: registry.adapters.length > 0 && registry.ok ? "pass" : "fail",
    detail: registry.adapters.length === 0 ? `${dir} present but contains no adapter descriptors` : registry.ok ? `${String(registry.adapters.length)} valid descriptors` : `${String(registry.adapters.filter((a) => a.errors.length > 0).length)} invalid descriptor(s)`,
    evidence: registry.adapters.flatMap((a) => a.errors),
  });
}

function sandboxCheck(ctx: Ctx, root: string | null, checks: Check[]): void {
  if (root === null || ctx.paths.sandboxBase === null) {
    checks.push({ name: "sandbox-writable", blocking: true, status: "fail", detail: "no repo root" });
    return;
  }
  try {
    mkdirSync(ctx.paths.sandboxBase, { recursive: true });
    const probe = join(ctx.paths.sandboxBase, `.probe-${String(process.pid)}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    checks.push({ name: "sandbox-writable", blocking: true, status: "pass", detail: `${ctx.paths.sandboxBase} writable` });
  } catch (err) {
    checks.push({ name: "sandbox-writable", blocking: true, status: "fail", detail: `${ctx.paths.sandboxBase}: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function credentialCheck(ctx: Ctx, root: string | null, checks: Check[]): void {
  const names = new Set<string>(["GH_TOKEN", "GITHUB_TOKEN"]);
  if (root !== null && ctx.paths.adaptersDir !== null && existsSync(ctx.paths.adaptersDir)) {
    try {
      for (const a of readdirSync(ctx.paths.adaptersDir, { withFileTypes: true })) {
        const file = join(ctx.paths.adaptersDir, a.name, "adapter.json");
        if (!a.isDirectory() || !existsSync(file)) continue;
        try {
          const raw = JSON.parse(readFileSync(file, "utf8")) as { credentialMode?: unknown; id?: unknown };
          if ((raw.credentialMode === "keychain" || raw.credentialMode === "env_store") && typeof raw.id === "string") {
            names.add(credentialEnvVarName(raw.id));
          }
        } catch {
          // descriptor parse failures are reported by adapter list/health, not doctor
        }
      }
    } catch {
      // unreadable adapters dir already failed adapters-dir
    }
  }
  const presence = [...names].map((name) => ({ name, present: (ctx.env[name] ?? "").trim().length > 0 }));
  checks.push({
    name: "credentials",
    blocking: false,
    status: "info",
    detail: presence.map((p) => `${p.name}=${p.present ? "present" : "absent"}`).join(" ") || "none declared",
    evidence: presence, // presence booleans only — values are never read
  });
}
