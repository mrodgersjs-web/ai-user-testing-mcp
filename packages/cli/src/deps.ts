/**
 * The CLI's outside world, as one injectable seam object.
 *
 * Every test drives `run()` with fakes: `runCommand` records git/gh/df calls
 * (zero-call assertions are how refusal paths are proven), `fetchImpl` feeds
 * the real GitHubClient without the network, `spawner` stands in for
 * process execution, `buildIndex` counts FTS rebuilds. Defaults bind the real
 * binaries — production behavior and test behavior differ only through this.
 */
import { spawnSync } from "node:child_process";
import { GitHubClient, type CatalogLock } from "@rig-testlab/catalog";
import type { ProcessSpawner, ToolChecker } from "@rig-testlab/runner";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: readonly string[], opts?: { cwd?: string }) => Promise<CommandResult>;

export interface CliDeps {
  /** Full argument vector (without node/executable). */
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Override repo-root discovery (pnpm-workspace.yaml walk-up). */
  root?: string;
  /** git / gh / df runner. Default: spawnSync, no shell. */
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  makeGitHubClient?: (opts: { token?: string; fetchImpl?: typeof fetch }) => GitHubClient;
  spawner?: ProcessSpawner;
  toolChecker?: ToolChecker;
  /** FTS build seam (counts rebuilds in tests). Default: catalog buildFtsIndex. */
  buildIndex?: (lock: CatalogLock, dbPath: string) => number;
  nodeVersion?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** install-global default home. Default: os.homedir(). */
  home?: string;
}

export const defaultRunCommand: CommandRunner = async (argv, opts) => {
  const res = spawnSync(argv[0] ?? "", argv.slice(1), {
    cwd: opts?.cwd,
    encoding: "utf8",
    shell: false,
  });
  if (res.error !== null && res.error !== undefined) {
    return { code: -1, stdout: "", stderr: String(res.error.message ?? res.error) };
  }
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

export const defaultMakeGitHubClient = (opts: { token?: string; fetchImpl?: typeof fetch }): GitHubClient =>
  new GitHubClient({ token: opts.token, fetchImpl: opts.fetchImpl });
