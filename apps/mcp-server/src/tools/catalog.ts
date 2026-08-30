/**
 * Catalog tools: BM25 search over the generated FTS index + exact entry lookup.
 *
 * Search reads the SQLite FTS5 index built lazily from the active lock (cached
 * by sha256 of the lock bytes); get answers from the in-memory lock maps.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LabContext } from "../context.js";
import { ToolFailure } from "../errors.js";
import { guard, jsonResult } from "./schemas.js";

export function registerCatalogTools(server: McpServer, ctx: LabContext): void {
  server.registerTool(
    "catalog.search",
    {
      title: "Search catalog",
      description:
        "BM25-ranked full-text search over the catalog lock (entries + provenance edges). Returns ranked {id,name,score} hits; lower score = better.",
      inputSchema: z.object({
        query: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(100).default(10),
      }),
    },
    async ({ query, limit }) =>
      guard(() => {
        const hits = ctx.search(query, limit);
        return jsonResult({ query, limit, hits });
      }),
  );

  server.registerTool(
    "catalog.get",
    {
      title: "Get catalog entry",
      description:
        "Exact catalog entry by id, with its source pin and provenance edges (how it was reached from the Awesome Testing catalog).",
      inputSchema: z.object({ id: z.string().min(1) }),
    },
    async ({ id }) =>
      guard(() => {
        const entry = ctx.entry(id);
        if (entry === undefined) {
          throw new ToolFailure("ENTRY_NOT_FOUND", `no catalog entry with id '${id}'`);
        }
        return jsonResult({
          entry,
          pin: ctx.pinFor(id) ?? null,
          provenance: entry.provenance,
          lockHash: ctx.lockHash,
        });
      }),
  );
}
