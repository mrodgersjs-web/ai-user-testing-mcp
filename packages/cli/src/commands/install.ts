/**
 * `rig-testlab install-global` — six-harness agent installer front.
 *
 * Default mode is PLAN ONLY (Installer.plan through a dryRun installer: zero
 * mutations). `--check` reports drift from install receipts. Applying is a
 * double-guarded, operator-only action: BOTH --apply and
 * --i-understand-operator-only must be passed, or APPLY_REQUIRES_OPERATOR_ACK
 * exits 2. --home overrides the install root (tests use a temp home; nothing
 * here writes a real ~ without the operator saying so).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Installer, validateInstallManifest, type InstallManifest } from "@rig-testlab/agent-installer";
import type { Ctx } from "../context.js";
import { CommandFailure, UsageError } from "../errors.js";
import { bool, str } from "../opts.js";

export const INSTALL_HELP = `rig-testlab install-global --manifest <install-manifest.json> [--home <dir>]
                   [--check] [--apply --i-understand-operator-only] [--json]

Plan-only by default. --check verifies installed receipts for drift.
--apply writes files ONLY with --i-understand-operator-only as well.`;

export async function installGlobal(ctx: Ctx): Promise<number> {
  const manifestPath = str(ctx.values, "manifest");
  if (manifestPath === undefined) {
    throw new UsageError("USAGE", "install-global: --manifest <install-manifest.json> required", ctx.help);
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new UsageError(
      "INSTALL_MANIFEST_UNREADABLE",
      `install-global: cannot read/parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      ctx.help,
    );
  }
  const validation = validateInstallManifest(manifestValue);
  if (!validation.ok) {
    throw new UsageError("INSTALL_MANIFEST_INVALID", `install-global: ${manifestPath} fails InstallManifest.v1 validation`, ctx.help, validation.errors);
  }
  const manifest = manifestValue as InstallManifest;
  const home = str(ctx.values, "home") ?? ctx.deps.home ?? homedir();
  const apply = bool(ctx.values, "apply");
  const ack = bool(ctx.values, "i-understand-operator-only");
  if (apply && !ack) {
    throw new UsageError(
      "APPLY_REQUIRES_OPERATOR_ACK",
      "install-global --apply is operator-only and needs BOTH --apply and --i-understand-operator-only. Nothing was written.",
      ctx.help,
    );
  }
  if (apply && ack && !existsSync(home)) {
    throw new CommandFailure("INSTALL_HOME_MISSING", `install-global: home ${home} does not exist; refusing to invent an install root`);
  }

  const installer = new Installer({ manifest, home, dryRun: !apply });
  if (bool(ctx.values, "check")) {
    const report = installer.check();
    for (const e of report.entries) {
      ctx.rep.line(`${e.status.padEnd(8)} [${e.harness}] ${e.path}${e.detail !== undefined ? ` (${e.detail})` : ""}`);
    }
    ctx.rep.line(report.clean ? "install-global check: clean" : "install-global check: DRIFT detected");
    ctx.rep.result("install-global", { mode: "check", clean: report.clean, entries: report.entries });
    return report.clean ? 0 : 1;
  }
  if (!apply) {
    const planned = installer.plan();
    for (const p of planned) ctx.rep.line(`${p.action.padEnd(8)} [${p.harness}] ${p.kind} ${p.path}${p.reason !== undefined ? ` (${p.reason})` : ""}`);
    ctx.rep.line(`PLAN ONLY — ${String(planned.length)} path(s). Apply with --apply --i-understand-operator-only.`);
    ctx.rep.result("install-global", { mode: "plan", planned, home });
    return 0;
  }
  const result = installer.apply();
  for (const c of result.conflicts) ctx.rep.line(`CONFLICT [${c.harness}] ${c.path}: ${c.reason ?? "pre-existing foreign file"}`);
  ctx.rep.line(`applied: ${String(result.receipts.length)} receipt(s), ${String(result.backupManifestPaths.length)} backup manifest(s)`);
  ctx.rep.result("install-global", { mode: "apply", receipts: result.receipts, conflicts: result.conflicts, backups: result.backupManifestPaths });
  return result.conflicts.length === 0 ? 0 : 1;
}
