import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** sha256 over raw bytes, lowercase hex. */
export function sha256Bytes(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 of a file's full contents, lowercase hex. */
export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

/**
 * Deterministic JSON serialization (canonical form used for all hash binding):
 * - object keys sorted recursively (lexicographic by UTF-16 code unit);
 * - array order preserved;
 * - undefined object properties omitted (JSON parity);
 * - NaN/Infinity, functions, symbols, bigints, circular refs rejected.
 */
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value, new Set<object>());
}

function stringifyCanonical(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
      }
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson: BigInt is not serializable");
    case "undefined":
    case "function":
    case "symbol":
      throw new TypeError(`canonicalJson: ${typeof value} is not serializable`);
  }
  if (seen.has(value as object)) {
    throw new TypeError("canonicalJson: circular reference rejected");
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      // Stable array order: serialize elements as given, no reordering.
      const items: string[] = [];
      for (const item of value) {
        // JSON turns in-array undefined/null holes into null; reject instead of silently coercing.
        items.push(stringifyCanonical(item, seen));
      }
      return `[${items.join(",")}]`;
    }
    if (value instanceof Map || value instanceof Set || value instanceof Date) {
      throw new TypeError(
        `canonicalJson: ${value.constructor?.name ?? "non-plain object"} rejected — convert to plain JSON first`,
      );
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue; // JSON parity: undefined members are dropped
      parts.push(`${JSON.stringify(key)}:${stringifyCanonical(member, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value as object);
  }
}
