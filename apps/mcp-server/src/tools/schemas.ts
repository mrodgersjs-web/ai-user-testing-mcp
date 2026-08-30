/**
 * Zod v4 wire schemas shared by the tool surface.
 *
 * These mirror the frozen schemas/*.v1.schema.json contracts (ScenarioSpec,
 * ProjectManifest, RunManifest). The compiler still validates against the
 * JSON Schemas with ajv; zod here is the MCP input gate so malformed calls
 * never reach business logic.
 */
import { z } from "zod";
import type { ToolErrorEnvelope } from "../errors.js";
import { toFailureEnvelope } from "../errors.js";

/** ids accepted by the wire schemas (runId, scenarioId, suiteId, adapterId). */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const idSchema = z.string().regex(ID_PATTERN, "must match ^[a-z0-9][a-z0-9._-]*$");

export const PLATFORMS = [
  "web",
  "ios",
  "android",
  "api",
  "data",
  "ai",
  "vision",
  "accessibility",
  "security",
  "longitudinal",
] as const;

export const ARTIFACT_KINDS = [
  "screenshot",
  "video",
  "rrweb",
  "console_network_trace",
  "accessibility_tree",
  "model_transcript",
  "log",
  "json_report",
] as const;

export const RUN_STATES = [
  "queued",
  "running",
  "passed",
  "failed",
  "blocked",
  "not_evaluated",
  "cancelled",
] as const;

export const budgetSchema = z.object({
  maxScenarios: z.number().int().min(1).optional(),
  maxEstimatedCredits: z.number().min(0).optional(),
});

export const scenarioSpecSchema = z.object({
  id: idSchema,
  project: idSchema,
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  title: z.string().min(1),
  persona: z.string().min(1).optional(),
  steps: z
    .array(
      z.object({
        action: z.string().min(1),
        target: z.string().optional(),
        expected: z.string().min(1),
      }),
    )
    .min(1),
  requiredAdapters: z.array(z.string().min(1)).min(1),
  requiredEvidence: z.array(z.enum(ARTIFACT_KINDS)),
  budget: budgetSchema.optional(),
});

export const projectManifestSchema = z.object({
  id: idSchema,
  repo: z.object({
    url: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{7,64}$/),
  }),
  platforms: z.array(z.enum(PLATFORMS)).min(1),
  suites: z.array(
    z.object({
      path: z.string().min(1),
      scenarioIds: z.array(idSchema),
    }),
  ),
  requiredAdapters: z.array(idSchema),
});

/** Inline RunManifest shape accepted by `suite.run` (validated further at execution). */
export const runManifestSchema = z.object({
  runId: idSchema,
  scenarioId: idSchema,
  adapterId: idSchema,
  sandbox: z.object({
    homeDir: z.string(),
    worktree: z.string(),
    readOnlySource: z.boolean(),
    limitsApplied: z.boolean(),
  }),
  state: z.enum(RUN_STATES),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  commands: z
    .array(
      z.object({
        argv: z.array(z.string()),
        exitCode: z.number().int().nullable(),
        startedAt: z.string().optional(),
        finishedAt: z.string().optional(),
      }),
    )
    .default([]),
  networkUsed: z.array(z.string()).default([]),
  credits: z.object({ estimated: z.number(), consumed: z.number() }),
  failureDetail: z.string().nullable().optional(),
  artifacts: z.array(z.unknown()).default([]),
  redactionApplied: z.boolean(),
});

export const compiledSuiteSchema = z.object({
  manifests: z.array(runManifestSchema).min(1),
  refusals: z
    .array(z.object({ scenarioId: z.string(), reason: z.string() }))
    .default([]),
});

/** JSON-success tool result: text content + structured mirror. */
export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}

/** Structured failure tool result. */
export interface ToolFailureResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolErrorEnvelope;
  isError: true;
}

export type ToolResult = ToolTextResult | ToolFailureResult;

/** Success envelope: JSON text content + structured mirror. */
export function jsonResult(payload: Record<string, unknown>): ToolTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Failure envelope: isError + machine-readable code, never a stack. */
export function failureResult(envelope: ToolErrorEnvelope): ToolFailureResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true,
  };
}

/**
 * Handler-level guard: expected ToolFailure (and any unexpected throw) becomes
 * the structured envelope. Keeping the catch in ONE place means no tool can
 * leak a stack trace as a response.
 */
export async function guard(op: () => ToolTextResult | Promise<ToolTextResult>): Promise<ToolResult> {
  try {
    return await op();
  } catch (err) {
    return failureResult(toFailureEnvelope(err));
  }
}
