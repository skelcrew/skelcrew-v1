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
 * - `mergeable` and `baseRefName` (020) are both fields of that same call, verified against real
 *   pull requests before this module asked for them. What each answer was observed to be — and
 *   the one thing that was not — is recorded on `PullRequest.mergeable` below, because that is
 *   the field the daemon now acts on.
 *
 * The URL is one argv element, never composed into a shell line, and the core has already
 * validated it as an absolute https URL free of control characters — so it cannot arrive
 * looking like a flag.
 *
 * **Every spawn is bounded.** `gh` talks to a network, and review round 2 found the unbounded
 * version: one `gh` that never returned held the merge poll's one-tick-at-a-time guard for the
 * life of the process — eight silent ticks, nothing on any card, no warning. On expiry the `gh`
 * process is killed and the call is "cannot answer", which is the path a logged-out `gh` already
 * takes. Only that process: anything `gh` itself spawned is neither killed nor waited for and may
 * outlive it, reparented (review round 3 watched exactly that happen to a shim's `/bin/sleep`).
 * What is guaranteed is that the call ends.
 */

/** What `gh pr view` is asked for. Nothing here runs a program or fetches a body. */
const PR_FIELDS = "state,mergedAt,headRefName,url,mergeable,baseRefName";

/**
 * How long one `gh` call may take. Well inside the merge poll's minute, and far outside what a
 * healthy call needs (the verification runs answered in under two seconds).
 */
export const FORGE_TIMEOUT_MS = 30_000;

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
  /** The branch the pull request would merge *into*, as the forge names it. */
  baseRefName: string;
  /**
   * Whether the forge can merge it as it stands. **`unknown` is not "no"**: GitHub computes
   * mergeability lazily and answers `UNKNOWN` until it has, and a merged pull request answers
   * `UNKNOWN` too — so a caller asks again rather than concluding anything from it.
   *
   * What was verified against `gh` 2.86.0 and what was not, since this is the one field the
   * daemon now acts on:
   *
   * - The three enum values are the GraphQL schema's (`MERGEABLE`, `CONFLICTING`, `UNKNOWN`).
   * - `MERGEABLE`: observed, on an open pull request (`cli/cli#14373`) and — which says the
   *   field is not about the *state* — on one closed without merging (`cli/cli#14423`).
   * - `UNKNOWN`: observed on a merged pull request (this repository's own #7).
   * - `CONFLICTING`: observed on an open pull request whose base had moved under it
   *   (`cli/cli#14285`, 2026-09-14). 020's spec records this answer as *unobserved* — no
   *   conflicting pull request existed while it was written — and it is now recorded here and in
   *   `forge.test.ts` as real output rather than as an expectation.
   * - Not observed: the transition itself, a pull request seen `UNKNOWN` and then `CONFLICTING`
   *   as the forge caught up. The poll's answer to `unknown` — do nothing, ask again next tick —
   *   is what makes that transition nothing it has to handle.
   */
  mergeable: "mergeable" | "conflicting" | "unknown";
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

/**
 * `gh`'s own spelling of mergeability. Everything else — `UNKNOWN`, a value a later schema adds,
 * an absent field — is `unknown`, so a **value this map does not know** degrades to "nothing on
 * the card" rather than to a parse failure that would stop a merge from landing. A fourth enum
 * value added to the schema later is what that covers.
 *
 * It is **not** what covers an older `gh`, and review round 2 of 020 corrected the claim that it
 * was: `mergeable` is in `PR_FIELDS`, and `gh pr view <url> --json <unknown field>` exits 1 with
 * `Unknown JSON field` before it calls the API at all. So a `gh` that does not know a field fails
 * the whole call — "cannot answer", the path a logged-out `gh` already takes — and nothing here is
 * reached. Adding a field to `PR_FIELDS` is the change an older `gh` fails on, and it fails on it
 * whole.
 */
const MERGEABILITY: Record<string, PullRequest["mergeable"]> = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
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

/** One `gh pr view --json <PR_FIELDS>` answer, or nothing it can be read as. */
export function parsePullRequest(stdout: string): PullRequest | undefined {
  const record = asRecord(stdout);
  if (record === undefined) return undefined;
  const { state, mergedAt, headRefName, url, baseRefName, mergeable } = record;
  if (typeof url !== "string" || typeof headRefName !== "string") return undefined;
  // The base branch is read as strictly as the head: it is what the conflict note names, and
  // there is nothing to degrade to that a card could be told. `mergeable` is the other way —
  // `unknown` is a real answer the poll already does nothing about, so it takes anything.
  if (typeof baseRefName !== "string") return undefined;
  if (typeof state !== "string" || STATES[state] === undefined) return undefined;
  if (mergedAt !== null && typeof mergedAt !== "string") return undefined;
  const baseRepo = baseRepoOf(url);
  if (baseRepo === undefined) return undefined;
  const pullRequest: PullRequest = {
    url,
    state: STATES[state] as PullRequest["state"],
    headRefName,
    baseRepo,
    baseRefName,
    mergeable: (typeof mergeable === "string" ? MERGEABILITY[mergeable] : undefined) ?? "unknown",
  };
  return mergedAt === null ? pullRequest : { ...pullRequest, mergedAt };
}

/** One `gh repo view --json url` answer. */
export function parseRepoUrl(stdout: string): string | undefined {
  const record = asRecord(stdout);
  const url = record?.url;
  return typeof url === "string" ? url : undefined;
}

export function createForge(
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Forge {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? FORGE_TIMEOUT_MS;

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
    const answered = (async () => {
      const [stdout, , code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      return code === 0 ? stdout : undefined;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        // SIGKILL, not SIGTERM: the child is a read-only query with nothing to clean up, and a
        // `gh` that ignored the polite signal would put the poll back where review found it.
        proc.kill("SIGKILL");
        // And the answer is not waited for after the kill: a grandchild holding the pipe open
        // would keep the read pending long after the process that mattered is gone.
        resolve(undefined);
      }, timeoutMs);
    });
    try {
      return await Promise.race([answered, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
