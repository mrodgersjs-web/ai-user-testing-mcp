/**
 * rig-testlab CLI adversarial acceptance: every test drives run() in-process
 * with a temp repo root and recorded deps — refusal paths are proven by
 * zero-call assertions on the command runner, never by output skimming.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildFtsIndex } from "@rig-testlab/catalog";
import { run, type CliDeps } from "./index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FIXTURE_LOCK = join(import.meta.dirname, "..", "testdata", "catalog.lock.minimal.json");
const REAL_ADAPTERS = join(ROOT, "adapters");

const tmpDirs: string[] = [];
const fresh = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `rt-cli-${label}-`));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Minimal repo-shaped root: workspace marker + the committed fixture lock. */
function makeRepoRoot(label: string, mutateLock?: (raw: string) => string): string {
  const root = fresh(label);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  const raw = readFileSync(FIXTURE_LOCK, "utf8");
  writeFileSync(join(root, "catalog.lock.json"), mutateLock === undefined ? raw : mutateLock(raw));
  return root;
}

interface Captured {
  code: number;
  out: string;
  err: string;
  calls: readonly (readonly string[])[];
}

async function cli(argv: readonly string[], deps: Partial<CliDeps> = {}): Promise<Captured> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const calls: string[][] = [];
  const code = await run({
    argv,
    env: {},
    out: (l) => outLines.push(l),
    err: (l) => errLines.push(l),
    runCommand: async (cmdArgv) => {
      calls.push([...cmdArgv]);
      if (cmdArgv[0] === "df") {
        return {
          code: 0,
          stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 488245288 100000000 388245288 26% /\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    ...deps,
  });
  return { code, out: outLines.join("\n"), err: errLines.join("\n"), calls };
}

describe("catalog commands", () => {
  it("stats against the fixture lock prints honest counts (exit 0)", async () => {
    const root = makeRepoRoot("stats");
    const r = await cli(["catalog", "stats", "--json"], { cwd: root });
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out);
    expect(payload.ok).toBe(true);
    expect(payload.entries).toBe(12);
    expect(payload.statistics.firstLevelCount).toBe(5);
  });

  it("malformed lock → exit 2 with JSON-pointer lines, nothing proceeds", async () => {
    const root = makeRepoRoot("malformed", (raw) => raw.replace('"active"', '"not-a-status"'));
    const r = await cli(["catalog", "stats"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.err).toContain("CATALOG_LOCK_INVALID");
    expect(r.err).toMatch(/\/entries\/\d+/);
  });

  it("missing lock → exit 1 with actionable guidance", async () => {
    const root = fresh("nolock");
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const r = await cli(["catalog", "stats"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/sync|missing/i);
  });

  it("search reuses the FTS cache until lock bytes change", async () => {
    const root = makeRepoRoot("search-cache");
    let builds = 0;
    const deps: Partial<CliDeps> = {
      cwd: root,
      buildIndex: (lock, dbPath) => {
        builds++;
        return buildFtsIndex(lock, dbPath);
      },
    };
    const q = ["catalog", "search", "cypress", "--json"];
    expect((await cli(q, deps)).code).toBe(0);
    expect((await cli(q, deps)).code).toBe(0);
    expect(builds).toBe(1);
    const lockPath = join(root, "catalog.lock.json");
    writeFileSync(lockPath, `${readFileSync(lockPath, "utf8")} `);
    expect((await cli(q, deps)).code).toBe(0);
    expect(builds).toBe(2);
  });

  it("unknown flag → exit 2 with command help; unknown command → exit 2 with global help", async () => {
    const root = makeRepoRoot("usage");
    const bad = await cli(["catalog", "stats", "--bogus"], { cwd: root });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("catalog");
    const unknown = await cli(["frobnicate"], { cwd: root });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("UNKNOWN_COMMAND");
  });
});

describe("source hydrate", () => {
  it("--all without --confirm is a dry run: ZERO git invocations, estimate printed", async () => {
    const root = makeRepoRoot("hydrate-dry");
    const r = await cli(["source", "hydrate", "--all"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY RUN");
    expect(r.out).toContain("hydrate estimate");
    expect(r.calls.filter((c) => c[0] === "git")).toHaveLength(0);
  });
});

describe("suite commands", () => {
  function makeSuiteRoot(): string {
    const root = makeRepoRoot("suite");
    mkdirSync(join(root, "adapters"), { recursive: true });
    cpSync(join(REAL_ADAPTERS, "testsprite"), join(root, "adapters", "testsprite"), { recursive: true });
    cpSync(join(REAL_ADAPTERS, "cypress"), join(root, "adapters", "cypress"), { recursive: true });
    writeFileSync(
      join(root, "project.json"),
      JSON.stringify({
        id: "demoproj",
        repo: { url: "https://example.invalid/repo.git", revision: "a".repeat(40) },
        platforms: ["web"],
        suites: [{ path: "e2e", scenarioIds: ["s-paid"] }],
        requiredAdapters: ["testsprite", "cypress"],
      }),
    );
    return root;
  }
  const PAID_SCENARIO = [
    {
      id: "s-paid",
      project: "demoproj",
      platforms: ["web"],
      title: "paid scenario without budget",
      steps: [{ action: "run", expected: "ok" }],
      requiredAdapters: ["testsprite"],
      requiredEvidence: ["json_report"],
    },
  ];

  it("paid adapter without budget flags → BUDGET_REQUIRED, exit 1, nothing compiled", async () => {
    const root = makeSuiteRoot();
    writeFileSync(join(root, "scenarios.json"), JSON.stringify(PAID_SCENARIO));
    const r = await cli(
      ["suite", "compile", "--project", join(root, "project.json"), "--scenarios", join(root, "scenarios.json")],
      { cwd: root },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("BUDGET_REQUIRED");
    expect(r.err).toContain("testsprite");
  });

  it("with budget flags the same suite compiles queued manifests", async () => {
    const root = makeSuiteRoot();
    writeFileSync(join(root, "scenarios.json"), JSON.stringify(PAID_SCENARIO));
    const r = await cli(
      [
        "suite",
        "compile",
        "--project",
        join(root, "project.json"),
        "--scenarios",
        join(root, "scenarios.json"),
        "--budget-scenarios",
        "1",
        "--budget-credits",
        "2",
        "--json",
      ],
      { cwd: root },
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out);
    expect(payload.ok).toBe(true);
  });
});

describe("evidence report", () => {
  it("a not_evaluated run is listed explicitly and never counted as passed", async () => {
    const root = makeRepoRoot("report");
    const storeRoot = join(root, "store");
    const manifest = {
      runId: "run-ne",
      scenarioId: "s1",
      adapterId: "cypress",
      sandbox: { homeDir: "x", worktree: "y", readOnlySource: true, limitsApplied: true },
      state: "not_evaluated",
      startedAt: null,
      finishedAt: null,
      commands: [],
      networkUsed: [],
      credits: { estimated: 0, consumed: 0 },
      failureDetail: "scenario_budget_exhausted",
      artifacts: [],
      redactionApplied: false,
    };
    mkdirSync(join(storeRoot, "runs", "run-ne"), { recursive: true });
    writeFileSync(join(storeRoot, "runs", "run-ne", "manifest.json"), JSON.stringify(manifest));
    const r = await cli(["evidence", "report", "--all", "--store", storeRoot], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.out).toContain("NOT_EVALUATED");
    expect(r.out).toContain("- passed: 0");
    expect(r.out).toContain("- not_evaluated: 1");
  });
});

describe("adapter promote", () => {
  it("promotion flips experimental→reviewed and appends an audit line", async () => {
    const root = makeRepoRoot("promote");
    mkdirSync(join(root, "adapters"), { recursive: true });
    cpSync(join(REAL_ADAPTERS, "watir"), join(root, "adapters", "watir"), { recursive: true });
    const descriptorPath = join(root, "adapters", "watir", "adapter.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    descriptor.status = "experimental";
    writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
    const r = await cli(["adapter", "promote", "--id", "watir", "--by", "operator-mike", "--note", "reviewed 2026-08-30"], {
      cwd: root,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).status).toBe("reviewed");
    const audit = readFileSync(join(root, ".rig-testlab", "audit", "adapter-promote.jsonl"), "utf8").trim();
    const line = JSON.parse(audit.split("\n").at(-1)!);
    expect(line.operator).toBe("operator-mike");
    expect(line.adapterId).toBe("watir");
  });

  it("anonymous promotion is refused", async () => {
    const root = makeRepoRoot("promote-anon");
    mkdirSync(join(root, "adapters"), { recursive: true });
    cpSync(join(REAL_ADAPTERS, "watir"), join(root, "adapters", "watir"), { recursive: true });
    const r = await cli(["adapter", "promote", "--id", "watir"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.err).toContain("PROMOTE_OPERATOR_REQUIRED");
  });
});

describe("doctor", () => {
  it("planted invalid lock → nonzero exit naming the failing check", async () => {
    const root = makeRepoRoot("doctor-bad", (raw) => raw.replace('"active"', '"not-a-status"'));
    const r = await cli(["doctor"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.out).toContain("catalog-lock");
    expect(r.out).toContain("FAIL");
  });

  it("healthy temp root exits 0", async () => {
    const root = makeRepoRoot("doctor-ok");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(root, "adapters"), { recursive: true });
    cpSync(join(REAL_ADAPTERS, "cypress"), join(root, "adapters", "cypress"), { recursive: true });
    const r = await cli(["doctor"], { cwd: root, nodeVersion: "v22.22.3" });
    expect(r.code).toBe(0);
  });
});
