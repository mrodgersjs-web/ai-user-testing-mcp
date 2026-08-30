/**
 * Process-spawner seam — the single point where the runner touches the outside
 * world's process table.
 *
 * This is a documented production interface, not a test toy: `executeRun`
 * spawns ONLY through `ProcessSpawner`, defaulting to `childProcessSpawner()`
 * (real `node:child_process`, execve-style: no shell, argv array, child in its
 * own process group so the whole tree can be killed). Tests inject a fake to
 * stay hermetic and to assert "no spawn happened" on fail-closed refusals.
 *
 * Contract for implementations:
 * - `spawn` must launch `argv[0]` with `argv.slice(1)` as args, NO shell
 *   interpretation, with the given `cwd` and `env` verbatim.
 * - The child MUST be placed in its own process group (detached), and
 *   `killTree` MUST signal that entire group; a straggler grandchild surviving
 *   a wall-clock breach is a sandbox escape.
 * - `exited` resolves exactly once, after stdio streams have closed (so all
 *   output is accounted for against the byte cap before the run is judged).
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface SpawnSpec {
  /** Full command line. argv[0] is the executable; argv must be non-empty. */
  argv: readonly string[];
  /** Working directory for the child (the sandbox worktree). */
  cwd: string;
  /** Complete environment for the child — minimal by construction upstream. */
  env: NodeJS.ProcessEnv;
}

export interface SpawnResult {
  /** Exit code, or null if terminated by signal / failed to spawn. */
  code: number | null;
  /** Terminating signal, if any. */
  signal: NodeJS.Signals | null;
  /** Present when the spawn itself failed (e.g. ENOENT, EACCES). */
  error?: string;
}

export interface SpawnHandle {
  readonly pid: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exited: Promise<SpawnResult>;
  /** Signal the child's whole process group. Safe to call after exit. */
  killTree(signal: NodeJS.Signals): void;
}

export interface ProcessSpawner {
  spawn(spec: SpawnSpec): SpawnHandle;
}

/** Production default: detached real child process, process-group kills. */
export function childProcessSpawner(): ProcessSpawner {
  return {
    spawn({ argv, cwd, env }: SpawnSpec): SpawnHandle {
      const [file, ...rest] = argv;
      if (file === undefined) {
        throw new TypeError("SpawnSpec.argv must be non-empty");
      }
      const child = nodeSpawn(file, [...rest], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let resolveExited!: (r: SpawnResult) => void;
      const exited = new Promise<SpawnResult>((res) => {
        resolveExited = res;
      });
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        resolveExited({ code: null, signal: null, error: err.message });
      });
      // 'close' (not 'exit'): fires once stdio is fully closed, so every
      // output byte has passed through the accumulator before we judge the run.
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        resolveExited({ code, signal });
      });
      return {
        pid: child.pid ?? -1,
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        killTree(signal: NodeJS.Signals): void {
          if (child.pid === undefined) return;
          try {
            // detached:true puts the child in process group -pid.
            process.kill(-child.pid, signal);
          } catch {
            try {
              child.kill(signal);
            } catch {
              /* already dead */
            }
          }
        },
      };
    },
  };
}
