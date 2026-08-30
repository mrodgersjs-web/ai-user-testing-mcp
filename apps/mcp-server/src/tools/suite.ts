/**
 * Suite tools: compile scenarios into queued RunManifests, then execute them
 * through the sandboxed runner.
 *
 * Execution invariants:
 *  - only reviewed adapters reach executeRun (compile refuses the rest;
 *    preflight re-checks fail-closed anyway);
 *  - a paid adapter is NEVER invoked without an explicit `budget` on this
 *    call — the manifest lands in `blocked/budget_required:<id>`, which is a
 *    distinct terminal state, not a failure pretending to be neutral and
 *    never a pass;
 *  - every manifest is persisted (queued → terminal) under
 *    <storeRoot>/runs/<runId>.json before `run.wait` can observe it.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { executeRun } from "@rig-testlab/runner";
import { CompileError, compileSuite, summarizeRuns } from "@rig-testlab/scenario-compiler";
import type { AdapterDescriptor, RunManifest, ScenarioSpec } from "@rig-testlab/catalog";
import type { LabContext } from "../context.js";
import { ToolFailure } from "../errors.js";
import {
  budgetSchema,
  compiledSuiteSchema,
  guard,
  idSchema,
  jsonResult,
  projectManifestSchema,
  scenarioSpecSchema,
} from "./schemas.js";

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

export function registerSuiteTools(server: McpServer, ctx: LabContext): void {
  server.registerTool(
    "suite.compile",
    {
      title: "Compile scenario suite",
      description:
        "Compile a project manifest + scenarios + on-disk adapters into queued RunManifests (persisted to the suite store). Governance refusals (unknown_adapter / adapter_not_reviewed / budget_required / no_compatible_adapter) come back as structured data, never hidden. Malformed input returns COMPILE_FAILED with the first violating JSON pointer.",
      inputSchema: z.object({
        suiteId: idSchema.optional(),
        project: projectManifestSchema.optional(),
        manifest: projectManifestSchema.optional(),
        scenarios: z.array(scenarioSpecSchema).min(1),
        creditEstimates: z.record(z.string(), z.number().min(0)).optional(),
      }),
    },
    async ({ suiteId, project, manifest, scenarios, creditEstimates }) =>
      guard(() => {
        const projectManifest = project ?? manifest;
        if (projectManifest === undefined || (project !== undefined && manifest !== undefined)) {
          throw new ToolFailure("INVALID_INPUT", "provide exactly one of project or manifest");
        }
        const loaded = ctx.loadAdapterFiles();
        let result;
        try {
          result = compileSuite({
            projectManifest,
            scenarios: scenarios as ScenarioSpec[],
            adapters: loaded.loads.flatMap((l) => (l.descriptor ? [l.descriptor] : [])),
            adapterCreditEstimates: creditEstimates ?? {},
          });
        } catch (err) {
          // First violating JSON pointer travels with the error code.
          if (err instanceof CompileError) {
            throw new ToolFailure("COMPILE_FAILED", err.message, err.pointer);
          }
          throw err;
        }
        const id = suiteId ?? projectManifest.id;
        ctx.saveSuite({
          schemaVersion: 1,
          suiteId: id,
          compiledAt: ctx.nowIso(),
          project: projectManifest,
          manifests: result.manifests,
          refusals: result.refusals,
        });
        return jsonResult({
          suiteId: id,
          manifests: result.manifests,
          refusals: result.refusals,
          states: summarizeRuns(result.manifests),
          invalidAdapterFiles: loaded.loads.flatMap((l) => (l.reason ? [{ file: l.file, reason: l.reason }] : [])),
        });
      }),
  );

  server.registerTool(
    "suite.run",
    {
      title: "Run a compiled suite",
      description:
        "Execute queued RunManifests (stored suiteId or inline compiledSuite) through the sandboxed runner. Optional scenarioId filter; optional budget caps scenarios and unlocks paid adapters — paid adapters are refused (blocked, budget_required) without an explicit budget. Returns terminal manifests; completion is also observable via run.wait.",
      inputSchema: z.object({
        suiteId: idSchema.optional(),
        compiledSuite: compiledSuiteSchema.optional(),
        scenarioId: idSchema.optional(),
        budget: budgetSchema.optional(),
      }),
    },
    async ({ suiteId, compiledSuite, scenarioId, budget }) =>
      guard(async () => {
        if ((suiteId === undefined) === (compiledSuite === undefined)) {
          throw new ToolFailure("INVALID_INPUT", "provide exactly one of suiteId or compiledSuite");
        }
        const manifests: RunManifest[] =
          compiledSuite !== undefined
            ? (compiledSuite.manifests as RunManifest[])
            : ctx.readSuite(suiteId as string).manifests;

        const scoped = scenarioId === undefined ? manifests : manifests.filter((m) => m.scenarioId === scenarioId);
        if (scoped.length === 0) {
          throw new ToolFailure(
            "SCENARIO_NOT_FOUND",
            scenarioId === undefined
              ? "suite has no manifests"
              : `suite contains no manifest for scenario '${scenarioId}'`,
          );
        }

        const adaptersById = byId<AdapterDescriptor>(ctx.adapters());
        const queued = scoped.filter((m) => m.state === "queued");
        const notQueued = scoped.filter((m) => m.state !== "queued");
        const cap = budget?.maxScenarios ?? queued.length;
        const toRun = queued.slice(0, cap);
        const overCap = queued.slice(cap);

        const results: RunManifest[] = [];
        for (const manifest of toRun) {
          const adapter = adaptersById.get(manifest.adapterId);
          const finishedAt = ctx.nowIso();
          if (adapter === undefined) {
            const blocked: RunManifest = {
              ...structuredClone(manifest),
              state: "blocked",
              finishedAt,
              failureDetail: `adapter_missing:${manifest.adapterId}`,
            };
            ctx.saveRun(blocked);
            results.push(blocked);
            continue;
          }
          if (adapter.paidProvider && budget?.maxEstimatedCredits === undefined) {
            const blocked: RunManifest = {
              ...structuredClone(manifest),
              state: "blocked",
              finishedAt,
              failureDetail: `budget_required:${adapter.id}`,
            };
            ctx.saveRun(blocked);
            results.push(blocked);
            continue;
          }
          const commandPrefix = adapter.commandAllowlist[0];
          if (commandPrefix === undefined || commandPrefix.length === 0) {
            const blocked: RunManifest = {
              ...structuredClone(manifest),
              state: "blocked",
              finishedAt,
              failureDetail: "no_command_prefix",
            };
            ctx.saveRun(blocked);
            results.push(blocked);
            continue;
          }

          ctx.saveRun(manifest); // queued lands on disk before execution
          const controller = ctx.beginRun(manifest.runId);
          try {
            const terminal = await executeRun(manifest, adapter, {
              argv: [...commandPrefix, "--scenario", manifest.scenarioId, "--run-id", manifest.runId],
              baseDir: ctx.sandboxRoot,
              storeRoot: ctx.evidenceRoot,
              spawner: ctx.spawner,
              credentialResolver: ctx.credentialResolver,
              toolChecker: ctx.toolChecker,
              scenarioMaxCredits: budget?.maxEstimatedCredits,
              signal: controller.signal,
            });
            ctx.saveRun(terminal);
            results.push(terminal);
          } finally {
            ctx.endRun(manifest.runId);
          }
        }

        const skipped = [
          ...notQueued.map((m) => ({ runId: m.runId, scenarioId: m.scenarioId, state: m.state, reason: "not_queued" })),
          ...overCap.map((m) => ({
            runId: m.runId,
            scenarioId: m.scenarioId,
            state: m.state,
            reason: "scenario_budget_exhausted",
          })),
        ];
        return jsonResult({
          runIds: results.map((r) => r.runId),
          results,
          skipped,
          summary: summarizeRuns([...results, ...skipped.map((s) => ({ state: s.state as RunManifest["state"] }))]),
        });
      }),
  );
}
