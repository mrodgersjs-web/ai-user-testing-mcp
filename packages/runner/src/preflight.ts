/**
 * Fail-closed preflight: every gate here runs BEFORE any process is spawned.
 * A refusal is a normal result — `ok:false` with a stable `reason` code that
 * callers map onto a RunManifest `blocked` state (blocked is never `passed`).
 *
 * Check order (cheapest/most-static first; first refusal wins):
 *  1. adapter_not_reviewed — only reviewed adapters execute, defense in depth.
 *  2. command_not_allowlisted — argv must prefix-match commandAllowlist.
 *  3. path_escape_denied — argv arguments must not name absolute paths
 *     outside the sandbox base (the worktree/home live inside it).
 *  4. network_not_declared — an empty networkAllowlist means NO egress; any
 *     egress intent in argv/inputs is refused.
 *  5. dependency_unavailable — the executable (and ctx.requireBinaries) must
 *     resolve on disk (ToolChecker).
 *  6. credential_missing — keychain/env_store adapters must resolve a
 *     non-empty credential via CredentialResolver. The value is never
 *     returned in the result, logged, or placed in argv — only in the child
 *     env by executeRun.
 *  7. credit_budget_exceeded — paid providers: estimated spend must be known
 *     and within min(adapter.paidGuards, scenario budget). Unknown spend on a
 *     paid adapter is refused (fail-closed).
 *  8. target_missing — caller-provided target existence hook.
 *
 * Everything is synchronous by contract (`preflight(adapter, argv, ctx)`
 * returns the result object directly); injected hooks are sync too.
 */
import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { AdapterDescriptor } from "@rig-testlab/catalog";

export type BlockedReason =
  | "adapter_not_reviewed"
  | "command_not_allowlisted"
  | "path_escape_denied"
  | "network_not_declared"
  | "dependency_unavailable"
  | "credential_missing"
  | "credit_budget_exceeded"
  | "target_missing";

export type PreflightResult = { ok: true } | { ok: false; reason: BlockedReason };

/** Resolve a credential by name; return null/undefined/'' when unavailable. Must not throw for "missing". */
export type CredentialResolver = (name: string) => string | null | undefined;

/** Report whether an external binary is present/executable. */
export type ToolChecker = (bin: string) => boolean;

/** Caller-provided target existence probe (e.g. repo cloned, site reachable). */
export type TargetProbe = () => boolean;

export interface PreflightContext {
  /** Sandbox base dir; the run's home+worktree are created under it. Arguments may only name absolute paths inside it. */
  baseDir?: string;
  /** Extra non-argv inputs (scenario URLs, endpoints) scanned for egress intent. */
  inputs?: readonly string[];
  /** Estimated credit spend for THIS run (from the compiled manifest). */
  estimatedCredits?: number;
  /** Scenario budget ceiling; combined with adapter.paidGuards via Math.min. */
  scenarioMaxCredits?: number;
  /** External binaries beyond argv[0] that must exist. */
  requireBinaries?: readonly string[];
  /** Target existence hook; refusal reason: target_missing. */
  targetExists?: TargetProbe;
  credentialResolver?: CredentialResolver;
  toolChecker?: ToolChecker;
  /** Env seen by the default credential resolver / tool checker. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Convention env-var name under which a resolved adapter credential is surfaced to the child. */
export function credentialEnvVarName(adapterId: string): string {
  return `RIG_TESTLAB_${adapterId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

/** Default resolver: read the named env var. Never logs or returns metadata about the value. */
export function envCredentialResolver(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Default ToolChecker: execve-style lookup (absolute path check, else PATH scan). */
export function defaultToolChecker(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const parts = (env.PATH ?? "/usr/bin:/bin").split(":");
  for (const dir of parts) {
    if (dir.length === 0) continue;
    try {
      accessSync(resolve(dir, bin), constants.X_OK);
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

export function isCommandAllowlisted(
  argv: readonly string[],
  allowlist: readonly (readonly string[])[],
): boolean {
  if (argv.length === 0) return false;
  return allowlist.some(
    (prefix) =>
      prefix.length > 0 &&
      prefix.length <= argv.length &&
      prefix.every((tok, i) => argv[i] === tok),
  );
}

/**
 * Absolute-path escape detector. argv[0] is exempt (it is the allowlisted
 * executable itself). Argument tokens that ARE an absolute path, or embed one
 * after '=' or ':' (e.g. `--out=/etc/shadow`, `--dir:/etc`), must resolve to
 * or under one of `allowRoots`. Returns the offending token, else null.
 *
 * Relative paths are resolved by the child's cwd (the worktree); relative
 * `..` traversal is contained by the sandbox design (home/worktree/base are
 * ephemeral) and by OS-level hardening, not by this guard.
 */
export function findPathEscape(
  argv: readonly string[],
  allowRoots: readonly string[],
): string | null {
  for (const tok of argv.slice(1)) {
    const candidate = absolutePathCandidate(tok);
    if (candidate === null) continue;
    const r = resolve(candidate);
    const inside = allowRoots.some((root) => {
      const rr = resolve(root);
      return r === rr || r.startsWith(rr.endsWith(sep) ? rr : rr + sep);
    });
    if (!inside) return tok;
  }
  return null;
}

function absolutePathCandidate(tok: string): string | null {
  if (tok.startsWith("/")) return tok;
  const eq = tok.indexOf("=/");
  if (eq >= 0) return tok.slice(eq + 1);
  const co = tok.indexOf(":/");
  // '://' is a URL scheme (handled by the egress gate), ':' + '/' is a path.
  if (co > 0 && tok[co + 2] !== "/") return tok.slice(co + 1);
  return null;
}

const NETWORK_BINARIES: Readonly<Record<string, true>> = {
  curl: true,
  wget: true,
  http: true,
  https: true,
  nc: true,
  ncat: true,
  netcat: true,
  ping: true,
  dig: true,
  nslookup: true,
  drill: true,
  ssh: true,
  scp: true,
  sftp: true,
  telnet: true,
  ftp: true,
  rsync: true,
  "git-remote-https": true,
};

const EGRESS_FLAGS: Readonly<Record<string, true>> = {
  "--url": true,
  "--base-url": true,
  "--baseurl": true,
  "--endpoint": true,
  "--api-base": true,
  "--api_base": true,
  "--api-base-url": true,
  "--host": true,
  "--server": true,
  "--remote": true,
  "--registry": true,
  "--upstream": true,
  "--proxy": true,
};

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function tokenSuggestsEgress(tok: string): boolean {
  if (URL_SCHEME_RE.test(tok) && !/^file:\/\//i.test(tok)) return true;
  const flag = (tok.split(/=/, 1)[0] ?? tok).toLowerCase();
  if (flag in EGRESS_FLAGS) return true;
  // URL embedded mid-token, e.g. `repo=git+https://…`
  return tok.includes("://") && !/file:\/\//i.test(tok);
}

/** Heuristic egress-intent detector over argv + extra input tokens. */
export function detectEgressIntent(
  argv: readonly string[],
  extraInputs: readonly string[] = [],
): boolean {
  const first = argv[0];
  if (first !== undefined) {
    const base = first.slice(first.lastIndexOf("/") + 1);
    if (base in NETWORK_BINARIES) return true;
  }
  for (const tok of argv.slice(1)) {
    if (tokenSuggestsEgress(tok)) return true;
  }
  for (const input of extraInputs) {
    if (tokenSuggestsEgress(input)) return true;
  }
  return false;
}

/** Hosts named by URL-shaped tokens — recorded into manifest.networkUsed. */
export function extractEgressHosts(
  argv: readonly string[],
  extraInputs: readonly string[] = [],
): string[] {
  const hosts = new Set<string>();
  const visit = (tok: string): void => {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/?#:]+)/i.exec(tok);
    if (m?.[1] && !/^file:/i.test(tok)) hosts.add(m[1]);
  };
  for (const tok of argv) visit(tok);
  for (const input of extraInputs) visit(input);
  return [...hosts];
}

/** All fail-closed gates, before any spawn. Synchronous by contract. */
export function preflight(
  adapter: AdapterDescriptor,
  argv: readonly string[],
  ctx: PreflightContext = {},
): PreflightResult {
  const blocked = (reason: BlockedReason): PreflightResult => ({ ok: false, reason });

  if (adapter.status !== "reviewed") return blocked("adapter_not_reviewed");

  if (!isCommandAllowlisted(argv, adapter.commandAllowlist)) {
    return blocked("command_not_allowlisted");
  }

  const escape = findPathEscape(argv, [ctx.baseDir ?? resolve(".")]);
  if (escape !== null) return blocked("path_escape_denied");

  if (
    adapter.networkAllowlist.length === 0 &&
    detectEgressIntent(argv, ctx.inputs)
  ) {
    return blocked("network_not_declared");
  }

  const checkTool = ctx.toolChecker ?? ((b: string) => defaultToolChecker(b, ctx.env));
  const first = argv[0];
  if (first === undefined || !checkTool(first)) return blocked("dependency_unavailable");
  for (const bin of ctx.requireBinaries ?? []) {
    if (!checkTool(bin)) return blocked("dependency_unavailable");
  }

  if (adapter.credentialMode === "keychain" || adapter.credentialMode === "env_store") {
    const name = credentialEnvVarName(adapter.id);
    const resolve =
      ctx.credentialResolver ?? ((n: string) => envCredentialResolver(n, ctx.env));
    const value = resolve(name);
    // Presence check only — the value is never stored on the result or logged.
    if (value === null || value === undefined || value.length === 0) {
      return blocked("credential_missing");
    }
  }

  if (adapter.paidProvider) {
    const adapterCeiling = adapter.paidGuards?.maxEstimatedCredits;
    const ceiling =
      adapterCeiling === undefined && ctx.scenarioMaxCredits === undefined
        ? Number.POSITIVE_INFINITY
        : Math.min(adapterCeiling ?? Number.POSITIVE_INFINITY, ctx.scenarioMaxCredits ?? Number.POSITIVE_INFINITY);
    const spend = ctx.estimatedCredits ?? Number.POSITIVE_INFINITY;
    // Fail-closed: no declared ceiling, or unknown/unbounded spend, or over budget.
    if (!Number.isFinite(ceiling) || spend > ceiling) {
      return blocked("credit_budget_exceeded");
    }
  }

  if (ctx.targetExists !== undefined && !ctx.targetExists()) {
    return blocked("target_missing");
  }

  return { ok: true };
}
