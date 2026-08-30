import { describe, expect, it } from "vitest";
import type { ProofPacket } from "@rig-testlab/catalog";
import { canonicalJson, sealProofPacket, sha256Bytes, verifyProofPacket } from "./index.js";

type PacketBody = Omit<ProofPacket, "proofHash">;

function basePacket(): PacketBody {
  return {
    schemaVersion: 1,
    claim: "Suite passed: all representative runs green",
    repoCommit: "a".repeat(40),
    catalogHash: "b".repeat(64),
    sourcePinHash: "c".repeat(64),
    tests: [{ name: "vitest", command: "pnpm exec vitest run", exitCode: 0, summary: "all green" }],
    agentInstallReceipts: [{ harness: "omp", receiptPath: "receipts/omp.json", sha256: "d".repeat(64) }],
    transformfitSmoke: {
      compiled: true,
      representativeRuns: [{ platform: "web", runId: "run-web", state: "passed" }],
    },
    remoteVerification: {
      remoteUrl: "https://github.com/mrodgersjs-web/ai-user-testing-mcp",
      remoteMain: "e".repeat(40),
      localHead: "e".repeat(40),
      equal: true,
      privateVerified: true,
    },
    sealedAt: "2026-08-30T12:00:00.000Z",
    sealedBy: "verifier-b",
  };
}

/** Seal without honesty gating (mirrors sealProofPacket's hash rule) to exercise verify's gates. */
function forge(body: PacketBody): ProofPacket {
  return { ...body, proofHash: sha256Bytes(canonicalJson(body)) };
}

describe("sealProofPacket / verifyProofPacket", () => {
  it("hash round-trips: verify accepts a freshly sealed packet", async () => {
    const { packet, proofHash } = await sealProofPacket(basePacket());
    expect(proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(packet.proofHash).toBe(proofHash);
    const res = verifyProofPacket(packet, { builderIdentity: "builder-a" });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("proofHash is serialization-order independent", async () => {
    const body = basePacket();
    const reordered = Object.fromEntries(Object.entries(body).reverse()) as PacketBody;
    const a = await sealProofPacket(body);
    const b = await sealProofPacket(reordered);
    expect(b.proofHash).toBe(a.proofHash);
  });

  it("rejects when the verifier is the builder", async () => {
    const { packet } = await sealProofPacket(basePacket());
    const res = verifyProofPacket(packet, { builderIdentity: "verifier-b" });
    expect(res.ok).toBe(false);
    expect(res.errors).toContain("verifier_independent");
  });

  it("detects a tampered claim after sealing", async () => {
    const { packet } = await sealProofPacket(basePacket());
    const res = verifyProofPacket({ ...packet, claim: "Suite passed: everything shipped" }, {
      builderIdentity: "builder-a",
    });
    expect(res.ok).toBe(false);
    expect(res.errors).toContain("proof_hash_mismatch");
  });

  it("rejects a pass claim over a blocked representative run (seal AND verify)", async () => {
    const body = basePacket();
    body.transformfitSmoke.representativeRuns = [
      { platform: "web", runId: "run-web", state: "blocked" },
    ];
    await expect(sealProofPacket(body)).rejects.toThrow(/claim_pass_with_non_passing_run:run-web:blocked/);
    const res = verifyProofPacket(forge(body), { builderIdentity: "builder-a" });
    expect(res.errors).toContain("claim_pass_with_non_passing_run:run-web:blocked");
  });

  it("rejects a green claim carrying a failing test, but allows honest failure wording", async () => {
    const failing = basePacket();
    failing.tests = [
      { name: "vitest", command: "pnpm exec vitest run", exitCode: 1, summary: "2 failed" },
    ];
    await expect(sealProofPacket(failing)).rejects.toThrow(/claim_pass_with_failing_test:vitest/);
    const res = verifyProofPacket(forge(failing), { builderIdentity: "builder-a" });
    expect(res.errors).toContain("claim_pass_with_failing_test:vitest");

    failing.claim = "Recording observed failing state for the audit trail";
    const honest = await sealProofPacket(failing); // no pass-implying claim ⇒ gate not triggered
    expect(verifyProofPacket(honest.packet, { builderIdentity: "builder-a" }).ok).toBe(true);
  });

  it("rejects remote verification that is not equal+private (SKIP is never PASS)", async () => {
    const body = basePacket();
    body.remoteVerification = {
      ...body.remoteVerification,
      equal: false,
    } as unknown as PacketBody["remoteVerification"];
    await expect(sealProofPacket(body)).rejects.toThrow(/remoteVerification:equal_const/);
    const res = verifyProofPacket(forge(body), { builderIdentity: "builder-a" });
    expect(res.errors).toContain("packet:remoteVerification:equal_const");
  });

  it("enforces hash shapes and rejects unknown fields", async () => {
    const badHash = basePacket();
    badHash.catalogHash = "not-a-hash";
    await expect(sealProofPacket(badHash)).rejects.toThrow(/packet:catalogHash_pattern/);

    const extra = { ...basePacket(), bonus: true } as unknown as PacketBody;
    await expect(sealProofPacket(extra)).rejects.toThrow(/packet:unknown_bonus/);
  });

  it("a non-pass claim may still not smuggle a broken proofHash", () => {
    const forged = forge(basePacket());
    const res = verifyProofPacket({ ...forged, sealedAt: "2027-01-01T00:00:00.000Z" }, {
      builderIdentity: "builder-a",
    });
    expect(res.errors).toContain("proof_hash_mismatch");
  });
});
