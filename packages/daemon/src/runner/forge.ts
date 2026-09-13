/**
 * The runner's forge: `gh`, wrapped the way `git.ts` wraps git — one `Bun.spawn` per call with
 * an argv array (no shell), run in the repository, returning a parsed answer. Read-only: the
 * two commands here view a pull request and view the repository, and nothing else is ever run.
 * The daemon holds no credential for the forge; `gh` uses the owner's own login, the way the
 * agent already does.
 *
 * Where `git.ts` throws, this returns `undefined`: "cannot answer" is the ordinary case here —
 * `gh` may be absent or not logged in, and the URL may not be a pull request at all — and a
 * card in PR simply stays in PR until it can be answered. The spawn-failure distinction
 * `git.ts` draws is kept (a missing binary throws out of `Bun.spawn`, before `gh` runs) and
 * both sides of it collapse into the same `undefined`, which `merges.ts` says once per process.
 *
 * **The field names below were verified against `gh version 2.86.0 (2026-01-21)`**, the one
 * semantics this module takes from a tool rather than from a spec; `forge.test.ts` parses that
 * `gh`'s real output, recorded. Two things the verification found:
 *
 * - `gh pr view --json` has **no base-repository field**. 018's spec names `baseRepository` as a
 *   candidate and `gh` 2.86.0 rejects it (`Unknown JSON field: "baseRepository"`), while
 *   `headRepository.nameWithOwner` comes back empty. So the repository a pull request lives in
 *   is read off the canonical `url` `gh` itself returns.
 * - `gh pr view <url>` takes the URL as the authority and ignores the directory it runs in — it
 *   answers about another repository's pull request from inside this one, and from outside any
 *   repository. That is why `repoUrl` exists: "this repository" has to be asked for separately,
 *   and `merges.ts` compares the two.
 *
 * The URL is one argv element, never composed into a shell line, and the core has already
 * validated it as an absolute https URL free of control characters — so it cannot arrive
 * looking like a flag.
 */

/** What `gh pr view` is asked for. Nothing here runs a program or fetches a body. */
const PR_FIELDS = "state,mergedAt,headRefName,url";

/** A pull request as the forge reports it. */
export interface PullRequest {
  /** The forge's own canonical URL for the pull request. */
  url: string;
  state: "open" | "merged" | "closed";
  /** When it merged, as the forge renders the time; absent unless `state` is `"merged"`. */
  mergedAt?: string;
  headRefName: string;
  /** The repository the pull request is in, as a URL: `https://<host>/<owner>/<repo>`. */
  baseRepo: string;
}

export interface Forge {
  /**
   * The pull request at `url`, or `undefined` when the forge cannot answer. `repoRoot` is only
   * the directory the command runs in: the URL is what names the pull request, so the answer
   * may well be about another repository — which is why a caller compares `baseRepo` with
   * `repoUrl` rather than trusting the directory.
   */
  pullRequest(repoRoot: string, url: string): Promise<PullRequest | undefined>;
  /** The URL of the repository at `repoRoot`, or `undefined` when the forge cannot answer. */
  repoUrl(repoRoot: string): Promise<string | undefined>;
}

/** `gh`'s own spelling of a pull request's state. */
const STATES: Record<string, PullRequest["state"]> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};

function asRecord(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * The repository a pull request URL names: `https://<host>/<owner>/<repo>/pull/<n>` →
 * `https://<host>/<owner>/<repo>`. The host is part of it, so two forges holding a repository
 * of the same name are never read as one.
 */
function baseRepoOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 4 || parts[2] !== "pull") return undefined;
  return `${parsed.origin}/${parts[0]}/${parts[1]}`;
}

/** One `gh pr view --json state,mergedAt,headRefName,url` answer, or nothing it can be read as. */
export function parsePullRequest(stdout: string): PullRequest | undefined {
  const record = asRecord(stdout);
  if (record === undefined) return undefined;
  const { state, mergedAt, headRefName, url } = record;
  if (typeof url !== "string" || typeof headRefName !== "string") return undefined;
  if (typeof state !== "string" || STATES[state] === undefined) return undefined;
  if (mergedAt !== null && typeof mergedAt !== "string") return undefined;
  const baseRepo = baseRepoOf(url);
  if (baseRepo === undefined) return undefined;
  const pullRequest: PullRequest = {
    url,
    state: STATES[state] as PullRequest["state"],
    headRefName,
    baseRepo,
  };
  return mergedAt === null ? pullRequest : { ...pullRequest, mergedAt };
}

/** One `gh repo view --json url` answer. */
export function parseRepoUrl(stdout: string): string | undefined {
  const record = asRecord(stdout);
  const url = record?.url;
  return typeof url === "string" ? url : undefined;
}

export function createForge(options: { env?: Record<string, string | undefined> } = {}): Forge {
  const env = options.env ?? process.env;

  /** stdout of a `gh` that exited 0, or nothing: every other outcome is "cannot answer". */
  async function view(cwd: string, args: string[]): Promise<string | undefined> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["gh", ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      // A missing binary or an unusable cwd: spawn itself fails, before `gh` runs.
      return undefined;
    }
    // Both pipes are drained, so a `gh` that writes a long error cannot block on one of them.
    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return code === 0 ? stdout : undefined;
  }

  return {
    async pullRequest(repoRoot, url) {
      const out = await view(repoRoot, ["pr", "view", url, "--json", PR_FIELDS]);
      return out === undefined ? undefined : parsePullRequest(out);
    },

    async repoUrl(repoRoot) {
      const out = await view(repoRoot, ["repo", "view", "--json", "url"]);
      return out === undefined ? undefined : parseRepoUrl(out);
    },
  };
}
