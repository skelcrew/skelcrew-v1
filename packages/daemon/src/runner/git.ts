/**
 * The runner's git: a thin wrapper over `Bun.spawn`. Every call names the repository it
 * acts on, returns a parsed result, and fails with a `GitError` naming the command, so a
 * failure lands on the card as "what was run" rather than a bare exit code. Injected into
 * the runner so tests can point it at a temp repository or a `PATH` without git.
 */

export class GitError extends Error {
  constructor(args: string[], detail: string) {
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitError";
  }
}

/** One entry of `git worktree list --porcelain`. `branch` is the full ref, or null when detached. */
export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  /** Registered but its directory is gone; `git worktree prune` forgets it. */
  prunable: boolean;
}

export interface Git {
  /**
   * The repo's default branch and its local head: the branch `refs/remotes/origin/HEAD`
   * names when set, else `main`, else `master`. No fetch: the local head is the base.
   * Throws when none of the three exists, or when `origin/HEAD` names a branch with no
   * local head.
   */
  defaultBranch(repoRoot: string): Promise<{ name: string; sha: string }>;
  /** The sha a ref resolves to, or undefined when it does not exist. */
  revParse(repoRoot: string, ref: string): Promise<string | undefined>;
  /** `git branch <name> <base>`. */
  createBranch(repoRoot: string, name: string, base: string): Promise<void>;
  /** `git worktree add <path> <branch>`, for an existing branch. */
  worktreeAdd(repoRoot: string, path: string, branch: string): Promise<void>;
  worktreeList(repoRoot: string): Promise<WorktreeEntry[]>;
  /** `git worktree remove <path>` without `--force`: git itself refuses a dirty worktree. */
  worktreeRemove(repoRoot: string, path: string): Promise<void>;
  /** Forgets registered worktrees whose directories are gone. Touches no directory. */
  worktreePrune(repoRoot: string): Promise<void>;
  /** Every path `git status --porcelain` reports in the worktree, untracked files included. */
  status(worktreePath: string): Promise<string[]>;
}

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const ORIGIN_PREFIX = "refs/remotes/origin/";
const FALLBACK_BRANCHES = ["main", "master"];

/**
 * `git status --porcelain -z`: NUL-terminated `XY <path>` records with the path as it is on
 * disk — no C-quoting of non-ASCII, `"`, or `\` as the line format applies under git's
 * default `core.quotePath`. A rename or copy is followed by one more record holding the
 * original path; the new name is what is listed.
 */
export function parseStatus(porcelain: string): string[] {
  const records = porcelain.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] as string;
    if (record.length === 0) continue;
    paths.push(record.slice(3));
    const xy = record.slice(0, 2);
    if (xy.includes("R") || xy.includes("C")) i += 1;
  }
  return paths;
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: "", branch: null, prunable: false };
      entries.push(current);
    } else if (current === undefined) {
      // Nothing before the first `worktree` line.
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  return entries;
}

export function createGit(options: { env?: Record<string, string | undefined> } = {}): Git {
  const env = options.env ?? process.env;

  async function exec(
    cwd: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["git", ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      // A missing binary or an unusable cwd: spawn itself fails, before git runs.
      throw new GitError(args, error instanceof Error ? error.message : String(error));
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  /** Runs the command and returns stdout; any non-zero exit is a `GitError`. */
  async function run(cwd: string, args: string[]): Promise<string> {
    const { code, stdout, stderr } = await exec(cwd, args);
    if (code !== 0) throw new GitError(args, stderr.trim() || `exit ${code}`);
    return stdout;
  }

  /**
   * Runs a lookup whose exit 1 means "not there" rather than failure (`rev-parse --verify
   * --quiet`, `symbolic-ref --quiet`); any other non-zero exit is a `GitError`.
   */
  async function lookup(cwd: string, args: string[]): Promise<string | undefined> {
    const { code, stdout, stderr } = await exec(cwd, args);
    if (code === 0) return stdout.trim();
    if (code === 1) return undefined;
    throw new GitError(args, stderr.trim() || `exit ${code}`);
  }

  async function revParse(repoRoot: string, ref: string): Promise<string | undefined> {
    return lookup(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  }

  return {
    async defaultBranch(repoRoot) {
      const target = await lookup(repoRoot, ["symbolic-ref", "--quiet", ORIGIN_HEAD]);
      if (target !== undefined) {
        const name = target.startsWith(ORIGIN_PREFIX) ? target.slice(ORIGIN_PREFIX.length) : target;
        const sha = await revParse(repoRoot, `refs/heads/${name}`);
        if (sha === undefined) {
          throw new Error(
            `no base branch: ${ORIGIN_HEAD} names ${name}, which has no local head (main and master are not used when origin/HEAD is set)`,
          );
        }
        return { name, sha };
      }
      for (const name of FALLBACK_BRANCHES) {
        const sha = await revParse(repoRoot, `refs/heads/${name}`);
        if (sha !== undefined) return { name, sha };
      }
      throw new Error(
        `no base branch: ${ORIGIN_HEAD} is not set and neither ${FALLBACK_BRANCHES.join(" nor ")} exists`,
      );
    },

    revParse,

    async createBranch(repoRoot, name, base) {
      await run(repoRoot, ["branch", name, base]);
    },

    async worktreeAdd(repoRoot, path, branch) {
      await run(repoRoot, ["worktree", "add", path, branch]);
    },

    async worktreeList(repoRoot) {
      return parseWorktreeList(await run(repoRoot, ["worktree", "list", "--porcelain"]));
    },

    async worktreeRemove(repoRoot, path) {
      await run(repoRoot, ["worktree", "remove", path]);
    },

    async worktreePrune(repoRoot) {
      await run(repoRoot, ["worktree", "prune"]);
    },

    async status(worktreePath) {
      return parseStatus(
        await run(worktreePath, ["status", "--porcelain", "-z", "--untracked-files=all"]),
      );
    },
  };
}
