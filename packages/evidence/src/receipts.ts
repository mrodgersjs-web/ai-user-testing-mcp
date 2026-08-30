import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactKind, ArtifactReceipt } from "@rig-testlab/catalog";
import { sha256Bytes } from "./hashing.js";
import { redactText } from "./redact.js";

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Binary kinds are stored byte-identical; redacted=false is legal ONLY for these.
// Every other kind is text-like and must be redacted before persistence.
const BINARY_KINDS: readonly ArtifactKind[] = ["screenshot", "video"];

const KIND_SET: Record<ArtifactKind, true> = {
  screenshot: true,
  video: true,
  rrweb: true,
  console_network_trace: true,
  accessibility_tree: true,
  model_transcript: true,
  log: true,
  json_report: true,
};

const RECEIPT_KEYS: Record<string, true> = {
  id: true,
  runId: true,
  kind: true,
  path: true,
  sha256: true,
  sizeBytes: true,
  capturedAt: true,
  redacted: true,
};

/** Structural check mirroring schemas/ArtifactReceipt.v1.schema.json (no ajv in this package). */
export function validateArtifactReceiptShape(receipt: ArtifactReceipt): string[] {
  const errors: string[] = [];
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
    return ["receipt_not_object"];
  }
  const r = receipt as unknown as Record<string, unknown>;
  for (const key of Object.keys(RECEIPT_KEYS)) {
    if (r[key] === undefined) errors.push(`missing_${key}`);
  }
  for (const key of Object.keys(r)) {
    if (!(key in RECEIPT_KEYS)) errors.push(`unknown_field_${key}`);
  }
  if (typeof r.id === "string" && !ID_RE.test(r.id)) errors.push("id_pattern");
  if (typeof r.runId === "string" && !ID_RE.test(r.runId)) errors.push("runId_pattern");
  if (typeof r.kind === "string" && !(r.kind in KIND_SET)) errors.push("kind_enum");
  if (typeof r.path === "string") {
    if (r.path.length === 0) errors.push("path_empty");
    if (isAbsolute(r.path)) errors.push("path_absolute");
    if (r.path.split(/[\\/]/).includes("..")) errors.push("path_traversal");
  }
  if (typeof r.sha256 === "string" && !SHA256_RE.test(r.sha256)) errors.push("sha256_pattern");
  if (r.sizeBytes !== undefined && !(Number.isInteger(r.sizeBytes) && (r.sizeBytes as number) >= 0)) {
    errors.push("sizeBytes_invalid");
  }
  if (typeof r.capturedAt === "string" && !(DATE_TIME_RE.test(r.capturedAt) && !Number.isNaN(Date.parse(r.capturedAt)))) {
    errors.push("capturedAt_format");
  }
  if (r.redacted !== undefined && typeof r.redacted !== "boolean") errors.push("redacted_type");
  return errors;
}

/** True when `candidate` escapes `root` (relative walk-out or different absolute root). */
function escapesRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function deriveArtifactId(srcPath: string): string {
  const cleaned = basename(srcPath).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return /^[a-z0-9]/.test(cleaned) ? cleaned : `a${cleaned}`;
}

export interface SealReceiptOptions {
  runId: string;
  kind: ArtifactKind;
  storeRoot: string;
  srcPath: string;
  /** Artifact id; defaults to the sanitized source basename. */
  id?: string;
  capturedAt?: string;
}

/**
 * Persist one artifact under storeRoot/runs/<runId>/artifacts/<id>-<basename>,
 * redacting text-like content BEFORE the stored-bytes hash. srcPath may be any
 * readable file (sandbox runners seal from ephemeral worktrees deleted after);
 * containment is enforced on the STORAGE TARGET — nothing may be written
 * outside storeRoot. Throws on traversal-shaped ids or a receipt shape the
 * schema would reject.
 */
export async function sealReceipt(options: SealReceiptOptions): Promise<ArtifactReceipt> {
  const { runId, kind, storeRoot, srcPath } = options;
  const id = options.id ?? deriveArtifactId(srcPath);
  if (!ID_RE.test(runId)) throw new TypeError(`sealReceipt: invalid runId ${JSON.stringify(runId)}`);
  if (!ID_RE.test(id)) throw new TypeError(`sealReceipt: invalid artifact id ${JSON.stringify(id)}`);
  if (!(kind in KIND_SET)) throw new TypeError(`sealReceipt: unknown artifact kind ${JSON.stringify(kind)}`);

  const rootAbs = resolve(storeRoot);
  const srcAbs = resolve(srcPath);

  const targetRel = `runs/${runId}/artifacts/${id}-${basename(srcAbs)}`;
  const targetAbs = resolve(rootAbs, targetRel);
  if (escapesRoot(targetAbs, rootAbs)) {
    throw new TypeError(`sealReceipt: target escapes store root: ${targetRel}`);
  }

  const raw = await readFile(srcAbs);
  let stored: Uint8Array;
  let redacted: boolean;
  if (BINARY_KINDS.includes(kind)) {
    stored = raw;
    redacted = false;
  } else {
    stored = new TextEncoder().encode(redactText(raw.toString("utf8")).text);
    redacted = true;
  }

  await mkdir(dirname(targetAbs), { recursive: true });
  await writeFile(targetAbs, stored);

  const receipt: ArtifactReceipt = {
    id,
    runId,
    kind,
    path: targetRel,
    sha256: sha256Bytes(stored),
    sizeBytes: stored.byteLength,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    redacted,
  };
  const errors = validateArtifactReceiptShape(receipt);
  if (errors.length > 0) {
    throw new TypeError(`sealReceipt: receipt rejected: ${errors.join(", ")}`);
  }
  return receipt;
}

/**
 * Independently re-check a receipt against the store: shape, containment,
 * existence, byte hash, size, and redaction-flag/kind consistency. Any failure
 * (tampered, missing, inconsistent) returns false — never throws.
 */
export function verifyReceipt(receipt: ArtifactReceipt, storeRoot: string): boolean {
  if (validateArtifactReceiptShape(receipt).length > 0) return false;
  const rootAbs = resolve(storeRoot);
  const targetAbs = resolve(rootAbs, receipt.path);
  if (escapesRoot(targetAbs, rootAbs)) return false;
  let bytes: Buffer;
  try {
    bytes = readFileSync(targetAbs);
  } catch {
    return false;
  }
  if (sha256Bytes(bytes) !== receipt.sha256) return false;
  if (bytes.byteLength !== receipt.sizeBytes) return false;
  const binary = BINARY_KINDS.includes(receipt.kind);
  if (binary ? receipt.redacted : !receipt.redacted) return false;
  return true;
}
