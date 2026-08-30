/**
 * Adapter registry loading. Convention (owned by adapters/**): each adapter
 * lives at <adaptersDir>/<id>/adapter.json containing EXACTLY the
 * AdapterDescriptor wire shape; dir name must equal descriptor.id.
 *
 * loadAdapters never trusts a file: JSON parse + ajv wire-schema validation +
 * dir-name===id check, with per-file violations reported, not swallowed.
 * Selection hints (adoptionTier) are joined from the catalog lock when given —
 * hints live outside the wire shape and compileSuite strips them anyway.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterDescriptor, CatalogEntry } from "@rig-testlab/catalog";
import { getValidator, type SelectableAdapter } from "@rig-testlab/scenario-compiler";

export interface LoadedAdapter {
  dir: string;
  /** Present only when JSON parse + wire-schema validation + name check all passed. */
  descriptor?: AdapterDescriptor;
  errors: string[];
}

export interface AdapterRegistry {
  adapters: LoadedAdapter[];
  /** True when every discovered adapter.json parsed, validated, and matched its dir name. */
  ok: boolean;
}

export function loadAdapters(adaptersDir: string): AdapterRegistry {
  if (!existsSync(adaptersDir)) {
    return { adapters: [], ok: false };
  }
  const validate = getValidator("AdapterDescriptor.v1.schema.json");
  const adapters: LoadedAdapter[] = [];
  for (const dir of readdirSync(adaptersDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(adaptersDir, dir.name, "adapter.json");
    if (!existsSync(file)) continue;
    const errors: string[] = [];
    let descriptor: AdapterDescriptor | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (validate(parsed)) descriptor = parsed as AdapterDescriptor;
      else {
        for (const e of validate.errors ?? []) {
          errors.push(`${dir.name}/adapter.json ${e.instancePath || "/"}: ${e.message}`);
        }
      }
    } catch (err) {
      errors.push(`${dir.name}/adapter.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (descriptor !== undefined && descriptor.id !== dir.name) {
      errors.push(`${dir.name}/adapter.json: descriptor id "${descriptor.id}" !== directory name "${dir.name}"`);
    }
    adapters.push({ dir: dir.name, ...(descriptor === undefined ? {} : { descriptor }), errors });
  }
  return { adapters, ok: adapters.every((a) => a.errors.length === 0) };
}

/** Wire descriptors + catalog-joined selection hints, ready for compileSuite/selectRunner. */
export function selectableAdapters(registry: AdapterRegistry, entries: readonly CatalogEntry[]): SelectableAdapter[] {
  const out: SelectableAdapter[] = [];
  for (const loaded of registry.adapters) {
    const descriptor = loaded.descriptor;
    if (descriptor === undefined) continue;
    const entry = entries.find((e) => e.id === descriptor.sourceEntryId);
    const hints = entry === undefined ? {} : { adoptionTier: entry.adoptionTier };
    out.push({ ...descriptor, ...hints });
  }
  return out;
}

/** Validated descriptors only; callers refusing on registry.ok === false never reach this. */
export function reviewedDescriptors(registry: AdapterRegistry): AdapterDescriptor[] {
  return registry.adapters.flatMap((a) => (a.descriptor === undefined ? [] : [a.descriptor]));
}
