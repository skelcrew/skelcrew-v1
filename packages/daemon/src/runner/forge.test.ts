/**
 * `gh pr view --json`'s output, as the installed `gh` really renders it. The four payloads
 * below were captured from `gh version 2.86.0 (2026-01-21)` against real pull requests (see
 * `docs/plans/018-a-merged-pull-request-lands-in-done.md` and `…/020-…md`); no test here runs the
 * real `gh`. The timeout case at the bottom spawns a `gh` of its own making on a `PATH` of one
 * directory, which is how the child being killed can be observed at all.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForge, parsePullRequest, parseRepoUrl } from "./forge";

/**
 * `gh pr view https://github.com/skelcrew/skelcrew/pull/7 --json
 * state,mergedAt,headRefName,url,mergeable,baseRefName`. A merged pull request answers
 * `UNKNOWN` for `mergeable`: the forge computes mergeability for what could still be merged.
 */
const MERGED = `{"baseRefName":"main","headRefName":"worktree-runner-skeleton","mergeable":"UNKNOWN","mergedAt":"2026-09-09T08:44:11Z","state":"MERGED","url":"https://github.com/skelcrew/skelcrew/pull/7"}`;
/** The same command against an open pull request that merges cleanly: `mergedAt` is null. */
const OPEN = `{"baseRefName":"trunk","headRefName":"patch-1","mergeable":"MERGEABLE","mergedAt":null,"state":"OPEN","url":"https://github.com/cli/cli/pull/14373"}`;
/** And against one closed without merging, where `mergeable` says nothing about that. */
const CLOSED = `{"baseRefName":"trunk","headRefName":"bump-go-1.27.1","mergeable":"MERGEABLE","mergedAt":null,"state":"CLOSED","url":"https://github.com/cli/cli/pull/14423"}`;
/** An open pull request that conflicts with its base: `cli/cli#14285`, read on 2026-09-14. */
const CONFLICTING = `{"baseRefName":"trunk","headRefName":"williammartin-audit-spam-labeling","mergeable":"CONFLICTING","mergedAt":null,"state":"OPEN","url":"https://github.com/cli/cli/pull/14285"}`;

test("a merged pull request: the state, the merge time, the head branch, and the repository", () => {
  expect(parsePullRequest(MERGED)).toEqual({
    url: "https://github.com/skelcrew/skelcrew/pull/7",
    state: "merged",
    mergedAt: "2026-09-09T08:44:11Z",
    headRefName: "worktree-runner-skeleton",
    baseRepo: "https://github.com/skelcrew/skelcrew",
    baseRefName: "main",
    mergeable: "unknown",
  });
});

test("an open pull request has no merge time", () => {
  expect(parsePullRequest(OPEN)).toEqual({
    url: "https://github.com/cli/cli/pull/14373",
    state: "open",
    headRefName: "patch-1",
    baseRepo: "https://github.com/cli/cli",
    baseRefName: "trunk",
    mergeable: "mergeable",
  });
});

test("a pull request closed without merging is closed, not merged", () => {
  expect(parsePullRequest(CLOSED)).toEqual({
    url: "https://github.com/cli/cli/pull/14423",
    state: "closed",
    headRefName: "bump-go-1.27.1",
    baseRepo: "https://github.com/cli/cli",
    baseRefName: "trunk",
    mergeable: "mergeable",
  });
});

/**
 * Criterion 2, and the answer the spec records as unobserved — no conflicting pull request
 * existed while it was written. This one did, and the base branch it conflicts with is the
 * `baseRefName` beside it, which is what the poll's note names.
 */
test("an open pull request that conflicts with its base says so, naming that base", () => {
  expect(parsePullRequest(CONFLICTING)).toEqual({
    url: "https://github.com/cli/cli/pull/14285",
    state: "open",
    headRefName: "williammartin-audit-spam-labeling",
    baseRepo: "https://github.com/cli/cli",
    baseRefName: "trunk",
    mergeable: "conflicting",
  });
});

/**
 * Anything that is not one of the two named answers is `unknown`, an absent field included:
 * GitHub computes mergeability lazily and answers `UNKNOWN` until it has, so "cannot say yet"
 * and "this `gh` does not answer that" collapse into the one value the poll does nothing about.
 */
test("every other mergeability, and an absent one, is unknown rather than a parse failure", () => {
  const said = (mergeable: string): string =>
    `{"baseRefName":"main","headRefName":"x","mergeable":${mergeable},"mergedAt":null,"state":"OPEN","url":"https://h/o/r/pull/1"}`;
  for (const answer of [`"UNKNOWN"`, `"SOMETHING_NEW"`, "null", "7"]) {
    expect([answer, parsePullRequest(said(answer))?.mergeable]).toEqual([answer, "unknown"]);
  }
  const absent = `{"baseRefName":"main","headRefName":"x","mergedAt":null,"state":"OPEN","url":"https://h/o/r/pull/1"}`;
  expect(parsePullRequest(absent)?.mergeable).toBe("unknown");
});

test("the repository is taken from the host too, so two hosts cannot be confused", () => {
  const enterprise = `{"baseRefName":"main","headRefName":"work","mergeable":"MERGEABLE","mergedAt":null,"state":"OPEN","url":"https://forge.example.invalid/skelcrew/skelcrew/pull/3"}`;
  expect(parsePullRequest(enterprise)?.baseRepo).toBe(
    "https://forge.example.invalid/skelcrew/skelcrew",
  );
});

test("the repository the daemon is watching, as `gh repo view --json url` renders it", () => {
  expect(parseRepoUrl(`{"url":"https://github.com/skelcrew/skelcrew"}`)).toBe(
    "https://github.com/skelcrew/skelcrew",
  );
  expect(parseRepoUrl("")).toBeUndefined();
  expect(parseRepoUrl(`{"nameWithOwner":"skelcrew/skelcrew"}`)).toBeUndefined();
  expect(parseRepoUrl("not JSON at all")).toBeUndefined();
});

test("output that is not an answer about a pull request is no answer at all", () => {
  // Not JSON, JSON of the wrong shape, a state nothing here knows, a URL that names no
  // repository, and no base branch to name: each is "cannot answer", never a guess.
  expect(parsePullRequest("")).toBeUndefined();
  expect(parsePullRequest("no pull requests found for branch\n")).toBeUndefined();
  expect(parsePullRequest("[]")).toBeUndefined();
  expect(parsePullRequest(`{"state":"MERGED"}`)).toBeUndefined();
  expect(
    parsePullRequest(
      `{"baseRefName":"main","headRefName":"x","mergedAt":null,"state":"DRAFTED","url":"https://h/o/r/pull/1"}`,
    ),
  ).toBeUndefined();
  expect(
    parsePullRequest(
      `{"baseRefName":"main","headRefName":"x","mergedAt":null,"state":"OPEN","url":"https://h/pull/1"}`,
    ),
  ).toBeUndefined();
  // The base branch is the one the note names, so an answer without one is no answer: unlike
  // `mergeable`, there is nothing to degrade to that a card could be told.
  expect(
    parsePullRequest(
      `{"headRefName":"x","mergedAt":null,"state":"OPEN","url":"https://h/o/r/pull/1"}`,
    ),
  ).toBeUndefined();
});

// --- a `gh` that hangs (review round 2, Important 2) ---

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "skr-forge-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A `gh` that never answers, in a directory that is the whole `PATH` — so the real one is
 * unreachable. It sleeps (by absolute path, since that `PATH` holds only this script), and only
 * then leaves `finished` behind: if that file never appears, the child was killed rather than
 * merely abandoned.
 */
async function hangingGh(finished: string): Promise<string> {
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const path = join(bin, "gh");
  // One second, not thirty: long enough to outlast the timeout below, short enough that the
  // "it wrote its file after all" case — a child left alive — shows up inside the test.
  await Bun.write(path, `#!/bin/sh\n/bin/sleep 1\necho done > "${finished}"\n`);
  chmodSync(path, 0o755);
  return bin;
}

test("a gh that does not answer in time is no answer, and the gh process is killed", async () => {
  const finished = join(tmp, "finished");
  const bin = await hangingGh(finished);
  const forge = createForge({ env: { PATH: bin }, timeoutMs: 150 });

  const started = Date.now();
  expect(await forge.repoUrl(tmp)).toBeUndefined();
  expect(await forge.pullRequest(tmp, "https://example.invalid/o/r/pull/1")).toBeUndefined();
  // Bounded: two calls of 150 ms each, and neither waited for the child it started.
  expect(Date.now() - started).toBeLessThan(1000);

  // And both `gh` processes are dead rather than sleeping on: a survivor would have written its
  // file by now, which is what an unkilled `gh` doing the real thing would go on to do. Only the
  // `gh` process itself, though — review round 3 watched the `/bin/sleep` each shim spawned
  // outlive the kill, reparented to pid 1. What it spawns is not killed and not waited for; the
  // guarantee is that the call ends and nothing further is written on this shim's behalf.
  await Bun.sleep(1500);
  expect(existsSync(finished)).toBe(false);
});
