/**
 * Selection and health tools.
 *
 * `runner.select` runs the frozen selectRunner ranking over an inline scenario
 * spec or one stored by the CLI at <storeRoot>/scenarios/<id>.json.
 * `adapter.health` reports descriptor load failures and missing binaries via
 * the injected ToolChecker — credentials are probed BY NAME only.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { credentialEnvVarName } from "@rig-testlab/runner";
import { selectRunner } from "@rig-testlab/scenario-compiler";
import type { ScenarioSpec } from "@rig-testlab/catalog";
import type { LabContext } from "../context.js";
import { ToolFailure } from "../errors.js";
import { guard, idSchema, jsonResult, scenarioSpecSchema } from "./schemas.js";

export function registerExecutionTools(server: McpServer, ctx: LabContext): void {
  server.registerTool(
    "runner.select",
    {
      title: "Select execution adapter",
      description:
        "Run adapter selection for a scenario (inline spec OR stored scenarioId). Reviewed-only, platform/evidence compatible, ranked by adoption tier. Returns {selected, reason}; reason=no_compatible_adapter is a valid honest answer, not an error.",
      inputSchema: z.object({
        scenarioId: idSchema.optional(),
        spec: scenarioSpecSchema.optional(),
      }),
    },
    async ({ scenarioId, spec }) =>
      guard(() => {
        let scenario: ScenarioSpec;
        if (spec !== undefined && scenarioId !== undefined) {
          throw new ToolFailure("INVALID_INPUT", "provide exactly one of scenarioId or spec");
        }
        if (spec !== undefined) {
          scenario = spec as ScenarioSpec;
        } else if (scenarioId !== undefined) {
          const stored = ctx.readScenario(scenarioId);
          const parsed = scenarioSpecSchema.safeParse(stored);
          if (!parsed.success) {
            throw new ToolFailure(
              "SCENARIO_NOT_FOUND",
              `stored scenario '${scenarioId}' does not match ScenarioSpec v1: ${parsed.error.issues[0]?.message ?? "invalid"}`,
            );
          }
          scenario = parsed.data as ScenarioSpec;
        } else {
          throw new ToolFailure("INVALID_INPUT", "provide exactly one of scenarioId or spec");
        }
        const selection = selectRunner(scenario, ctx.adapters());
        if ("reason" in selection) {
          return jsonResult({ scenarioId: scenario.id, selected: null, reason: selection.reason });
        }
        return jsonResult({
          scenarioId: scenario.id,
          selected: { id: selection.id, status: selection.status, evidenceKinds: selection.evidenceKinds },
          reason: null,
        });
      }),
  );

  server.registerTool(
    "adapter.health",
    {
      title: "Adapter descriptor + dependency health",
      description:
        "Load every AdapterDescriptor from the adapters directory, report shape failures, missing allowlist binaries (ToolChecker), and credential availability (resolved by NAME only — values are never read into the response).",
      inputSchema: z.object({}),
    },
    async () =>
      guard(() => {
        const { dirPresent, loads } = ctx.loadAdapterFiles();
        const adapters = loads.flatMap((load) => {
          if (load.descriptor === undefined) return [];
          const binaries = [...new Set(load.descriptor.commandAllowlist.map((prefix) => prefix[0] as string))];
          return [
            {
              file: load.file,
              id: load.descriptor.id,
              status: load.descriptor.status,
              paidProvider: load.descriptor.paidProvider,
              credentialMode: load.descriptor.credentialMode,
              binaries,
              missingBinaries: binaries.filter((bin) => !ctx.toolChecker(bin)),
              credentialPresent:
                load.descriptor.credentialMode === "none"
                  ? true
                  : ctx.credentialResolver?.(credentialEnvVarName(load.descriptor.id)) != null,
            },
          ];
        });
        return jsonResult({
          adaptersDir: ctx.adaptersDir,
          dirPresent,
          adapters,
          invalid: loads.flatMap((l) => (l.reason ? [{ file: l.file, reason: l.reason }] : [])),
        });
      }),
  );
}
