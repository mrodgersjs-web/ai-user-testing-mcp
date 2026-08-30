import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactReceipt } from "@rig-testlab/catalog";
import { sealReceipt, sha256File, validateArtifactReceiptShape, verifyReceipt } from "./index.js";

const GH_TOKEN = "ghp_Ab1cDe2fGh3iJk4lMn5oPq6rSt7uVw8xYz90";

let storeRoot: string;
let srcDir: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "evidence-receipts-"));
  storeRoot = join(base, "store");
  srcDir = join(base, "store", "inbox"); // inside store root to satisfy containment
  await mkdir(srcDir, { recursive: true });
  await Promise.all([
    writeFile(join(srcDir, "stdout.log"), `running tests\ntoken ${GH_TOKEN} leaked to stdout\ndone\n`, "utf8"),
    writeFile(join(srcDir, "frame.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 0])),
  ]);
});

afterEach(async () => {
  await rm(join(storeRoot, ".."), { recursive: true, force: true });
});

describe("sealReceipt", () => {
  it("redacts text artifacts BEFORE persisting and hashes the stored bytes", async () => {
    const receipt = await sealReceipt({
      runId: "run-1",
      kind: "log",
      storeRoot,
      srcPath: join(srcDir, "stdout.log"),
      id: "ev-1-stdout.log",
    });
    expect(receipt.path).toBe("runs/run-1/artifacts/ev-1-stdout.log-stdout.log");
    expect(receipt.redacted).toBe(true);
    const stored = await readFile(join(storeRoot, receipt.path), "utf8");
    expect(stored).not.toContain(GH_TOKEN);
    expect(stored).toContain("[REDACTED:github_token]");
    expect(receipt.sha256).toBe(await sha256File(join(storeRoot, receipt.path)));
    const raw = await readFile(join(storeRoot, receipt.path));
    expect(receipt.sizeBytes).toBe(raw.byteLength);
    expect(verifyReceipt(receipt, storeRoot)).toBe(true);
  });

  it("stores binary kinds byte-identical with redacted=false only for those kinds", async () => {
    const receipt = await sealReceipt({
      runId: "run-bin",
      kind: "screenshot",
      storeRoot,
      srcPath: join(srcDir, "frame.png"),
    });
    expect(receipt.redacted).toBe(false); // screenshot/video exception
    const stored = await readFile(join(storeRoot, receipt.path));
    const source = await readFile(join(srcDir, "frame.png"));
    expect(stored.equals(source)).toBe(true);
    expect(verifyReceipt(receipt, storeRoot)).toBe(true);

    // A text kind with no secrets still reports redacted=true (the pass ran).
    const textReceipt = await sealReceipt({
      runId: "run-bin",
      kind: "json_report",
      storeRoot,
      srcPath: join(srcDir, "frame.png"),
    });
    expect(textReceipt.redacted).toBe(true);
    expect(verifyReceipt(textReceipt, storeRoot)).toBe(true);
  });

  it("derives a schema-legal id from the source basename when none is given", async () => {
    const receipt = await sealReceipt({
      runId: "run-2",
      kind: "log",
      storeRoot,
      srcPath: join(srcDir, "stdout.log"),
    });
    expect(receipt.id).toBe("stdout.log");
    expect(validateArtifactReceiptShape(receipt)).toEqual([]);
  });

  it("seals a sandbox srcPath OUTSIDE storeRoot but writes only inside storeRoot", async () => {
    // RunnerSandbox flow: artifact lives in an ephemeral worktree, then is deleted.
    const sandbox = await mkdtemp(join(tmpdir(), "evidence-sandbox-"));
    try {
      const outside = join(sandbox, "stdout.log");
      await writeFile(outside, `secret ${GH_TOKEN} here\n`, "utf8");
      const receipt = await sealReceipt({ runId: "run-ext", kind: "log", storeRoot, srcPath: outside });
      expect(receipt.path.startsWith("runs/run-ext/artifacts/")).toBe(true);
      const stored = await readFile(join(storeRoot, receipt.path), "utf8");
      expect(stored).not.toContain(GH_TOKEN);
      expect(verifyReceipt(receipt, storeRoot)).toBe(true);
      // src file untouched by sealing (source is read-only input)
      expect(await readFile(outside, "utf8")).toContain(GH_TOKEN);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses traversal-shaped runId and artifact id", async () => {
    await expect(
      sealReceipt({ runId: "../escape", kind: "log", storeRoot, srcPath: join(srcDir, "stdout.log") }),
    ).rejects.toThrow(/invalid runId/);
    await expect(
      sealReceipt({ runId: "ok", kind: "log", storeRoot, srcPath: join(srcDir, "stdout.log"), id: "Bad Id" }),
    ).rejects.toThrow(/invalid artifact id/);
  });
});

describe("verifyReceipt", () => {
  async function seal(): Promise<ArtifactReceipt> {
    return sealReceipt({
      runId: "run-v",
      kind: "log",
      storeRoot,
      srcPath: join(srcDir, "stdout.log"),
      id: "ev-stdout.log",
    });
  }

  it("passes for an untouched store", async () => {
    expect(verifyReceipt(await seal(), storeRoot)).toBe(true);
  });

  it("detects tampered artifact bytes", async () => {
    const receipt = await seal();
    const target = join(storeRoot, receipt.path);
    const original = await readFile(target, "utf8");
    await writeFile(target, original + "EXTRA", "utf8");
    expect(verifyReceipt(receipt, storeRoot)).toBe(false);
  });

  it("detects a deleted artifact", async () => {
    const receipt = await seal();
    await rm(join(storeRoot, receipt.path));
    expect(verifyReceipt(receipt, storeRoot)).toBe(false);
  });

  it("detects a lying receipt: wrong size, wrong hash, forged redaction flag, traversal path", async () => {
    const receipt = await seal();
    expect(verifyReceipt({ ...receipt, sizeBytes: receipt.sizeBytes + 1 }, storeRoot)).toBe(false);
    expect(verifyReceipt({ ...receipt, sha256: "0".repeat(64) }, storeRoot)).toBe(false);
    expect(verifyReceipt({ ...receipt, redacted: false }, storeRoot)).toBe(false); // log may not claim raw
    expect(verifyReceipt({ ...receipt, path: "../../outside.log" }, storeRoot)).toBe(false);
  });

  it("rejects screenshot receipts that claim redaction (flag/kind consistency)", async () => {
    const shot = await sealReceipt({
      runId: "run-s",
      kind: "video",
      storeRoot,
      srcPath: join(srcDir, "frame.png"),
    });
    expect(verifyReceipt(shot, storeRoot)).toBe(true);
    expect(verifyReceipt({ ...shot, redacted: true }, storeRoot)).toBe(false);
  });
});
