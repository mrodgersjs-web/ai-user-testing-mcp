/**
 * Source tools: the confirmation-gated hydrate guide and the containment-
 * enforced file reader over hydrated submodule checkouts.
 *
 * Two hard invariants:
 *  1. The server NEVER runs git. `source.hydrate` refuses without
 *     `confirm:true` while a pin is pending, and even then only returns the
 *     exact operator command — the confirmation gate exists so no clone
 *     happens without a human deciding to spend the disk.
 *  2. `source.read` may touch nothing outside its submodule root. Percent
 *     escapes are decoded before checking; `..`, absolute paths, and symlink
 *     escapes are refused BEFORE any file read; the final read happens on the
 *     realpath-resolved target re-checked against the realpath'd root.
 */
import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SourcePin } from "@rig-testlab/catalog";
import type { LabContext } from "../context.js";
import { ToolFailure } from "../errors.js";
import { guard, jsonResult } from "./schemas.js";

const MAX_SOURCE_FILE_BYTES = 1024 * 1024;

/** Decode repeated percent-encoding; malformed escapes are INVALID_INPUT. */
function percentDecode(path: string): string {
  let decoded = path;
  for (let round = 0; round < 3; round++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new ToolFailure("INVALID_INPUT", `path has malformed percent-encoding: ${JSON.stringify(path)}`);
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function pinDescription(pin: SourcePin): string {
  return `${pin.submodulePath} @ ${pin.commitSha.slice(0, 12)} (~${pin.reportedSizeKb} KB, GitHub-reported)`;
}

/** Contain `requested` inside `rootReal`; returns the safe absolute target. */
function containWithin(rootReal: string, requested: string): string {
  const decoded = percentDecode(requested);
  if (decoded.length === 0 || decoded.includes("\0")) {
    throw new ToolFailure("INVALID_INPUT", "path must be a non-empty relative path");
  }
  if (isAbsolute(decoded) || decoded.startsWith("~")) {
    throw new ToolFailure("PATH_TRAVERSAL", `absolute paths are not allowed: ${JSON.stringify(decoded)}`);
  }
  // Backslashes are path separators on Windows-shaped attempts and opaque
  // bytes on POSIX source trees; either way a catalog checkout never needs one.
  const segments = decoded.split(/[\\/]/);
  if (decoded.includes("\\") || segments.includes("..")) {
    throw new ToolFailure("PATH_TRAVERSAL", `path traversal is not allowed: ${JSON.stringify(decoded)}`);
  }
  const candidate = resolve(rootReal, decoded);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    throw new ToolFailure("PATH_TRAVERSAL", `path escapes the submodule root: ${JSON.stringify(decoded)}`);
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(candidate);
  } catch {
    throw new ToolFailure("FILE_NOT_FOUND", `no file at ${JSON.stringify(decoded)} in the hydrated source`);
  }
  if (realTarget !== rootReal && !realTarget.startsWith(rootReal + sep)) {
    throw new ToolFailure("PATH_TRAVERSAL", `symlink escapes the submodule root: ${JSON.stringify(decoded)}`);
  }
  return realTarget;
}

export function registerSourceTools(server: McpServer, ctx: LabContext): void {
  server.registerTool(
    "source.hydrate",
    {
      title: "Hydrate source pin (operator command)",
      description:
        "Report how to hydrate an entry's submodule checkout. The MCP server NEVER runs git itself. Pending pins require confirm:true; the response is always the exact operator command plus the disk estimate.",
      inputSchema: z.object({
        id: z.string().min(1),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ id, confirm }) =>
      guard(() => {
        const entry = ctx.entry(id);
        if (entry === undefined) {
          throw new ToolFailure("ENTRY_NOT_FOUND", `no catalog entry with id '${id}'`);
        }
        const pin = ctx.pinFor(id);
        if (pin === undefined || pin.pinState === "skipped_nonrepo") {
          throw new ToolFailure(
            "NO_SOURCE_PIN",
            `entry '${id}' has no gitlink pin to hydrate (${pin === undefined ? "no pin" : "non-repo target"}); its content is metadata-only`,
          );
        }
        const command = ctx.hydrateCommand(pin);
        if (pin.pinState === "pending" && !confirm) {
          throw new ToolFailure(
            "CONFIRMATION_REQUIRED",
            `pin for '${id}' is pending. Hydration clones the gitlink ${pinDescription(pin)} into ${pin.submodulePath} at commit ${pin.commitSha}. This consumes disk and network; the server will not run git. Re-invoke with confirm:true to receive the operator command: git submodule update --init -- ${pin.submodulePath}`,
          );
        }
        const checkoutExists = existsSync(resolve(ctx.sourcesRoot, pin.submodulePath));
        const status =
          pin.pinState === "pinned" && checkoutExists
            ? "hydrated"
            : pin.pinState === "failed"
              ? "pin_failed"
              : "not_hydrated";
        return jsonResult({
          entryId: id,
          pinState: pin.pinState,
          status,
          executed: false,
          command,
          runFrom: ctx.repoRoot,
          submodulePath: pin.submodulePath,
          estimatedSizeKb: pin.reportedSizeKb,
          lastHydratedAt: pin.lastHydratedAt ?? null,
          note: "The MCP server never invokes git; run the command above yourself.",
        });
      }),
  );

  server.registerTool(
    "source.read",
    {
      title: "Read file from hydrated source",
      description:
        "Read a text file (≤1 MiB) from a hydrated submodule checkout at sources/**/{owner}--{repo}. Rejects traversal and symlink escapes; unhydrated sources return an actionable SOURCE_NOT_HYDRATED error, never a fake success.",
      inputSchema: z.object({
        id: z.string().min(1),
        path: z.string().min(1),
      }),
    },
    async ({ id, path }) =>
      guard(() => {
        const entry = ctx.entry(id);
        if (entry === undefined) {
          throw new ToolFailure("ENTRY_NOT_FOUND", `no catalog entry with id '${id}'`);
        }
        const pin = ctx.pinFor(id);
        if (pin === undefined || pin.pinState === "skipped_nonrepo") {
          throw new ToolFailure("NO_SOURCE_PIN", `entry '${id}' has no submodule checkout to read from`);
        }
        let rootReal: string;
        try {
          rootReal = realpathSync(resolve(ctx.sourcesRoot, pin.submodulePath));
        } catch {
          throw new ToolFailure(
            "SOURCE_NOT_HYDRATED",
            `source '${id}' is not hydrated at ${pin.submodulePath}; run \`${ctx.hydrateCommand(pin)}\` from ${ctx.repoRoot} (see source.hydrate)`,
          );
        }
        const target = containWithin(rootReal, path);
        const stat = statSync(target);
        if (!stat.isFile()) {
          throw new ToolFailure("INVALID_INPUT", `${JSON.stringify(path)} is not a regular file`);
        }
        if (stat.size > MAX_SOURCE_FILE_BYTES) {
          throw new ToolFailure(
            "FILE_TOO_LARGE",
            `${JSON.stringify(path)} is ${stat.size} bytes; limit is ${MAX_SOURCE_FILE_BYTES}`,
          );
        }
        // Read the realpath'd target so a swapped symlink cannot re-open a race.
        const content = readFileSync(target, "utf8");
        return jsonResult({ id, path, sizeBytes: stat.size, content });
      }),
  );
}
