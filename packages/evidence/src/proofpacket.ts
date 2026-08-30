import type { ProofPacket, RunState } from "@rig-testlab/catalog";
import { canonicalJson, sha256Bytes } from "./hashing.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const REMOTE_URL_RE = /^https:\/\/github\.com\/mrodgersjs-web\/ai-user-testing-mcp(\.git)?$/;

const PACKET_KEYS: Record<string, true> = {
  schemaVersion: true,
  claim: true,
  repoCommit: true,
  catalogHash: true,
  sourcePinHash: true,
  tests: true,
  agentInstallReceipts: true,
  transformfitSmoke: true,
  remoteVerification: true,
  sealedAt: true,
  sealedBy: true,
  proofHash: true,
};

const TEST_KEYS: Record<string, true> = { name: true, command: true, exitCode: true, summary: true };
const INSTALL_KEYS: Record<string, true> = { harness: true, receiptPath: true, sha256: true };
const SMOKE_KEYS: Record<string, true> = { compiled: true, representativeRuns: true };
const RUN_KEYS: Record<string, true> = { platform: true, runId: true, state: true };
const REMOTE_KEYS: Record<string, true> = {
  remoteUrl: true,
  remoteMain: true,
  localHead: true,
  equal: true,
  privateVerified: true,
};

const HARNESS_SET: Record<string, true> = {
  codex: true,
  claude: true,
  hermes: true,
  omp: true,
  orca: true,
  prime: true,
};

// Mirrors RunManifest.v1 state enum; kept as an exhaustive RunState record so a
// missing state is a compile error.
const RUN_STATE_SET: Record<RunState, true> = {
  queued: true,
  running: true,
  passed: true,
  failed: true,
  blocked: true,
  not_evaluated: true,
  cancelled: true,
};

/** Mirrors catalog NON_PASSING_STATES semantics: anything that is not `passed`. */
function isNonPassingState(state: unknown): boolean {
  return !(typeof state === "string" && state in RUN_STATE_SET && state === "passed");
}

function checkKeys(obj: Record<string, unknown>, allowed: Record<string, true>, prefix: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(allowed)) {
    if (obj[key] === undefined) errors.push(`${prefix}:missing_${key}`);
  }
  for (const key of Object.keys(obj)) {
    if (!(key in allowed)) errors.push(`${prefix}:unknown_${key}`);
  }
  return errors;
}

/** Structural check mirroring schemas/ProofPacket.v1.schema.json (no ajv in this package). */
export function validateProofPacketShape(packet: ProofPacket): string[] {
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    return ["packet_not_object"];
  }
  const p = packet as unknown as Record<string, unknown>;
  const errors = checkKeys(p, PACKET_KEYS, "packet");
  if (p.schemaVersion !== 1) errors.push("packet:schemaVersion_const");
  if (typeof p.claim !== "string" || p.claim.length === 0) errors.push("packet:claim_minLength");
  if (typeof p.repoCommit !== "string" || !COMMIT_RE.test(p.repoCommit)) errors.push("packet:repoCommit_pattern");
  if (typeof p.catalogHash !== "string" || !SHA256_RE.test(p.catalogHash)) errors.push("packet:catalogHash_pattern");
  if (typeof p.sourcePinHash !== "string" || !SHA256_RE.test(p.sourcePinHash)) errors.push("packet:sourcePinHash_pattern");

  if (!Array.isArray(p.tests) || p.tests.length === 0) {
    errors.push("packet:tests_minItems");
  } else {
    p.tests.forEach((test: unknown, i: number) => {
      if (typeof test !== "object" || test === null) {
        errors.push(`packet:tests[${i}]:not_object`);
        return;
      }
      const t = test as Record<string, unknown>;
      errors.push(...checkKeys(t, TEST_KEYS, `packet:tests[${i}]`));
      if (typeof t.name !== "string") errors.push(`packet:tests[${i}]:name_type`);
      if (typeof t.command !== "string") errors.push(`packet:tests[${i}]:command_type`);
      if (!Number.isInteger(t.exitCode)) errors.push(`packet:tests[${i}]:exitCode_type`);
      if (typeof t.summary !== "string") errors.push(`packet:tests[${i}]:summary_type`);
    });
  }

  if (Array.isArray(p.agentInstallReceipts)) {
    p.agentInstallReceipts.forEach((rec: unknown, i: number) => {
      if (typeof rec !== "object" || rec === null) {
        errors.push(`packet:agentInstallReceipts[${i}]:not_object`);
        return;
      }
      const r = rec as Record<string, unknown>;
      errors.push(...checkKeys(r, INSTALL_KEYS, `packet:agentInstallReceipts[${i}]`));
      if (typeof r.harness !== "string" || !(r.harness in HARNESS_SET)) {
        errors.push(`packet:agentInstallReceipts[${i}]:harness_enum`);
      }
      if (typeof r.receiptPath !== "string") errors.push(`packet:agentInstallReceipts[${i}]:receiptPath_type`);
      if (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256)) {
        errors.push(`packet:agentInstallReceipts[${i}]:sha256_pattern`);
      }
    });
  } else if (p.agentInstallReceipts !== undefined) {
    errors.push("packet:agentInstallReceipts_type");
  }

  if (typeof p.transformfitSmoke !== "object" || p.transformfitSmoke === null) {
    errors.push("packet:transformfitSmoke_type");
  } else {
    const s = p.transformfitSmoke as Record<string, unknown>;
    errors.push(...checkKeys(s, SMOKE_KEYS, "packet:transformfitSmoke"));
    if (typeof s.compiled !== "boolean") errors.push("packet:transformfitSmoke:compiled_type");
    if (!Array.isArray(s.representativeRuns)) {
      errors.push("packet:transformfitSmoke:representativeRuns_type");
    } else {
      s.representativeRuns.forEach((run: unknown, i: number) => {
        if (typeof run !== "object" || run === null) {
          errors.push(`packet:transformfitSmoke:representativeRuns[${i}]:not_object`);
          return;
        }
        const r = run as Record<string, unknown>;
        errors.push(...checkKeys(r, RUN_KEYS, `packet:transformfitSmoke:representativeRuns[${i}]`));
        if (typeof r.platform !== "string") errors.push(`packet:transformfitSmoke:representativeRuns[${i}]:platform_type`);
        if (typeof r.runId !== "string") errors.push(`packet:transformfitSmoke:representativeRuns[${i}]:runId_type`);
        if (typeof r.state !== "string" || !(r.state in RUN_STATE_SET)) {
          errors.push(`packet:transformfitSmoke:representativeRuns[${i}]:state_enum`);
        }
      });
    }
  }

  if (typeof p.remoteVerification !== "object" || p.remoteVerification === null) {
    errors.push("packet:remoteVerification_type");
  } else {
    const v = p.remoteVerification as Record<string, unknown>;
    errors.push(...checkKeys(v, REMOTE_KEYS, "packet:remoteVerification"));
    if (typeof v.remoteUrl !== "string" || !REMOTE_URL_RE.test(v.remoteUrl)) errors.push("packet:remoteVerification:remoteUrl_pattern");
    if (typeof v.remoteMain !== "string" || !COMMIT_RE.test(v.remoteMain)) errors.push("packet:remoteVerification:remoteMain_pattern");
    if (typeof v.localHead !== "string" || !COMMIT_RE.test(v.localHead)) errors.push("packet:remoteVerification:localHead_pattern");
    if (v.equal !== true) errors.push("packet:remoteVerification:equal_const");
    if (v.privateVerified !== true) errors.push("packet:remoteVerification:privateVerified_const");
  }

  if (typeof p.sealedAt !== "string" || !(DATE_TIME_RE.test(p.sealedAt) && !Number.isNaN(Date.parse(p.sealedAt)))) {
    errors.push("packet:sealedAt_format");
  }
  if (typeof p.sealedBy !== "string" || p.sealedBy.length === 0) errors.push("packet:sealedBy_minLength");
  if (typeof p.proofHash !== "string" || !SHA256_RE.test(p.proofHash)) errors.push("packet:proofHash_pattern");
  return errors;
}

const PASS_CLAIM_RE = /\b(pass(?:ed|es|ing)?|all\s+green|green)\b/i;

/**
 * Mechanical honesty rules on top of shape: a claim that reads as a pass
 * aggregate may not carry failing tests or non-passing representative runs;
 * remote verification must be equal+private (an honest SKIP is never a PASS).
 */
export function proofPacketHonestyErrors(packet: ProofPacket): string[] {
  const errors: string[] = [];
  if (typeof packet.claim !== "string" || !PASS_CLAIM_RE.test(packet.claim)) return errors;
  for (const test of packet.tests ?? []) {
    if (test.exitCode !== 0) errors.push(`claim_pass_with_failing_test:${test.name}`);
  }
  for (const run of packet.transformfitSmoke?.representativeRuns ?? []) {
    if (isNonPassingState(run.state)) errors.push(`claim_pass_with_non_passing_run:${run.runId}:${String(run.state)}`);
  }
  return errors;
}

export interface SealProofPacketResult {
  packet: ProofPacket;
  proofHash: string;
}

/** proofHash = sha256(canonicalJson(packet minus proofHash)). Sealed packets must satisfy shape + honesty rules. */
export async function sealProofPacket(
  input: Omit<ProofPacket, "proofHash">,
): Promise<SealProofPacketResult> {
  const proofHash = sha256Bytes(canonicalJson(input));
  const packet: ProofPacket = { ...input, proofHash };
  const errors = [...validateProofPacketShape(packet), ...proofPacketHonestyErrors(packet)];
  if (errors.length > 0) {
    throw new TypeError(`sealProofPacket: rejected: ${errors.join(", ")}`);
  }
  return { packet, proofHash };
}

export interface VerifyProofPacketOptions {
  builderIdentity: string;
}

export interface VerifyProofPacketResult {
  ok: boolean;
  errors: string[];
}

/**
 * Independent verification: the verifier must not be the builder, the hash is
 * recomputed over the canonical serialization, and shape + honesty are re-checked.
 */
export function verifyProofPacket(
  packet: ProofPacket,
  opts: VerifyProofPacketOptions,
): VerifyProofPacketResult {
  const errors: string[] = [];
  if (typeof packet !== "object" || packet === null) {
    return { ok: false, errors: ["packet_not_object"] };
  }
  if (packet.sealedBy === opts.builderIdentity) errors.push("verifier_independent");
  const { proofHash: _omitted, ...rest } = packet;
  try {
    if (sha256Bytes(canonicalJson(rest)) !== packet.proofHash) errors.push("proof_hash_mismatch");
  } catch (e) {
    errors.push(`proof_hash_recompute_failed:${e instanceof Error ? e.message : String(e)}`);
  }
  errors.push(...validateProofPacketShape(packet));
  errors.push(...proofPacketHonestyErrors(packet));
  return { ok: errors.length === 0, errors };
}
