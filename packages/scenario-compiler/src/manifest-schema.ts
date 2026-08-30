import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

/**
 * Frozen contracts live in <repoRoot>/schemas/*.v1.schema.json. The repo root
 * is resolved by walking up from this module until pnpm-workspace.yaml is
 * found — no hardcoded absolute paths.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no pnpm-workspace.yaml found walking up from ${startDir}`);
    }
    dir = parent;
  }
}

export const SCHEMA_FILES = [
  "RunManifest.v1.schema.json",
  "ArtifactReceipt.v1.schema.json",
  "ScenarioSpec.v1.schema.json",
  "AdapterDescriptor.v1.schema.json",
  "ProjectManifest.v1.schema.json"
] as const;

export type SchemaName = (typeof SCHEMA_FILES)[number];

/** RFC 3339 date-time; registered manually so ajv-formats is not required. */
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function loadSchemas(): Map<SchemaName, AnySchemaObject> {
  const root = findRepoRoot(import.meta.dirname);
  const docs = new Map<SchemaName, AnySchemaObject>();
  for (const file of SCHEMA_FILES) {
    docs.set(file, JSON.parse(readFileSync(join(root, "schemas", file), "utf8")) as AnySchemaObject);
  }
  return docs;
}

function buildAjv(docs: Map<SchemaName, AnySchemaObject>): Ajv2020 {
  const ajv = new Ajv2020();
  ajv.addFormat("date-time", { type: "string", validate: (s: string) => DATE_TIME_RE.test(s) });

  const registered = new Set<string>();
  for (const doc of docs.values()) {
    ajv.addSchema(structuredClone(doc));
    registered.add(String(doc["$id"]));
  }

  // Schemas reference siblings relatively ("./ArtifactReceipt.v1.schema.json").
  // Relative $refs resolve against the referencing schema's $id, which does
  // not always equal the target's own $id (e.g. .../RunManifest/v1 + "./x" →
  // .../ArtifactReceipt.v1.schema.json). Register alias ids for every such
  // resolved URI so cross-file and fragment refs resolve fail-closed.
  for (const doc of docs.values()) {
    for (const file of SCHEMA_FILES) {
      const resolved = new URL(`./${file}`, String(doc["$id"])).href;
      if (registered.has(resolved)) continue;
      const target = docs.get(file as SchemaName);
      if (target === undefined) continue;
      ajv.addSchema({ ...structuredClone(target), $id: resolved });
      registered.add(resolved);
    }
  }
  return ajv;
}

const docs = loadSchemas();
let ajvInstance: Ajv2020 | undefined;
const validatorCache = new Map<SchemaName, ValidateFunction>();

export function getValidator(name: SchemaName): ValidateFunction {
  const cached = validatorCache.get(name);
  if (cached !== undefined) return cached;
  ajvInstance ??= buildAjv(docs);
  const validate = ajvInstance.getSchema(String(docs.get(name)!["$id"]));
  if (validate === undefined) throw new Error(`schema ${name} failed to register`);
  validatorCache.set(name, validate);
  return validate;
}

/** JSON-pointer token escaping (RFC 6901). */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** JSON pointer of the first ajv violation (appending the missing property for `required` errors). */
export function firstViolationPointer(errors: readonly ErrorObject[] | null | undefined): string {
  const err = errors?.[0];
  if (err === undefined) return "#";
  const missing = (err.params as Record<string, unknown> | undefined)?.["missingProperty"];
  if (typeof missing === "string") {
    return `${err.instancePath}/${escapePointerToken(missing)}`;
  }
  return err.instancePath === "" ? "#" : err.instancePath;
}
