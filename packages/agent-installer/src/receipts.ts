/**
 * Receipt + backup-manifest persistence for the installer.
 *
 * receipt.json is InstallReceipt-compatible (Harness/receiptPath/sha256 all
 * present) so it drops straight into ProofPacket.agentInstallReceipts.
 * `sha256` = sha256 over the canonical JSON of the *content* fields
 * (schemaVersion, packageName, version, harness, home, files, configMerges,
 * aliases) with receiptPath/sha256/backupManifestPath excluded — installed
 * locations and timestamps never perturb the content hash, so a no-change
 * reinstall yields a byte-stable sha256.
 *
 * canonicalJson here is a deliberately tiny local implementation (sorted object
 * keys, arrays order-preserving); the evidence package must NOT be imported.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Harness } from "@rig-testlab/catalog";

export interface ReceiptFileEntry {
  dst: string;
  sha256: string;
}

export interface ReceiptConfigEntry {
  file: string;
  marker: string;
  /** False when the installer created the file itself (block == whole file). */
  existedAtInstall: boolean;
}

export interface ReceiptAliasEntry extends ReceiptFileEntry {
  pointsTo: string;
}

/** Content fields that the receipt hash covers. */
export interface ReceiptContent {
  schemaVersion: 1;
  packageName: string;
  version: string;
  harness: Harness;
  home: string;
  files: ReceiptFileEntry[];
  configMerges: ReceiptConfigEntry[];
  aliases: ReceiptAliasEntry[];
}

/** Full receipt.json document: content + location/identity fields. */
export interface InstallReceiptDoc extends ReceiptContent {
  receiptPath: string;
  /** Backup manifest covering every planned path of the apply that wrote this receipt. */
  backupManifestPath: string;
  sha256: string;
}

export interface BackupEntry {
  dst: string;
  existed: boolean;
  /** Content hash of the pre-image; "" when the path did not exist. */
  sha256: string;
  /** On-disk backup copy, or the literal 'absent' for paths that did not exist. */
  backupPath: string | "absent";
}

export interface BackupManifest {
  schemaVersion: 1;
  packageName: string;
  createdAt: string;
  entries: BackupEntry[];
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const child = (v as Record<string, unknown>)[k];
      if (child === undefined) {
        throw new Error(`canonicalJson: undefined value at key "${k}"`);
      }
      out[k] = canonicalize(child);
    }
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new Error("canonicalJson: non-finite number");
  }
  return v;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable content hash of a receipt: canonical JSON of the content fields. */
export function receiptContentHash(content: ReceiptContent): string {
  return sha256Hex(canonicalJson(content));
}

/** receipt.json lives at <receiptDir>/<pkg>/<version>/<harness>/receipt.json. */
export function receiptPathFor(
  receiptDir: string,
  packageName: string,
  version: string,
  harness: Harness,
): string {
  return join(receiptDir, packageName, version, harness, "receipt.json");
}

/** Write receipt.json atomically (tmp + rename) and return the stored document. */
export function writeReceipt(receiptDir: string, content: ReceiptContent, backupManifestPath: string): InstallReceiptDoc {
  const path = receiptPathFor(receiptDir, content.packageName, content.version, content.harness);
  const doc: InstallReceiptDoc = {
    ...content,
    receiptPath: path,
    backupManifestPath,
    sha256: receiptContentHash(content),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
  return doc;
}

export function readReceipt(path: string): InstallReceiptDoc {
  return JSON.parse(readFileSync(path, "utf8")) as InstallReceiptDoc;
}

/** Every receipt for `packageName` under receiptDir (<pkg>/<version>/<harness>/receipt.json). */
export function listReceipts(receiptDir: string, packageName: string): InstallReceiptDoc[] {
  const base = join(receiptDir, packageName);
  let versions: string[];
  try {
    versions = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const docs: InstallReceiptDoc[] = [];
  for (const version of versions.sort()) {
    let harnesses: string[];
    try {
      harnesses = readdirSync(join(base, version), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const harness of harnesses.sort()) {
      try {
        docs.push(readReceipt(join(base, version, harness, "receipt.json")));
      } catch {
        /* missing/corrupt leaf: not part of the managed set */
      }
    }
  }
  return docs;
}

/** Write the BackupManifest JSON atomically (tmp + rename). */
export function writeBackupManifest(path: string, manifest: BackupManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readBackupManifest(path: string): BackupManifest {
  return JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
}
