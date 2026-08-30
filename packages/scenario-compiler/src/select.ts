import type { AdoptionTier, Platform, ScenarioSpec } from "@rig-testlab/catalog";
import type { AdapterDescriptor } from "@rig-testlab/catalog";

/**
 * Selection-layer enrichment the wave-2 integration may join from the catalog
 * (CatalogEntry.adoptionTier / target platforms). It is NOT part of the wire
 * AdapterDescriptor schema (additionalProperties:false); compileSuite strips
 * these keys before schema validation. Absent hints collapse to neutral
 * ranking (untiered, platform-neutral).
 */
export interface AdapterSelectionHint {
  adoptionTier?: AdoptionTier;
  platforms?: Platform[];
}

export type SelectableAdapter = AdapterDescriptor & AdapterSelectionHint;

export type SelectionResult = SelectableAdapter | { reason: string };

export const NO_COMPATIBLE_ADAPTER = "no_compatible_adapter";

const TIER_RANK: Record<AdoptionTier, number> = {
  core_runner: 0,
  approved_adapter: 1,
  optional_adapter: 2,
  reference: 3,
  watchlist: 4,
  quarantined: 5
};

/** Untiered adapters rank below every named tier. */
const UNTIERED_RANK = Object.keys(TIER_RANK).length;

function tierRank(adapter: SelectableAdapter): number {
  return adapter.adoptionTier === undefined ? UNTIERED_RANK : (TIER_RANK[adapter.adoptionTier] ?? UNTIERED_RANK);
}

function intersectionSize(declared: readonly string[], wanted: readonly string[]): number {
  let n = 0;
  for (const w of wanted) if (declared.includes(w)) n++;
  return n;
}

/** Candidate must cover at least one required evidence kind (trivially true when none required). */
function evidenceCompatible(spec: ScenarioSpec, adapter: SelectableAdapter): boolean {
  return spec.requiredEvidence.length === 0 || intersectionSize(adapter.evidenceKinds, spec.requiredEvidence) > 0;
}

/** Adapters with no declared platforms are platform-neutral; otherwise intersection is required. */
function platformsCompatible(spec: ScenarioSpec, adapter: SelectableAdapter): boolean {
  return adapter.platforms === undefined || intersectionSize(adapter.platforms, spec.platforms) > 0;
}

/**
 * Pick the execution adapter for a scenario: reviewed-only, id ∈ spec.requiredAdapters,
 * platform- and evidence-compatible. Ranked by adoption tier
 * (core_runner > approved_adapter > optional_adapter > reference > watchlist >
 * quarantined > untiered), then requiredEvidence coverage (desc), then id (asc).
 * Deterministic total order; returns { reason } when nothing qualifies.
 */
export function selectRunner(spec: ScenarioSpec, adapters: readonly SelectableAdapter[]): SelectionResult {
  const candidates = adapters.filter(
    (a) =>
      a.status === "reviewed" &&
      spec.requiredAdapters.includes(a.id) &&
      platformsCompatible(spec, a) &&
      evidenceCompatible(spec, a)
  );
  if (candidates.length === 0) return { reason: NO_COMPATIBLE_ADAPTER };
  const ranked = candidates.map((adapter) => ({
    adapter,
    tier: tierRank(adapter),
    coverage: intersectionSize(adapter.evidenceKinds, spec.requiredEvidence)
  }));
  ranked.sort(
    (x, y) =>
      x.tier - y.tier ||
      y.coverage - x.coverage ||
      (x.adapter.id < y.adapter.id ? -1 : x.adapter.id > y.adapter.id ? 1 : 0)
  );
  return ranked[0]!.adapter;
}
