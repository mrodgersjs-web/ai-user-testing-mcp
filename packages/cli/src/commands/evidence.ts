/**
 * `rig-testlab evidence verify|report`.
 *
 * verify — every ArtifactReceipt of every watched run re-checked independently
 *          against the store (shape, containment, hash, size, redaction-kind
 *          consistency) via @rig-testlab/evidence. Any failure exits 1.
 * report — markdown table over the run store. The passed aggregate counts
 *          ONLY state === 'passed' (summarizeRuns); blocked, not_evaluated,
 *          cancelled, running, queued, failed rows are listed explicitly and
 *          their honest counts are printed next to it. A report can never
 *          render a non-passing state as passed.
 */
import { writeFileSync } from "node:fs";
import { summarizeRuns } from "@rig-testlab/scenario-compiler";
import { validateArtifactReceiptShape, verifyReceipt } from "@rig-testlab/evidence";
import type { RunManifest } from "@rig-testlab/catalog";
import type { Ctx } from "../context.js";
import { CommandFailure, UsageError } from "../errors.js";

import { bool, str, strs } from "../opts.js";
import { listRunIds, readManifest } from "../store.js";

export const EVIDENCE_HELP = `rig-testlab evidence <subcommand>

  verify  (--all | --run <runId> ...) [--store <dir>] [--json]
          Re-hash every artifact against its receipt. Exit 0 only if all verify.
  report  [--all | --run <runId> ...] [--store <dir>] [--out <file>] [--json]
          Markdown run table; 'passed' counts ONLY state === 'passed'.`;

function watchedManifests(ctx: Ctx): { storeRoot: string; runs: Array<{ id: string; manifest: RunManifest }> ; unreadable: string[] } {
  const storeRoot = str(ctx.values, "store") ?? ctx.paths.storeRoot;
  if (storeRoot === undefined || storeRoot === null) {
    throw new UsageError("ROOT_NOT_FOUND", `${ctx.command}: pass --store <dir> or --root <dir>`, ctx.help);
  }
  const ids = strs(ctx.values, "run");
  const watchAll = ids.length === 0 || bool(ctx.values, "all");
  const wanted = watchAll ? listRunIds(storeRoot) : ids;
  const runs: Array<{ id: string; manifest: RunManifest }> = [];
  const unreadable: string[] = [];
  for (const id of wanted) {
    const read = readManifest(storeRoot, id);
    if (read.ok) runs.push({ id, manifest: read.manifest });
    else unreadable.push(read.reason);
  }
  if (runs.length === 0) {
    throw new CommandFailure(
      "EVIDENCE_NOT_FOUND",
      `evidence ${ctx.command.split(" ")[1] ?? ""}: no readable run manifests in ${storeRoot}${unreadable.length > 0 ? ` (${unreadable.join("; ")})` : ""}`,
      unreadable,
    );
  }
  return { storeRoot, runs, unreadable };
}

export async function evidenceVerify(ctx: Ctx): Promise<number> {
  const { storeRoot, runs, unreadable } = watchedManifests(ctx);
  const failures: string[] = [...unreadable];
  let checked = 0;
  for (const { id, manifest } of runs) {
    if (manifest.runId !== id) failures.push(`${id}: manifest runId mismatch (${manifest.runId})`);
    for (const receipt of manifest.artifacts) {
      checked++;
      const shapeErrors = validateArtifactReceiptShape(receipt);
      if (shapeErrors.length > 0) {
        failures.push(`${id}/${receipt.id}: invalid receipt shape: ${shapeErrors.join("; ")}`);
        continue;
      }
      if (!verifyReceipt(receipt, storeRoot)) failures.push(`${id}/${receipt.id}: receipt does NOT verify against store (${receipt.kind} ${receipt.path})`);
      else ctx.rep.line(`ok       ${id}/${receipt.id} ${receipt.kind}`);
    }
    if (manifest.artifacts.length === 0) ctx.rep.line(`no-art   ${id} (${manifest.state})`);
  }
  for (const f of failures) ctx.rep.line(`TAMPERED ${f}`);
  ctx.rep.result("evidence verify", { ok: failures.length === 0, receiptsChecked: checked, runs: runs.length, failures });
  return failures.length === 0 ? 0 : 1;
}

function stateEmoji(state: RunManifest["state"]): string {
  const LABEL: Record<RunManifest["state"], string> = {
    passed: "PASSED",
    failed: "FAILED",
    blocked: "BLOCKED",
    not_evaluated: "NOT_EVALUATED",
    cancelled: "CANCELLED",
    running: "RUNNING",
    queued: "QUEUED",
  };
  return LABEL[state];
}

export async function evidenceReport(ctx: Ctx): Promise<number> {
  const { runs } = watchedManifests(ctx);
  const sorted = [...runs].sort((a, b) => a.id.localeCompare(b.id));
  const summary = summarizeRuns(sorted.map((r) => r.manifest));
  const lines: string[] = [
    "# rig-testlab evidence report",
    "",
    "| run | scenario | adapter | state | failureDetail | artifacts | credits (est/consumed) |",
    "| --- | -------- | ------- | ----- | ------------- | --------- | ---------------------- |",
  ];
  for (const { id, manifest } of sorted) {
    lines.push(
      `| ${id} | ${manifest.scenarioId} | ${manifest.adapterId} | ${stateEmoji(manifest.state)} | ${manifest.failureDetail ?? ""} | ${String(manifest.artifacts.length)} | ${String(manifest.credits.estimated)}/${String(manifest.credits.consumed)} |`,
    );
  }
  lines.push(
    "",
    "## Summary (passed counts ONLY state === 'passed')",
    "",
    `- passed: ${String(summary.passed)}`,
    `- failed: ${String(summary.failed)}`,
    `- blocked: ${String(summary.blocked)}`,
    `- not_evaluated: ${String(summary.notEvaluated)}`,
    `- cancelled: ${String(summary.cancelled)}`,
    `- running: ${String(summary.running)}`,
    `- queued: ${String(summary.queued)}`,
  );
  const nonPassing = sorted.filter((r) => r.manifest.state !== "passed" && r.manifest.state !== "failed");
  if (nonPassing.length > 0) {
    lines.push("", "## Non-passing, explicitly", "");
    for (const r of nonPassing) {
      lines.push(`- ${r.id}: ${stateEmoji(r.manifest.state)}${r.manifest.failureDetail !== null && r.manifest.failureDetail !== undefined ? ` — ${r.manifest.failureDetail}` : ""}`);
    }
  }
  const markdown = `${lines.join("\n")}\n`;
  const out = str(ctx.values, "out");
  if (out !== undefined) writeFileSync(out, markdown);
  else ctx.rep.line(markdown.trimEnd());
  ctx.rep.result("evidence report", { markdown, summary, runs: sorted.length });
  return 0;
}
