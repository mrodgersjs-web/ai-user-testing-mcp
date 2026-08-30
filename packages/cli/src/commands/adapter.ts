/**
 * `rig-testlab adapter list|health|promote`.
 *
 * list  — every adapters/<id>/adapter.json, wire-schema validated, dir-name
 *         equality checked. Any invalid descriptor ⇒ exit 1 (honest registry).
 * health — ToolChecker probe over each allowlisted command binary plus
 *         credential NAME presence (never values). Exit 0 only when every
 *         reviewed adapter's dependencies are satisfied.
 * promote — status experimental → reviewed. Refuses without --by <operator>
 *         (exit 2) and appends one audit line to .rig-testlab/audit/
 *         adapter-promote.jsonl (append-only) BEFORE reporting success.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialEnvVarName, defaultToolChecker } from "@rig-testlab/runner";
import type { Ctx } from "../context.js";
import { CommandFailure, UsageError } from "../errors.js";

import { str } from "../opts.js";
import { loadAdapters, reviewedDescriptors } from "../adapters.js";
import { appendAudit } from "../store.js";


export const ADAPTER_HELP = `rig-testlab adapter <subcommand>

  list    [--adapters-dir <dir>] [--root <dir>] [--json]
  health  [--adapters-dir <dir>] [--root <dir>] [--json]
  promote --id <adapterId> --by <operator> [--note <text>] [--adapters-dir <dir>] [--json]

promote writes an append-only audit line under .rig-testlab/audit/ and refuses
anonymous promotion (PROMOTE_OPERATOR_REQUIRED).`;

function adaptersDirOf(ctx: Ctx): string {
  const dir = str(ctx.values, "adapters-dir") ?? ctx.paths.adaptersDir;
  if (dir === undefined || dir === null) {
    throw new UsageError(
      "ROOT_NOT_FOUND",
      `${ctx.command}: no repo root (pnpm-workspace.yaml) found; pass --adapters-dir <dir> or --root <dir>`,
      ctx.help,
    );
  }
  return dir;
}

export async function adapterList(ctx: Ctx): Promise<number> {
  const registry = loadAdapters(adaptersDirOf(ctx));
  if (registry.adapters.length === 0) {
    throw new CommandFailure("ADAPTERS_DIR_EMPTY", `no adapter descriptors found under ${adaptersDirOf(ctx)}`);
  }
  for (const a of registry.adapters) {
    for (const e of a.errors) ctx.rep.line(`BAD  ${e}`);
    if (a.descriptor !== undefined) {
      const d = a.descriptor;
      ctx.rep.line(
        `${d.status.padEnd(12)} ${d.id} (${d.name} v${d.adapterVersion}) paid=${String(d.paidProvider)} creds=${d.credentialMode}`,
      );
    }
  }
  ctx.rep.line(registry.ok ? `adapters OK: ${String(registry.adapters.length)} descriptors` : `adapters BROKEN: ${String(registry.adapters.filter((a) => a.errors.length > 0).length)} invalid descriptor(s)`);
  ctx.rep.result("adapter list", {
    ok: registry.ok,
    adapters: registry.adapters.map((a) => ({ dir: a.dir, id: a.descriptor?.id ?? null, status: a.descriptor?.status ?? null, errors: a.errors })),
  });
  return registry.ok ? 0 : 1;
}

export async function adapterHealth(ctx: Ctx): Promise<number> {
  const registry = loadAdapters(adaptersDirOf(ctx));
  if (!registry.ok) {
    throw new CommandFailure(
      "ADAPTER_REGISTRY_INVALID",
      "adapter health: descriptor validation failed; run `rig-testlab adapter list` for the violating files",
      registry.adapters.flatMap((a) => a.errors),
    );
  }
  const toolChecker = ctx.deps.toolChecker ?? ((bin: string) => defaultToolChecker(bin, ctx.env));
  const report = reviewedDescriptors(registry).map((d) => {
    const binaries = [...new Set(d.commandAllowlist.map((prefix) => prefix[0] ?? "").filter((b) => b.length > 0))];
    const missingBinaries = binaries.filter((b) => !toolChecker(b));
    const credentials =
      d.credentialMode === "none"
        ? []
        : [{ name: credentialEnvVarName(d.id), present: (ctx.env[credentialEnvVarName(d.id)] ?? "").trim().length > 0 }];
    return {
      id: d.id,
      status: d.status,
      paid: d.paidProvider,
      binaries,
      missingBinaries,
      credentials, // names + presence only — values are never read or reported
      ok: missingBinaries.length === 0 && credentials.every((c) => c.present),
    };
  });
  for (const r of report) {
    const credNote = r.credentials.map((c) => `${c.name}=${c.present ? "present" : "ABSENT"}`).join(" ");
    ctx.rep.line(`${r.ok ? "ok  " : "DEP "} ${r.id} [${r.status}]${r.paid ? " paid" : ""} missing=${r.missingBinaries.join(",") || "none"}${credNote.length > 0 ? ` ${credNote}` : ""}`);
  }
  const allOk = report.every((r) => r.ok);
  ctx.rep.result("adapter health", { ok: allOk, adapters: report });
  return allOk ? 0 : 1;
}

export async function adapterPromote(ctx: Ctx): Promise<number> {
  const id = str(ctx.values, "id");
  const by = str(ctx.values, "by");
  if (id === undefined) throw new UsageError("USAGE", "adapter promote: --id <adapterId> required", ctx.help);
  if (by === undefined || by.trim().length === 0) {
    throw new UsageError("PROMOTE_OPERATOR_REQUIRED", "adapter promote refuses anonymous promotion: pass --by <operator>", ctx.help);
  }
  const dir = adaptersDirOf(ctx);
  const registry = loadAdapters(dir);
  const loaded = registry.adapters.find((a) => a.dir === id);
  if (loaded === undefined || loaded.descriptor === undefined) {
    throw new CommandFailure("ADAPTER_NOT_FOUND", `adapter promote: no valid descriptor at ${join(dir, id, "adapter.json")}`, loaded?.errors ?? []);
  }
  if (loaded.descriptor.status !== "experimental") {
    throw new CommandFailure(
      "PROMOTE_NOT_APPLICABLE",
      `adapter promote: ${id} has status "${loaded.descriptor.status}"; only experimental adapters can be promoted`,
    );
  }
  if (ctx.paths.auditDir === null) {
    throw new UsageError("ROOT_NOT_FOUND", "adapter promote: audit log lives in the repo; pass --root <dir>", ctx.help);
  }
  const file = join(dir, id, "adapter.json");
  const updated = { ...loaded.descriptor, status: "reviewed" as const };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(updated, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  const auditPath = appendAudit(ctx.paths.auditDir, "adapter-promote.jsonl", {
    at: (ctx.deps.now ?? (() => new Date()))().toISOString(),
    action: "adapter.promote",
    adapterId: id,
    from: loaded.descriptor.status,
    to: "reviewed",
    operator: by,
    ...(str(ctx.values, "note") === undefined ? {} : { note: str(ctx.values, "note") }),
  });

  ctx.rep.line(`promoted ${id}: experimental -> reviewed by ${by}`);
  ctx.rep.line(`audit: ${auditPath}`);
  ctx.rep.result("adapter promote", { id, from: "experimental", to: "reviewed", operator: by, auditPath });
  return 0;
}
