/**
 * The six resource surfaces. All reads answer from the active lock or the
 * file-backed store — nothing clones, nothing executes.
 *
 * Unknown ids raise ResourceNotFoundError whose message begins with the same
 * machine code the tools use (ENTRY_NOT_FOUND / SUITE_NOT_FOUND / …).
 */
import { ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { LabContext } from "./context.js";

function jsonResource(uri: URL, payload: unknown): { contents: Array<{ uri: string; text: string }> } {
  return { contents: [{ uri: uri.href, text: JSON.stringify(payload, null, 2) }] };
}

const JSON_MIME = "application/json";

export function registerResources(server: McpServer, ctx: LabContext): void {
  server.registerResource(
    "catalog-index",
    "testing://catalog/index",
    { title: "Catalog Index", mimeType: JSON_MIME },
    async (uri) =>
      jsonResource(uri, {
        schemaVersion: ctx.lock.schemaVersion,
        generatedFrom: ctx.lock.generatedFrom,
        statistics: ctx.lock.statistics,
        nestedCatalogs: ctx.lock.nestedCatalogs,
        lockHash: ctx.lockHash,
        entryIds: ctx.lock.entries.map((e) => e.id),
      }),
  );

  server.registerResource(
    "catalog-entry",
    new ResourceTemplate("testing://catalog/{id}", {
      list: async () => ({
        resources: ctx.lock.entries.map((e) => ({
          name: e.id,
          uri: `testing://catalog/${e.id}`,
          mimeType: JSON_MIME,
        })),
      }),
    }),
    { title: "Catalog Entry", mimeType: JSON_MIME },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const entry = ctx.entry(id);
      if (entry === undefined) {
        throw new ResourceNotFoundError(uri.href, `ENTRY_NOT_FOUND: no catalog entry with id '${id}'`);
      }
      return jsonResource(uri, { entry, pin: ctx.pinFor(id) ?? null });
    },
  );

  server.registerResource(
    "capabilities",
    new ResourceTemplate("testing://capabilities/{tag}", {
      list: async () => {
        const tags = [...new Set(ctx.lock.entries.flatMap((e) => e.capabilities))].sort();
        return {
          resources: tags.map((tag) => ({
            name: tag,
            uri: `testing://capabilities/${encodeURIComponent(tag)}`,
            mimeType: JSON_MIME,
          })),
        };
      },
    }),
    { title: "Capability Tag", mimeType: JSON_MIME },
    async (uri, variables) => {
      const tag = String(variables.tag ?? "");
      const entryIds = ctx.lock.entries.filter((e) => e.capabilities.includes(tag)).map((e) => e.id);
      if (entryIds.length === 0) {
        throw new ResourceNotFoundError(uri.href, `TAG_NOT_FOUND: no catalog entry carries capability '${tag}'`);
      }
      return jsonResource(uri, { tag, entryIds });
    },
  );

  server.registerResource(
    "source-manifest",
    new ResourceTemplate("testing://source/{id}/manifest", {
      list: async () => ({
        resources: ctx.lock.pins.map((p) => ({
          name: p.entryId,
          uri: `testing://source/${p.entryId}/manifest`,
          mimeType: JSON_MIME,
        })),
      }),
    }),
    { title: "Source Manifest", mimeType: JSON_MIME },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const entry = ctx.entry(id);
      if (entry === undefined) {
        throw new ResourceNotFoundError(uri.href, `ENTRY_NOT_FOUND: no catalog entry with id '${id}'`);
      }
      const pin = ctx.pinFor(id);
      if (pin === undefined) {
        throw new ResourceNotFoundError(uri.href, `NO_SOURCE_PIN: entry '${id}' has no submodule pin`);
      }
      return jsonResource(uri, {
        entryId: id,
        pin,
        hydration: {
          command: ctx.hydrateCommand(pin),
          runFrom: ctx.repoRoot,
          serverExecutes: false,
        },
      });
    },
  );

  server.registerResource(
    "suite",
    new ResourceTemplate("testing://suite/{id}", {
      list: async () => ({
        resources: ctx.listSuites().map((id) => ({
          name: id,
          uri: `testing://suite/${id}`,
          mimeType: JSON_MIME,
        })),
      }),
    }),
    { title: "Compiled Suite", mimeType: JSON_MIME },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      try {
        return jsonResource(uri, ctx.readSuite(id));
      } catch {
        throw new ResourceNotFoundError(uri.href, `SUITE_NOT_FOUND: no compiled suite '${id}'`);
      }
    },
  );

  server.registerResource(
    "run",
    new ResourceTemplate("testing://run/{id}", {
      list: async () => ({
        resources: ctx.listRuns().map((id) => ({
          name: id,
          uri: `testing://run/${id}`,
          mimeType: JSON_MIME,
        })),
      }),
    }),
    { title: "Run Manifest", mimeType: JSON_MIME },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const manifest = ctx.readRun(id);
      if (manifest === undefined) {
        throw new ResourceNotFoundError(uri.href, `RUN_NOT_FOUND: no run manifest '${id}'`);
      }
      return jsonResource(uri, manifest);
    },
  );
}
