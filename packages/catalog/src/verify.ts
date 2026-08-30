/**
 * Schema + integrity validation for CatalogLock.
 *
 * validateLock: ajv draft 2020-12 against every repo schema/*.v1.schema.json,
 * formats via ajv-formats, $refs resolved from the schemas dir (registered
 * under both each schema's own $id and every relative base the refs use).
 *
 * verifyLock: integrity beyond the schema — unique ids, pin↔entry agreement,
 * statistics recomputation.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import type { CatalogLock } from "./types.js";
import { schemasDir } from "./lock.js";

// ajv-formats is `module.exports = fn` CJS: NodeNext types the default import
// as the module namespace, but the runtime value is the callable plugin itself.
const addFormats = addFormatsDefault as unknown as (ajv: Ajv2020) => void;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SCHEMA_BASE = "https://rig-testlab.dev/schemas/";

interface LoadedSchema {
  file: string;
  schema: Record<string, unknown>;
  id: string;
}

function loadSchemas(dir: string): LoadedSchema[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((file) => {
      const schema = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      normalizePointerRefs(schema);
      return { file, schema, id: String(schema.$id) };
    });
}

/**
 * The frozen schemas reference pointers as "./X.v1.schema.json/properties/y"
 * (no fragment). URL semantics are identical to "./X.v1.schema.json#/properties/y",
 * but ajv only resolves pointers after "#", so normalize at load time.
 */
function normalizePointerRefs(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizePointerRefs(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const m = /^(\.\/[^#]+\.schema\.json)(\/.+)$/.exec(obj.$ref);
    if (m) obj.$ref = `${m[1]}#${m[2]}`;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "$ref") normalizePointerRefs(v);
  }
}

let cachedAjv: { ajv: Ajv2020; lockValidator: ValidateFunction } | null = null;

function engine(): { ajv: Ajv2020; lockValidator: ValidateFunction } {
  if (cachedAjv) return cachedAjv;
  const dir = schemasDir();
  const loaded = loadSchemas(dir);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  // A ref like "./ProvenanceEdge.v1.schema.json" inside a schema whose $id ends
  // in `…/ProvenanceEdge/v1` (no trailing slash) resolves to the LAST-SEGMENT-
  // RELATIVE url `…/ProvenanceEdge/ProvenanceEdge.v1.schema.json`. Register each
  // stripped clone under every base any sibling actually derives, plus the plain
  // directory URL, so no relative form can miss.
  const altKeys = new Map<string, Set<string>>();
  for (const source of loaded) {
    for (const target of loaded) {
      const resolved = new URL(`./${target.file}`, source.id).toString();
      if (!altKeys.has(target.file)) altKeys.set(target.file, new Set());
      altKeys.get(target.file)!.add(resolved);
      altKeys.get(target.file)!.add(`${SCHEMA_BASE}${target.file}`);
    }
  }
  for (const { file, schema } of loaded) {
    for (const key of altKeys.get(file)!) {
      const clone = structuredClone(schema);
      delete clone.$id;
      ajv.addSchema(clone, key);
    }
  }
  for (const { schema, id } of loaded) ajv.addSchema(schema, id);

  const lockValidator = ajv.getSchema(`${SCHEMA_BASE}CatalogLock/v1`);
  if (!lockValidator) throw new Error("CatalogLock/v1 schema not found in schemas dir");
  cachedAjv = { ajv, lockValidator };
  return cachedAjv;
}

/** Schema validation (draft 2020-12, all schemas registered, formats enforced). */
export function validateLock(lock: unknown): ValidationResult {
  const { lockValidator } = engine();
  const ok = lockValidator(lock) as boolean;
  const errors = (lockValidator.errors ?? []).map(
    (e) => `${e.instancePath || "/"}: ${e.message}${e.params?.allowedValues ? ` (allowed: ${(e.params.allowedValues as unknown[]).join("|")})` : ""}`,
  );
  return { ok, errors };
}

/** Integrity checks the schema cannot express. */
export function verifyLock(lock: CatalogLock): ValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of lock.entries) {
    if (ids.has(e.id)) errors.push(`duplicate entry id ${e.id}`);
    ids.add(e.id);
    if (e.targetKind === "git_repo" && !e.repository) errors.push(`${e.id}: git_repo without repository`);
    if (!e.provenance.some((p) => p.depth === 1 || p.depth === 2)) errors.push(`${e.id}: no provenance depth`);
  }
  const pinIds = new Set<string>();
  const paths = new Set<string>();
  for (const p of lock.pins) {
    if (pinIds.has(p.entryId)) errors.push(`duplicate pin for ${p.entryId}`);
    pinIds.add(p.entryId);
    if (paths.has(p.submodulePath)) errors.push(`duplicate submodulePath ${p.submodulePath}`);
    paths.add(p.submodulePath);
    const entry = lock.entries.find((e) => e.id === p.entryId);
    if (!entry) errors.push(`pin ${p.entryId} references missing entry`);
    else if (!entry.repository) errors.push(`pin ${p.entryId} but entry has no repository`);
    else if (entry.repository.commitSha !== p.commitSha) errors.push(`pin/entry sha mismatch ${p.entryId}`);
  }
  for (const e of lock.entries) {
    if (e.repository && !pinIds.has(e.id)) errors.push(`${e.id}: repository without pin`);
  }
  const firstLevel = lock.entries.filter((e) => e.provenance.some((p) => p.depth === 1)).length;
  if (lock.statistics.firstLevelCount !== firstLevel) errors.push("statistics.firstLevelCount mismatch");
  if (lock.statistics.uniqueRepos !== lock.pins.length) errors.push("statistics.uniqueRepos mismatch");
  return { ok: errors.length === 0, errors };
}
