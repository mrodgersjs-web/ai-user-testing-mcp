import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARNESS_VALUES, type InstallManifest } from "./manifest-format.js";
import { readBackupManifest } from "./receipts.js";

import { Installer } from "./installer.js";
import { allHarnessRoots } from "./harness-profiles.js";

const tempDirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SKILL_BODY = "# Demo Skill\n\nDo the demo thing deterministically.\n";
const AGENT_BODY = "---\nname: demo-agent\n---\nRun demos.\n";

/** Writes the caller-provided payload into `payloadDir` and returns a manifest spanning all six harnesses. */
function sixHarnessManifest(payloadDir: string, home: string): InstallManifest {
  const skillSrc = join(payloadDir, "SKILL.md");
  const agentSrc = join(payloadDir, "demo-agent.md");
  writeFileSync(skillSrc, SKILL_BODY);
  writeFileSync(agentSrc, AGENT_BODY);
  const roots = allHarnessRoots(home);
  const harnessTargets: InstallManifest["harnessTargets"] = {};
  for (const harness of HARNESS_VALUES) {
    harnessTargets[harness] = {
      files: [
        { src: skillSrc, dst: join(roots[harness].skillsDir, "demo", "SKILL.md") },
        { src: agentSrc, dst: join(roots[harness].agentsDir, "demo.md") },
      ],
    };
  }
  return { packageName: "demo-pkg", version: "1.0.0", harnessTargets };
}

function makeInstaller(home: string, manifest: InstallManifest, extra: { dryRun?: boolean; nowMs?: number } = {}) {
  return new Installer({
    manifest,
    home,
    dryRun: extra.dryRun,
    now: () => new Date(extra.nowMs ?? Date.parse("2026-08-30T09:00:00.000Z")),
  });
}

function sha(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Snapshot every file under `root` as path → sha256 (for "mutates nothing" assertions). */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.set(p, sha(p));
    }
  };
  walk(root);
  return out;
}

describe("Installer — six-harness plan", () => {
  it("plans every path as create into the six harness roots", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const plan = makeInstaller(home, sixHarnessManifest(payload, home)).plan();

    expect(plan).toHaveLength(12); // 2 files × 6 harnesses
    const harnesses = new Set(plan.map((p) => p.harness));
    expect(harnesses.size).toBe(6);
    for (const p of plan) {
      expect(p.action).toBe("create");
      expect(p.backupPath).toContain(join(".rig-installer", "backup-demo-pkg-"));
    }
    // Profile wiring lands inside the fake home's harness roots.
    const roots = allHarnessRoots(home);
    expect(plan.some((p) => p.path === join(roots.codex.skillsDir, "demo", "SKILL.md"))).toBe(true);
    expect(plan.some((p) => p.path === join(roots.prime.agentsDir, "demo.md"))).toBe(true);
  });
});

describe("Installer — apply/check/reinstall", () => {
  it("apply installs bytes, check is clean, receipt has stable content sha", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const manifest = sixHarnessManifest(payload, home);
    const installer = makeInstaller(home, manifest);

    const first = installer.apply();
    expect(first.conflicts).toHaveLength(0);
    expect(first.receipts).toHaveLength(6);
    expect(first.backupManifestPaths).toHaveLength(6);
    for (const p of first.backupManifestPaths) expect(p).toContain("backup-demo-pkg-");

    const roots = allHarnessRoots(home);
    expect(readFileSync(join(roots.hermes.skillsDir, "demo", "SKILL.md"), "utf8")).toBe(SKILL_BODY);
    expect(readFileSync(join(roots.orca.agentsDir, "demo.md"), "utf8")).toBe(AGENT_BODY);

    const report = installer.check();
    expect(report.clean).toBe(true);
    expect(report.entries).toHaveLength(12);

    // Per-harness BackupManifests exist and together list every planned path.
    const backups = first.backupManifestPaths.map((p) => readBackupManifest(p));
    expect(backups.every((b) => b.schemaVersion === 1)).toBe(true);
    expect(backups.flatMap((b) => b.entries).every((e) => !e.existed && e.backupPath === "absent")).toBe(true);
    expect(backups.flatMap((b) => b.entries).map((e) => e.dst).sort()).toEqual(
      installer.plan().map((p) => p.path).sort(),
    );

    // Reinstall from a second installer instance (later clock) → all nochange, receipts stable.
    const installer2 = makeInstaller(home, manifest, { nowMs: Date.parse("2026-08-30T12:00:00.000Z") });
    expect(installer2.plan().every((p) => p.action === "nochange")).toBe(true);
    const second = installer2.apply();
    const shaByHarness = (docs: typeof second.receipts) =>
      Object.fromEntries(docs.map((d) => [d.harness, d.sha256]));
    expect(shaByHarness(second.receipts)).toEqual(shaByHarness(first.receipts));
    expect(second.receipts.every((d) => d.receiptPath === installer.receipts().find((r) => r.harness === d.harness)?.receiptPath)).toBe(true);
  });

  it("check flags modified and missing managed files", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const installer = makeInstaller(home, sixHarnessManifest(payload, home));
    const { receipts } = installer.apply();
    const roots = allHarnessRoots(home);
    writeFileSync(join(roots.codex.skillsDir, "demo", "SKILL.md"), "tampered\n");
    rmSync(join(roots.hermes.agentsDir, "demo.md"));

    const report = installer.check();
    expect(report.clean).toBe(false);
    const codexSkill = report.entries.find((e) => e.harness === "codex" && e.path.endsWith("SKILL.md"));
    const hermesAgent = report.entries.find(
      (e) => e.harness === "hermes" && e.path === join(roots.hermes.agentsDir, "demo.md"),
    );
    expect(codexSkill?.status).toBe("modified");
    expect(hermesAgent?.status).toBe("missing");
    expect(receipts).toHaveLength(6);
  });
});

describe("Installer — conflict refusal", () => {
  it("refuses apply, leaves the foreign file byte-equal, and reports per-path", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const manifest = sixHarnessManifest(payload, home);
    const roots = allHarnessRoots(home);
    const foreign = join(roots.codex.skillsDir, "demo", "SKILL.md");
    mkdirSync(join(roots.codex.skillsDir, "demo"), { recursive: true });
    writeFileSync(foreign, "someone else's skill\n");
    const before = sha(foreign);
    const homeBefore = snapshotTree(home);

    const result = makeInstaller(home, manifest).apply();
    expect(result.receipts).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.path).toBe(foreign);
    expect(result.conflicts[0]!.action).toBe("conflict");
    expect(result.conflicts[0]!.reason).toContain("not covered by any prior receipt");

    expect(sha(foreign)).toBe(before);
    // Refused apply wrote nothing at all — not even the other 11 paths or backups.
    expect([...snapshotTree(home).entries()]).toEqual([...homeBefore.entries()]);
  });

  it("replaces content of paths already covered by a prior receipt (no conflict)", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const manifest = sixHarnessManifest(payload, home);
    const roots = allHarnessRoots(home);
    const target = join(roots.codex.skillsDir, "demo", "SKILL.md");

    // v1 install with one payload...
    writeFileSync(join(payload, "SKILL.md"), SKILL_BODY);
    makeInstaller(home, manifest).apply();
    // ...then the caller swaps the payload bytes; dst is receipt-managed, so it replaces.
    writeFileSync(join(payload, "SKILL.md"), "# Demo Skill v2\n");
    const plan = makeInstaller(home, manifest).plan();
    const planned = plan.find((p) => p.path === target && p.harness === "codex");
    expect(planned?.action).toBe("replace");
    makeInstaller(home, manifest).apply();
    expect(readFileSync(target, "utf8")).toBe("# Demo Skill v2\n");
    expect(sha(join(payload, "SKILL.md"))).toBe(sha(target));
  });
});

describe("Installer — rollback", () => {
  it("restores pre-images byte-equal and removes created files", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const manifest = sixHarnessManifest(payload, home);
    const roots = allHarnessRoots(home);
    // One dst pre-exists with content identical to the payload (nochange, but backed up).
    const preexisting = join(roots.omp.skillsDir, "demo", "SKILL.md");
    mkdirSync(join(roots.omp.skillsDir, "demo"), { recursive: true });
    writeFileSync(preexisting, SKILL_BODY);
    const preexistingSha = sha(preexisting);

    const installer = makeInstaller(home, manifest);
    const { receipts } = installer.apply();
    const ompReceipt = receipts.find((r) => r.harness === "omp")!;

    const result = installer.rollback(ompReceipt);
    expect(result.verified).toBe(true);
    expect(result.restored).toEqual([preexisting]);
    expect(sha(preexisting)).toBe(preexistingSha); // byte-equal restore
    // The receipt's own created path (omp agent) is deleted; its pre-existing sibling restored.
    expect(result.removed).toEqual([join(roots.omp.agentsDir, "demo.md")]);
    expect(() => readFileSync(join(roots.omp.agentsDir, "demo.md"))).toThrow();
    // Other harnesses untouched by this receipt's rollback; their own rollback deletes theirs.
    const claudeReceipt = receipts.find((r) => r.harness === "claude")!;
    const claudeResult = installer.rollback(claudeReceipt);
    expect(claudeResult.removed).toHaveLength(2);
    for (const p of claudeResult.removed) {
      expect(() => readFileSync(p)).toThrow();
    }
    expect(installer.receipts().map((r) => r.harness).sort()).toEqual(
      HARNESS_VALUES.filter((h) => h !== "omp" && h !== "claude").sort(),
    );
  });
});

describe("Installer — configMerge + uninstall + aliases + dryRun", () => {
  function mergeManifest(payloadDir: string, home: string): InstallManifest {
    const src = join(payloadDir, "SKILL.md");
    writeFileSync(src, SKILL_BODY);
    const roots = allHarnessRoots(home);
    return {
      packageName: "cfg-pkg",
      version: "0.2.0",
      harnessTargets: {
        claude: {
          files: [{ src, dst: join(roots.claude.skillsDir, "cfg", "SKILL.md") }],
          configMerge: [
            {
              file: join(roots.claude.root, "settings.json"),
              marker: "cfg-pkg.hooks",
              block: '  "hooks": { "demo": true }',
            },
          ],
          aliases: [{ dst: join(roots.claude.agentsDir, "cfg-alias.md"), pointsTo: "/opt/shared/cfg-agent.md" }],
        },
      },
    };
  }

  it("merges idempotently around surrounding content, and uninstall strips the block cleanly", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const roots = allHarnessRoots(home);
    const settings = join(roots.claude.root, "settings.json");
    const original = `{\n  "surrounding": "keep me"\n}\n`;
    mkdirSync(roots.claude.root, { recursive: true });
    writeFileSync(settings, original);

    const installer = makeInstaller(home, mergeManifest(payload, home));
    const { receipts } = installer.apply();
    const merged = readFileSync(settings, "utf8");
    expect(merged.startsWith(original)).toBe(true);
    expect(merged).toContain("rig-installer:cfg-pkg.hooks:begin");
    expect(merged).toContain('"hooks": { "demo": true }');
    expect(installer.check().clean).toBe(true);

    // Idempotent reinstall: block replaced in place, no duplicate markers.
    const installer2 = makeInstaller(home, mergeManifest(payload, home), { nowMs: Date.parse("2026-08-31T09:00:00.000Z") });
    const mergedAgain = installer2.plan().find((p) => p.kind === "configMerge")?.action;
    expect(mergedAgain).toBe("nochange");
    installer2.apply();
    const afterReapply = readFileSync(settings, "utf8");
    expect(afterReapply.match(/:begin/g)).toHaveLength(1);
    expect(afterReapply).toBe(merged);

    const result = installer.uninstall(receipts[0]!);
    expect(result.stripped).toEqual([settings]);
    expect(readFileSync(settings, "utf8")).toBe(original); // surrounding content byte-equal
    expect(result.removed).toHaveLength(2); // skill file + alias
    for (const p of result.removed) expect(() => readFileSync(p)).toThrow();
    expect(installer.receipts()).toHaveLength(0);
  });

  it("materializes aliases as exact one-line pointer files", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const roots = allHarnessRoots(home);
    makeInstaller(home, mergeManifest(payload, home)).apply();
    const alias = readFileSync(join(roots.claude.agentsDir, "cfg-alias.md"), "utf8");
    expect(alias).toBe("/opt/shared/cfg-agent.md\n");
  });

  it("dryRun applies nothing anywhere under home", () => {
    const payload = freshDir("payload-");
    const home = freshDir("home-");
    const before = snapshotTree(home);
    const result = makeInstaller(home, sixHarnessManifest(payload, home), { dryRun: true }).apply();

    expect(result.dryRun).toBe(true);
    expect(result.planned.every((p) => p.action === "create")).toBe(true);
    expect(result.receipts).toHaveLength(0);
    expect([...snapshotTree(home).entries()]).toEqual([...before.entries()]);
    expect(readdirSync(home)).toHaveLength(0);
  });
});

describe("Installer — construction guard", () => {
  it("throws on an invalid manifest before any planning", () => {
    const home = freshDir("home-");
    expect(
      () =>
        new Installer({
          manifest: { packageName: "NOPE", version: "1", harnessTargets: {} } as unknown as InstallManifest,
          home,
        }),
    ).toThrow(/invalid InstallManifest/);
    expect(readdirSync(home)).toHaveLength(0);
  });
});
