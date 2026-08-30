/**
 * Run-observation tools.
 *
 * `run.wait` polls the persisted RunManifest store; a run that is executing in
 * this process reports `running` from the live registry (never a fabricated
 * state), and a timeout returns the last-known state honestly with
 * `terminal:false`. `evidence.verify` re-checks every sealed receipt against
 * the evidence store — a manifest claiming `passed` with unverifiable
 * artifacts is flagged, not laundered.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { verifyReceipt } from "@rig-testlab/evidence";
import { TERMINAL_STATES } from "@rig-testlab/runner";
import type { ArtifactReceipt } from "@rig-testlab/catalog";
import type { LabContext } from "../context.js";
import { ToolFailure } from "../errors.js";
import { guard, idSchema, jsonResult } from "./schemas.js";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export function registerRunTools(server: McpServer, ctx: LabContext): void {
  server.registerTool(
    "run.wait",
    {
      title: "Wait for a run to settle",
      description:
        "Poll the run store until the RunManifest reaches a terminal state (passed/failed/blocked/not_evaluated/cancelled) or the timeout elapses. Timeout returns the current state with terminal:false — never a fake completion.",
      inputSchema: z.object({
        runId: idSchema,
        timeoutMs: z.number().int().min(0).max(120_000).default(10_000),
        pollMs: z.number().int().min(5).max(1000).default(50),
      }),
    },
    async ({ runId, timeoutMs, pollMs }) =>
      guard(async () => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const manifest = ctx.readRun(runId);
          if (manifest === undefined && !ctx.isRunning(runId)) {
            throw new ToolFailure("RUN_NOT_FOUND", `no run '${runId}' in ${ctx.runPath(runId)}`);
          }
          if (manifest !== undefined && TERMINAL_STATES.includes(manifest.state)) {
            return jsonResult({ runId, terminal: true, manifest });
          }
          const state = ctx.isRunning(runId) && manifest?.state === "queued" ? "running" : manifest?.state ?? "queued";
          if (Date.now() >= deadline) {
            return jsonResult({
              runId,
              terminal: false,
              timedOut: true,
              state,
              manifest: manifest ?? { runId, state },
            });
          }
          await sleep(pollMs);
        }
      }),
  );

  server.registerTool(
    "evidence.verify",
    {
      title: "Verify run evidence receipts",
      description:
        "Independently re-check every ArtifactReceipt of a run against the evidence store (shape, containment, existence, sha256, size, redaction-flag consistency). A manifest in state 'passed' whose evidence does not verify is reported as failed verification — never laundered.",
      inputSchema: z.object({ runId: idSchema }),
    },
    async ({ runId }) =>
      guard(() => {
        const manifest = ctx.readRun(runId);
        if (manifest === undefined) {
          throw new ToolFailure("RUN_NOT_FOUND", `no run '${runId}' in ${ctx.runPath(runId)}`);
        }
        const receipts = (manifest.artifacts as ArtifactReceipt[]).map((receipt) => ({
          id: receipt.id,
          kind: receipt.kind,
          path: receipt.path,
          ok: verifyReceipt(receipt, ctx.evidenceRoot),
        }));
        const allVerified = receipts.length > 0 && receipts.every((r) => r.ok);
        return jsonResult({
          runId,
          state: manifest.state,
          evidenceRoot: ctx.evidenceRoot,
          receipts,
          verifiedCount: receipts.filter((r) => r.ok).length,
          total: receipts.length,
          allVerified,
          passedClaimSupported: manifest.state !== "passed" ? null : allVerified,
        });
      }),
  );
}
