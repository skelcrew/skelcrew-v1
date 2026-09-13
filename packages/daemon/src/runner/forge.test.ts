/**
 * `gh pr view --json`'s output, as the installed `gh` really renders it. The three payloads
 * below were captured from `gh version 2.86.0 (2026-01-21)` against real pull requests (see
 * `docs/plans/018-a-merged-pull-request-lands-in-done.md`); no test here runs the real `gh`. The
 * timeout case at the bottom spawns a `gh` of its own making on a `PATH` of one directory, which
 * is how the child being killed can be observed at all.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForge, parsePullRequest, parseRepoUrl } from "./forge";

/** `gh pr view https://github.com/skelcrew/skelcrew/pull/7 --json state,mergedAt,headRefName,url` */
const MERGED = `{"headRefName":"worktree-runner-skeleton","mergedAt":"2026-09-09T08:44:11Z","state":"MERGED","url":"https://github.com/skelcrew/skelcrew/pull/7"}`;
/** The same command against an open pull request: `mergedAt` is null. */
const OPEN = `{"headRefName":"patch-1","mergedAt":null,"state":"OPEN","url":"https://github.com/cli/cli/pull/14373"}`;
/** And against one closed without merging: `mergedAt` is null there too. */
const CLOSED = `{"headRefName":"bump-go-1.27.1","mergedAt":null,"state":"CLOSED","url":"https://github.com/cli/cli/pull/14423"}`;

test("a merged pull request: the state, the merge time, the head branch, and the repository", () => {
  expect(parsePullRequest(MERGED)).toEqual({
    url: "https://github.com/skelcrew/skelcrew/pull/7",
    state: "merged",
    mergedAt: "2026-09-09T08:44:11Z",
    headRefName: "worktree-runner-skeleton",
    baseRepo: "https://github.com/skelcrew/skelcrew",
  });
});

test("an open pull request has no merge time", () => {
  expect(parsePullRequest(OPEN)).toEqual({
    url: "https://github.com/cli/cli/pull/14373",
    state: "open",
    headRefName: "patch-1",
    baseRepo: "https://github.com/cli/cli",
  });
});

test("a pull request closed without merging is closed, not merged", () => {
  expect(parsePullRequest(CLOSED)).toEqual({
    url: "https://github.com/cli/cli/pull/14423",
    state: "closed",
    headRefName: "bump-go-1.27.1",
    baseRepo: "https://github.com/cli/cli",
  });
});

test("the repository is taken from the host too, so two hosts cannot be confused", () => {
  const enterprise = `{"headRefName":"work","mergedAt":null,"state":"OPEN","url":"https://forge.example.invalid/skelcrew/skelcrew/pull/3"}`;
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
  // Not JSON, JSON of the wrong shape, a state nothing here knows, and a URL that names no
  // repository: each is "cannot answer", never a guess.
  expect(parsePullRequest("")).toBeUndefined();
  expect(parsePullRequest("no pull requests found for branch\n")).toBeUndefined();
  expect(parsePullRequest("[]")).toBeUndefined();
  expect(parsePullRequest(`{"state":"MERGED"}`)).toBeUndefined();
  expect(
    parsePullRequest(
      `{"headRefName":"x","mergedAt":null,"state":"DRAFTED","url":"https://h/o/r/pull/1"}`,
    ),
  ).toBeUndefined();
  expect(
    parsePullRequest(`{"headRefName":"x","mergedAt":null,"state":"OPEN","url":"https://h/pull/1"}`),
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

test("a gh that does not answer in time is no answer, and its child is killed", async () => {
  const finished = join(tmp, "finished");
  const bin = await hangingGh(finished);
  const forge = createForge({ env: { PATH: bin }, timeoutMs: 150 });

  const started = Date.now();
  expect(await forge.repoUrl(tmp)).toBeUndefined();
  expect(await forge.pullRequest(tmp, "https://example.invalid/o/r/pull/1")).toBeUndefined();
  // Bounded: two calls of 150 ms each, and neither waited for the child it started.
  expect(Date.now() - started).toBeLessThan(1000);

  // And both children are gone rather than sleeping on: a survivor would have written its file
  // by now, which is what an unkilled `gh` doing the real thing would go on to do.
  await Bun.sleep(1500);
  expect(existsSync(finished)).toBe(false);
});
