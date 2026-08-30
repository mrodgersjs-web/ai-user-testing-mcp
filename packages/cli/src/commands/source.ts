/**
 * `rig-testlab source status|hydrate`.
 *
 * Hydration is the ONLY git-writing command and is triple-guarded:
 *   1. dry-run by default — the estimate (count, reported sizes, free disk via
 *      `df -k`) is printed and ZERO git calls happen unless --confirm is passed;
 *   2. projected usage > 80% of free disk ⇒ DISK_HEADROOM refusal;
 *   3. only pinState 'pinned' sources are hydratable; pending/failed pins are
 *      reported with named skip reasons, never silently skipped.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeLock, type CatalogLock, type SourcePin } from "@rig-testlab/catalog";
import { defaultRunCommand } from "../deps.js";
import type { Ctx } from "../context.js";
import { CommandFailure, UsageError } from "../errors.js";
import { loadLockFailClosed } from "../guards.js";
import { bool, strs } from "../opts.js";
import { catalogLockPath } from "./catalog.js";

export const SOURCE_HELP = `rig-testlab source <subcommand>

  status  [--lock <file>] [--fixture <lock>] [--root <dir>] [--json]
          Pin states from the lock vs on-disk hydration (submodule dirs).
  hydrate (--id <entryId> ... | --all) [--confirm] [--lock <file>] [--root <dir>] [--json]
          Dry-run prints the size/disk estimate. Git runs ONLY with --confirm.
          Refuses when projected usage exceeds 80% of free disk (DISK_HEADROOM).`;

function hydratedOnDisk(root: string, pin: SourcePin): boolean {
  const dir = join(root, pin.submodulePath);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function requireRoot(ctx: Ctx): string {
  if (ctx.paths.root === null) {
    throw new UsageError(
      "ROOT_NOT_FOUND",
      `${ctx.command}: no repo root (pnpm-workspace.yaml) found; pass --root <dir>`,
      ctx.help,
    );
  }
  return ctx.paths.root;
}

export async function sourceStatus(ctx: Ctx): Promise<number> {
  const lock = loadLockFailClosed(catalogLockPath(ctx));
  const root = requireRoot(ctx);
  const rows = lock.pins.map((pin) => ({
    entryId: pin.entryId,
    pinState: pin.pinState,
    submodulePath: pin.submodulePath,
    reportedSizeKb: pin.reportedSizeKb,
    hydrated: pin.pinState === "pinned" ? hydratedOnDisk(root, pin) : false,
    lastHydratedAt: pin.lastHydratedAt ?? null,
  }));
  const byState: Record<string, number> = {};
  for (const r of rows) byState[r.pinState] = (byState[r.pinState] ?? 0) + 1;
  ctx.rep.line(
    `source status: ${String(rows.length)} pins (${Object.entries(byState)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ")})`,
  );
  for (const r of rows) {
    ctx.rep.line(
      `  ${r.hydrated ? "hydrated" : "HOLLOW  "} ${r.entryId} [${r.pinState}] ${r.submodulePath} ~${String(r.reportedSizeKb)}KB`,
    );
  }
  ctx.rep.result("source status", { pins: rows, byState });
  return 0;
}

interface HydratePlan {
  lock: CatalogLock;
  lockPath: string;
  selected: SourcePin[];
  skipped: Array<{ entryId: string; pinState: string; reason: string }>;
  projectedKb: number;
}

function buildPlan(ctx: Ctx, ids: string[], all: boolean): HydratePlan {
  const lockPath = catalogLockPath(ctx);
  const lock = loadLockFailClosed(lockPath);
  const want = new Set(ids);
  const selected: SourcePin[] = [];
  const skipped: HydratePlan["skipped"] = [];
  for (const pin of lock.pins) {
    const targeted = all || want.has(pin.entryId);
    if (!targeted) continue;
    if (pin.pinState !== "pinned") {
      skipped.push({
        entryId: pin.entryId,
        pinState: pin.pinState,
        reason:
          pin.pinState === "pending"
            ? "gitlink not committed yet"
            : `pinState=${pin.pinState} is not hydratable`,
      });
      continue;
    }
    selected.push(pin);
  }
  for (const id of want) {
    if (!selected.some((p) => p.entryId === id) && !skipped.some((s) => s.entryId === id)) {
      skipped.push({ entryId: id, pinState: "none", reason: "ENTRY_NOT_PINNED: no pin for this id in the lock" });
    }
  }
  return { lock, lockPath, selected, skipped, projectedKb: selected.reduce((n, p) => n + p.reportedSizeKb, 0) };
}

/** Free 1KiB blocks on the filesystem holding root, from `df -k`. */
async function freeKb(ctx: Ctx, root: string): Promise<number> {
  const run = ctx.deps.runCommand ?? defaultRunCommand;
  const res = await run(["df", "-k", root], { cwd: root });
  if (res.code !== 0) {
    throw new CommandFailure("DISK_PROBE_FAILED", `source hydrate: \`df -k\` failed (exit ${String(res.code)}): ${res.stderr.trim() || "no stderr"}`);
  }
  const lines = res.stdout.trim().split("\n");
  if (lines.length < 2) throw new CommandFailure("DISK_PROBE_FAILED", "source hydrate: unparseable `df -k` output");
  const header = (lines[0] ?? "").split(/\s+/);
  const availIdx = header.findIndex((h) => h.toLowerCase().includes("avail"));
  const cols = (lines[lines.length - 1] ?? "").split(/\s+/);
  const avail = Number(cols[availIdx === -1 ? 3 : availIdx]);
  if (!Number.isFinite(avail) || avail < 0) {
    throw new CommandFailure("DISK_PROBE_FAILED", "source hydrate: could not read the Available column from `df -k`");
  }
  return avail;
}

export async function sourceHydrate(ctx: Ctx): Promise<number> {
  const ids = strs(ctx.values, "id");
  const all = bool(ctx.values, "all");
  if (ids.length === 0 && !all) {
    throw new UsageError("USAGE", "source hydrate: pass --id <entryId> (repeatable) or --all", ctx.help);
  }
  const root = requireRoot(ctx);
  const plan = buildPlan(ctx, ids, all);
  const free = await freeKb(ctx, root);
  const confirm = bool(ctx.values, "confirm");

  ctx.rep.line(
    `hydrate estimate: ${String(plan.selected.length)} source(s), ${String(plan.projectedKb)} KB reported (git-reported sizes; clones may differ)`,
  );
  ctx.rep.line(`free disk: ${String(free)} KB (df -k)`);
  for (const p of plan.selected) {
    ctx.rep.line(`  plan  ${p.entryId} -> ${p.submodulePath} @${p.commitSha.slice(0, 12)} ~${String(p.reportedSizeKb)}KB`);
  }
  for (const s of plan.skipped) ctx.rep.line(`  skip  ${s.entryId} [${s.pinState}]: ${s.reason}`);

  if (plan.projectedKb > free * 0.8) {
    ctx.rep.line("REFUSED: projected usage exceeds 80% of free disk.");
    // Honest refusal state, not a validation error: exit 1.
    throw new CommandFailure(
      "DISK_HEADROOM",
      `source hydrate refused: projected ${String(plan.projectedKb)} KB exceeds 80% of ${String(free)} KB free disk`,
    );
  }
  if (!confirm) {
    ctx.rep.line("DRY RUN — no git commands executed. Re-run with --confirm to hydrate.");
    ctx.rep.result("source hydrate", {
      dryRun: true,
      gitCalls: 0,
      projectedKb: plan.projectedKb,
      freeKb: free,
      selected: plan.selected.map((p) => p.entryId),
      skipped: plan.skipped,
    });
    return 0;
  }
  if (plan.selected.length === 0) {
    throw new CommandFailure("NOTHING_TO_HYDRATE", "source hydrate: no hydratable (pinned) sources selected");
  }

  const run = ctx.deps.runCommand ?? defaultRunCommand;
  const failed: string[] = [];
  const done: string[] = [];
  for (const pin of plan.selected) {
    const init = await run(["git", "submodule", "update", "--init", "--depth", "1", pin.submodulePath], { cwd: root });
    if (init.code !== 0) {
      failed.push(`${pin.entryId}: submodule update failed (exit ${String(init.code)}): ${init.stderr.trim() || "no stderr"}`);
      continue;
    }
    const checkout = await run(["git", "-C", pin.submodulePath, "checkout", "--detach", pin.commitSha], { cwd: root });
    if (checkout.code !== 0) {
      failed.push(`${pin.entryId}: checkout ${pin.commitSha} failed (exit ${String(checkout.code)}): ${checkout.stderr.trim() || "no stderr"}`);
      continue;
    }
    pin.lastHydratedAt = (ctx.deps.now ?? (() => new Date()))().toISOString();
    done.push(pin.entryId);
    ctx.rep.line(`  done  ${pin.entryId}`);
  }
  if (done.length > 0) writeLock(plan.lock, plan.lockPath);
  ctx.rep.result("source hydrate", { dryRun: false, hydrated: done, failed, projectedKb: plan.projectedKb });
  if (failed.length > 0) {
    throw new CommandFailure("HYDRATION_INCOMPLETE", `source hydrate: ${String(failed.length)} of ${String(plan.selected.length)} failed`, failed);
  }
  return 0;
}
