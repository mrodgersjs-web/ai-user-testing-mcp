/**
 * Canonical TS models mirroring schemas/*.v1.schema.json (draft 2020-12).
 * The JSON Schemas are the wire contract; these types are the in-memory shape.
 * Drift between the two is a build bug — tests assert enum parity.
 */

export type TargetKind =
  | "git_repo"
  | "github_org"
  | "github_user"
  | "website"
  | "saas"
  | "book"
  | "training"
  | "blog"
  | "newsletter"
  | "awesome_list"
  | "other";

export type ResolutionStatus =
  | "active"
  | "redirected"
  | "rate_limited"
  | "blocked_by_provider"
  | "dead"
  | "unresolved"
  | "quarantined";

export type AdoptionTier =
  | "core_runner"
  | "approved_adapter"
  | "optional_adapter"
  | "reference"
  | "watchlist"
  | "quarantined";

export type ExecutionPolicy = "allowlisted" | "sandbox_required" | "reference_only";

export type LicenseKind =
  | "permissive"
  | "weak_permissive"
  | "copyleft"
  | "restrictive"
  | "missing"
  | "unknown";

export type CredentialRequirement = "none" | "free_account" | "paid" | "commercial_license";

export type ValidationMethod = "github_api" | "http_get" | "http_head_confirmed" | "manual";

export interface ProvenanceEdge {
  sourceCatalogId: string;
  depth: 1 | 2;
  catalogCommit: string;
  urlAsLinked: string;
  discoveredAt: string;
}

export interface RepositoryRef {
  owner: string;
  name: string;
  defaultBranch: string;
  commitSha: string;
  submodulePath: string;
  reportedSizeKb: number;
}

export interface LicenseInfo {
  spdx: string | null;
  kind: LicenseKind;
  notice?: string;
}

export interface LastValidation {
  at: string;
  method: ValidationMethod;
  httpStatus?: number;
  notes?: string;
}

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
  at?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  categories: string[];
  capabilities: string[];
  canonicalUrl: string;
  targetKind: TargetKind;
  description: string;
  provenance: ProvenanceEdge[];
  repository?: RepositoryRef;
  license: LicenseInfo;
  credentialRequirement: CredentialRequirement;
  lastValidation: LastValidation;
  redirectHistory: RedirectHop[];
  adoptionTier: AdoptionTier;
  executionPolicy: ExecutionPolicy;
  resolutionStatus: ResolutionStatus;
}

export type PinState = "pinned" | "pending" | "failed" | "skipped_nonrepo";

export interface SourcePin {
  entryId: string;
  repoUrl: string;
  owner: string;
  name: string;
  defaultBranch: string;
  commitSha: string;
  submodulePath: string;
  gitmodulesName: string;
  shallowCapable: boolean;
  reportedSizeKb: number;
  pinState: PinState;
  lastHydratedAt?: string | null;
}

export type AdapterStatus = "reviewed" | "experimental" | "retired";

export interface AdapterLimits {
  maxCpuMs: number;
  maxMemoryMb: number;
  maxWallClockS: number;
  maxOutputBytes: number;
}

export interface ArtifactKindDef {
  kind: ArtifactKind;
}

export type ArtifactKind =
  | "screenshot"
  | "video"
  | "rrweb"
  | "console_network_trace"
  | "accessibility_tree"
  | "model_transcript"
  | "log"
  | "json_report";

export interface AdapterDescriptor {
  id: string;
  name: string;
  adapterVersion: string;
  sourceEntryId: string;
  status: AdapterStatus;
  commandAllowlist: string[][];
  networkAllowlist: string[];
  limits: AdapterLimits;
  credentialMode: "none" | "keychain" | "env_store";
  paidProvider: boolean;
  paidGuards?: { maxScenarios: number; maxEstimatedCredits: number };
  fixtures: { passing: string; plantedFailing: string; unavailableDependency: string };
  evidenceKinds: ArtifactKind[];
}

export type Platform =
  | "web"
  | "ios"
  | "android"
  | "api"
  | "data"
  | "ai"
  | "vision"
  | "accessibility"
  | "security"
  | "longitudinal";

export interface ScenarioSpec {
  id: string;
  project: string;
  platforms: Platform[];
  title: string;
  persona?: string;
  steps: Array<{ action: string; target?: string; expected: string }>;
  requiredAdapters: string[];
  requiredEvidence: ArtifactKind[];
  budget?: { maxScenarios?: number; maxEstimatedCredits?: number };
}

export type RunState =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "not_evaluated"
  | "cancelled";

/** States that must never be counted as passed in any aggregate. */
export const NON_PASSING_STATES: readonly RunState[] = [
  "queued",
  "running",
  "failed",
  "blocked",
  "not_evaluated",
  "cancelled"
];

export interface SandboxRecord {
  homeDir: string;
  worktree: string;
  readOnlySource: boolean;
  limitsApplied: boolean;
}

export interface CommandRecord {
  argv: string[];
  exitCode: number | null;
  startedAt?: string;
  finishedAt?: string;
}

export interface ArtifactReceipt {
  id: string;
  runId: string;
  kind: ArtifactKind;
  path: string;
  sha256: string;
  sizeBytes: number;
  capturedAt: string;
  redacted: boolean;
}

export interface RunManifest {
  runId: string;
  scenarioId: string;
  adapterId: string;
  sandbox: SandboxRecord;
  state: RunState;
  startedAt: string | null;
  finishedAt: string | null;
  commands: CommandRecord[];
  networkUsed: string[];
  credits: { estimated: number; consumed: number };
  failureDetail?: string | null;
  artifacts: ArtifactReceipt[];
  redactionApplied: boolean;
}

export type Harness = "codex" | "claude" | "hermes" | "omp" | "orca" | "prime";

export interface InstallReceipt {
  harness: Harness;
  receiptPath: string;
  sha256: string;
}

export interface ProofPacket {
  schemaVersion: 1;
  claim: string;
  repoCommit: string;
  catalogHash: string;
  sourcePinHash: string;
  tests: Array<{ name: string; command: string; exitCode: number; summary: string }>;
  agentInstallReceipts: InstallReceipt[];
  transformfitSmoke: {
    compiled: boolean;
    representativeRuns: Array<{ platform: string; runId: string; state: RunState }>;
  };
  remoteVerification: {
    remoteUrl: string;
    remoteMain: string;
    localHead: string;
    equal: true;
    privateVerified: true;
  };
  sealedAt: string;
  sealedBy: string;
  proofHash: string;
}

export interface NestedCatalogRef {
  id: string;
  url: string;
  commit: string;
  status: ResolutionStatus;
  expandedLinkCount: number;
  discoveredCatalogCount: number;
}

export interface CatalogLock {
  schemaVersion: 1;
  generatedFrom: {
    repo: "TheJambo/awesome-testing";
    commit: "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93";
    readmeSha256: string;
  };
  nestedCatalogs: NestedCatalogRef[];
  entries: CatalogEntry[];
  pins: SourcePin[];
  statistics: {
    firstLevelCount: number;
    uniqueRepos: number;
    byResolutionStatus: Partial<Record<ResolutionStatus, number>>;
    byAdoptionTier: Partial<Record<AdoptionTier, number>>;
  };
}
