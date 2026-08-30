/**
 * rig-testlab MCP server — composition root.
 *
 * EXACTLY ten tools and six resource URIs/templates over stdio:
 *   tools:     catalog.search catalog.get source.hydrate source.read
 *              runner.select adapter.health suite.compile suite.run
 *              run.wait evidence.verify
 *   resources: testing://catalog/index testing://catalog/{id}
 *              testing://capabilities/{tag} testing://source/{id}/manifest
 *              testing://suite/{id} testing://run/{id}
 *
 * Startup reads only catalog.lock.json (zero-hydration contract). SIGTERM /
 * SIGINT cancels in-flight runs (their manifests persist as 'cancelled'),
 * then closes the transport.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { LabContext } from "./context.js";
import type { LabServerOptions } from "./context.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerSourceTools } from "./tools/source.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerSuiteTools } from "./tools/suite.js";
import { registerRunTools } from "./tools/runs.js";
import { registerResources } from "./resources.js";

export interface LabServer {
  server: McpServer;
  context: LabContext;
}

export function createLabServer(opts: LabServerOptions): LabServer {
  const context = new LabContext(opts);
  const server = new McpServer(
    { name: "rig-testlab", version: "0.1.0" },
    {
      instructions:
        "Governed AI user-testing catalog. Search and read the frozen catalog; hydrate sources only via the printed operator command; compile scenario suites and run them only through reviewed, sandboxed adapters. Blocked/not_evaluated/cancelled are honest terminal states, never passes.",
    },
  );
  registerCatalogTools(server, context);
  registerSourceTools(server, context);
  registerExecutionTools(server, context);
  registerSuiteTools(server, context);
  registerRunTools(server, context);
  registerResources(server, context);
  return { server, context };
}

export async function main(): Promise<void> {
  const root = process.env.RIG_TESTLAB_REPO_ROOT ?? process.cwd();
  const { server, context } = createLabServer({
    lockPath: process.env.RIG_TESTLAB_CATALOG_LOCK ?? resolve(root, "catalog.lock.json"),
    storeRoot: process.env.RIG_TESTLAB_STORE_ROOT ?? resolve(root, ".rig-testlab"),
    adaptersDir: process.env.RIG_TESTLAB_ADAPTERS_DIR ?? resolve(root, "adapters"),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("rig-testlab-mcp listening on stdio\n");

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    const cancelled = context.cancelActiveRuns();
    process.stderr.write(`rig-testlab-mcp ${signal}: cancelled ${cancelled} run(s), closing\n`);
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/** True when this module is the process entry (dist/index.js or tsx src/index.ts). */
function isMainEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main().catch((err) => {
    process.stderr.write(`rig-testlab-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
