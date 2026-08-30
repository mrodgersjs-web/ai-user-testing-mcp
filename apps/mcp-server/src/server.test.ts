/**
 * MCP server acceptance: exact 10-tool/6-resource conformance plus the
 * adversarial lanes (traversal, unknown ids, mid-run cancel, zero-hydration).
 * Client and server are linked over a real InMemoryTransport pair — the same
 * wire the stdio transport speaks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";

import { createLabServer, type LabServer } from "./index.js";
import type { SpawnHandle, SpawnResult, SpawnSpec } from "@rig-testlab/runner";

const FIXTURE_LOCK = resolve(import.meta.dirname, "..", "testdata", "catalog.lock.minimal.json");
const tmpDirs: string[] = [];
const fresh = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `rt-mcp-${label}-`));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const EXPECTED_TOOLS = [
  "adapter.health",
  "catalog.get",
  "catalog.search",
  "evidence.verify",
  "run.wait",
  "runner.select",
  "source.hydrate",
  "source.read",
  "suite.compile",
  "suite.run",
].sort();

interface Harness {
  lab: LabServer;
  client: Client;
}

async function harness(opts: Partial<Parameters<typeof createLabServer>[0]> = {}): Promise<Harness> {
  const storeRoot = fresh("store");
  const lab = createLabServer({
    lockPath: FIXTURE_LOCK,
    storeRoot,
    adaptersDir: opts.adaptersDir ?? fresh("adapters"),
    ...opts,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await lab.server.connect(serverSide);
  const client = new Client({ name: "vitest-client", version: "0.0.1" });
  await client.connect(clientSide);
  return { lab, client };
}

/** Adapter dir with one reviewed paid adapter and one experimental adapter. */
function adapterDirWith(experimentalId: string): string {
  const dir = fresh("adapters");
  const base = {
    name: "fixture adapter",
    adapterVersion: "1.0.0",
    sourceEntryId: "mission.core.testsprite",
    commandAllowlist: [["node"]],
    networkAllowlist: [],
    limits: { maxCpuMs: 1000, maxMemoryMb: 64, maxWallClockS: 5, maxOutputBytes: 1024 },
    credentialMode: "none",
    fixtures: { passing: "fixtures/passing.mjs", plantedFailing: "fixtures/failing.mjs", unavailableDependency: "fixtures/unavailable.mjs" },
    evidenceKinds: ["json_report"],
  };
  for (const [id, status, paid] of [["testsprite", "reviewed", true] as const, [experimentalId, "experimental", false] as const]) {
    mkdirSync(join(dir, id, "fixtures"), { recursive: true });
    writeFileSync(
      join(dir, id, "adapter.json"),
      JSON.stringify({
        ...base,
        id,
        status,
        paidProvider: paid,
        ...(paid ? { paidGuards: { maxScenarios: 5, maxEstimatedCredits: 10 } } : {}),
      }),
    );
    writeFileSync(join(dir, id, "fixtures", "passing.mjs"), "console.log('ok')");
    writeFileSync(join(dir, id, "fixtures", "failing.mjs"), "process.exit(1)");
    writeFileSync(join(dir, id, "fixtures", "unavailable.mjs"), "process.exit(127)");
  }
  return dir;
}

function scenarioSpec(adapterId: string) {
  return {
    id: "sc-1",
    project: "demo",
    platforms: ["web"],
    title: "spec",
    steps: [{ action: "run", expected: "ok" }],
    requiredAdapters: [adapterId],
    requiredEvidence: ["json_report"],
  };
}

describe("conformance", () => {
  it("exposes exactly the 10 tools and 6 resources", async () => {
    const { client } = await harness();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    // 5 templates + 1 static index resource; listResources expands templates,
    // so the static surface is asserted by prefix, never by expanded count.
    expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "testing://capabilities/{tag}",
      "testing://catalog/{id}",
      "testing://run/{id}",
      "testing://source/{id}/manifest",
      "testing://suite/{id}",
    ]);
    expect(resources.resources.some((r) => r.uri === "testing://catalog/index")).toBe(true);
  });
});

describe("happy path", () => {
  it("search finds the fixture entry; compile refuses an unreviewed adapter", async () => {
    const { client } = await harness({ adaptersDir: adapterDirWith("experimental-tool") });
    const search = await client.callTool({ name: "catalog.search", arguments: { query: "jmeter" } });
    expect(search.isError).toBeFalsy();
    const hits = (search.structuredContent as { hits: Array<{ id: string }> }).hits;
    expect(hits.some((h) => h.id === "aliesbelik--awesome-jmeter")).toBe(true);

    const compile = await client.callTool({
      name: "suite.compile",
      arguments: {
        project: {
          id: "demo",
          repo: { url: "https://example.invalid/x.git", revision: "a".repeat(40) },
          platforms: ["web"],
          suites: [{ path: "e2e", scenarioIds: ["sc-1"] }],
          requiredAdapters: ["experimental-tool"],
        },
        scenarios: [scenarioSpec("experimental-tool")],
      },
    });
    const compiled = compile.structuredContent as { refusals: Array<{ reason: string }>; manifests: unknown[] };
    expect(compiled.manifests).toHaveLength(0);
    expect(compiled.refusals.some((r) => r.reason.includes("adapter_not_reviewed"))).toBe(true);
  });
});

describe("source.read traversal", () => {
  it("cannot read outside the submodule root; legit in-root file reads fine", async () => {
    const sourcesRoot = fresh("sources");
    const subPath = join(sourcesRoot, "sources", "direct", "abhivaikar", "abhivaikar--howtheytest");
    mkdirSync(subPath, { recursive: true });
    writeFileSync(join(subPath, "README.md"), "fixture readme\n");
    const canary = join(sourcesRoot, "canary-secret.txt");
    writeFileSync(canary, "MUST-NOT-LEAK\n");

    const { client } = await harness({ sourcesRoot });
    const ok = await client.callTool({
      name: "source.read",
      arguments: { id: "abhivaikar--howtheytest", path: "README.md" },
    });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as { content: string }).content).toContain("fixture readme");

    for (const evil of ["../../canary-secret.txt", "../../../canary-secret.txt", canary, "..%2f..%2fcanary-secret.txt"]) {
      const res = await client.callTool({ name: "source.read", arguments: { id: "abhivaikar--howtheytest", path: evil } });
      expect(res.isError, evil).toBe(true);
      expect(JSON.stringify(res.content)).not.toContain("MUST-NOT-LEAK");
    }
  });
});

describe("error envelopes", () => {
  it("unknown ids produce machine-readable codes, never generic errors", async () => {
    const { client } = await harness();
    const res = await client.callTool({ name: "catalog.get", arguments: { id: "no-such-entry" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent ?? res.content)).toContain("ENTRY_NOT_FOUND");
  });
});

describe("run cancellation", () => {
  it("aborting mid-run persists cancelled, and summaries count zero passed", async () => {
    const adaptersDir = adapterDirWith("experimental-tool");
    const killed: string[] = [];
    const spawnSeen = Promise.withResolvers<void>();
    const sleepySpawner = {
      spawn(_spec: SpawnSpec): SpawnHandle {
        spawnSeen.resolve();
        const { promise: exited, resolve: resolveExited } = Promise.withResolvers<SpawnResult>();
        const stdout = new Readable({ read() {} });
        const stderr = new Readable({ read() {} });
        return {
          pid: 424242,
          stdout,
          stderr,
          exited,
          killTree: (signal: NodeJS.Signals) => {
            killed.push(signal);
            stdout.push(null);
            stderr.push(null);
            resolveExited({ code: null, signal });
          },
        };
      },
    };
    const { lab, client } = await harness({ adaptersDir, spawner: sleepySpawner });

    const manifest = {
      runId: "run-cancel-me",
      scenarioId: "sc-1",
      adapterId: "testsprite",
      sandbox: { homeDir: "h", worktree: "w", readOnlySource: true, limitsApplied: false },
      state: "queued",
      startedAt: null,
      finishedAt: null,
      commands: [],
      networkUsed: [],
      credits: { estimated: 1, consumed: 0 },
      artifacts: [],
      redactionApplied: false,
    };
    const call = client.callTool({
      name: "suite.run",
      arguments: { compiledSuite: { manifests: [manifest] }, budget: { maxEstimatedCredits: 5 } },
    });
    // Deterministic: cancel only once the child spawn is definitely in flight.
    await spawnSeen.promise;
    const cancelled = lab.context.cancelActiveRuns();
    const result = await call;
    expect(cancelled).toBeGreaterThanOrEqual(1);
    expect(killed.length).toBeGreaterThanOrEqual(1);
    const payload = result.structuredContent as { results: Array<{ runId: string; state: string }>; summary: Record<string, number> };
    const terminal = payload.results.find((m) => m.runId === "run-cancel-me");
    expect(terminal?.state).toBe("cancelled");
    expect(payload.summary["passed"] ?? 0).toBe(0);
  });
});

describe("zero-hydration startup", () => {
  it("search + get work with no sources tree at all", async () => {
    const { client } = await harness({ sourcesRoot: join(fresh("empty"), "no-such-dir") });
    const search = await client.callTool({ name: "catalog.search", arguments: { query: "mock jutsu" } });
    expect(search.isError).toBeFalsy();
    const get = await client.callTool({ name: "catalog.get", arguments: { id: "altansayan--mock-jutsu-api" } });
    expect(get.isError).toBeFalsy();
    expect((get.structuredContent as { entry: { id: string } }).entry.id).toBe("altansayan--mock-jutsu-api");
  });
});
