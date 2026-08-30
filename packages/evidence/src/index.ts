export { canonicalJson, sha256Bytes, sha256File } from "./hashing.js";
export { redactText } from "./redact.js";
export type { RedactResult } from "./redact.js";
export { sealReceipt, validateArtifactReceiptShape, verifyReceipt } from "./receipts.js";
export type { SealReceiptOptions } from "./receipts.js";
export {
  proofPacketHonestyErrors,
  sealProofPacket,
  validateProofPacketShape,
  verifyProofPacket,
} from "./proofpacket.js";
export type {
  SealProofPacketResult,
  VerifyProofPacketOptions,
  VerifyProofPacketResult,
} from "./proofpacket.js";

// Type-only from catalog by design (Main steering 2026-08-30): this package
// carries zero runtime deps; NON_PASSING_STATES is re-exported by
// @rig-testlab/catalog itself.
export type { ArtifactKind, ArtifactReceipt, ProofPacket, RunManifest, RunState } from "@rig-testlab/catalog";
