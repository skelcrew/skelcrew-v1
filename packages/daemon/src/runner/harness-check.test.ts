/**
 * The parts of `bun run check:harness` that can be tested without it: the stub that plays the
 * model, the stub executables the commands land on, and the pass/fail logic. Nothing here
 * spawns the harness — the check itself is what does that, and `bun test` does not run it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { baseBranchGrants, FIXED_ALLOWLIST, REVIEW_ALLOWLIST } from "./allowlist";
import {
  CONTROL_COMMAND,
  type CommandOutcome,
  FIXED_LIST_REPRESENTATIVES,
  LISTS_UNDER_TEST,
  type ListUnderTest,
  letGo,
  problemsIn,
  REVIEW_LIST_REPRESENTATIVES,
  type RunState,
  ranTheCommand,
  STUB_API_KEY,
  startStubModel,
  unrepresentedEntries,
  writeStubExecutables,
} from "./harness-check";
import { FILLED_BASE, instructedCommands } from "./playbook-commands";
import { loadPlaybooks } from "./playbooks";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skr-hc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One SSE payload's events, in order, as `[event name, data]`. */
function events(body: string): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const block of body.split("\n\n")) {
    const name = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (name !== undefined && data !== undefined) out.push([name, JSON.parse(data)]);
  }
  return out;
}

async function post(url: string, body: unknown): Promise<string> {
  const response = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "the-dummy-key" },
    body: JSON.stringify(body),
  });
  return await response.text();
}

const prompt = { model: "a-model", messages: [{ role: "user", content: "Run the command." }] };
const result = {
  model: "a-model",
  messages: [
    { role: "user", content: "Run the command." },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
  ],
};

test("the stub answers a prompt with one Bash tool call carrying the command", async () => {
  const stub = startStubModel("git status");
  try {
    const emitted = events(await post(stub.url, prompt));
    const names = emitted.map(([name]) => name);
    expect(names).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const [, start] = emitted[1] as [string, Record<string, unknown>];
    expect(start.content_block).toMatchObject({ type: "tool_use", name: "Bash" });
    const [, delta] = emitted[2] as [string, Record<string, unknown>];
    const partial = (delta.delta as { partial_json: string }).partial_json;
    expect(JSON.parse(partial)).toMatchObject({ command: "git status" });
    const [, stop] = emitted[4] as [string, Record<string, unknown>];
    expect((stop.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
  } finally {
    stub.stop();
  }
});

test("the stub ends the turn on a tool result, asking for nothing more", async () => {
  const stub = startStubModel("git status");
  try {
    const emitted = events(await post(stub.url, result));
    expect(emitted.map(([name]) => name)).not.toContain("content_block_start_tool_use");
    for (const [, data] of emitted) {
      expect(JSON.stringify(data)).not.toContain("tool_use");
    }
    const stop = emitted.find(([name]) => name === "message_delta")?.[1] ?? {};
    expect((stop.delta as { stop_reason: string } | undefined)?.stop_reason).toBe("end_turn");
  } finally {
    stub.stop();
  }
});

test("the stub records every request it saw, with the credentials it was given", async () => {
  const stub = startStubModel("git status");
  try {
    expect(stub.requests).toEqual([]);
    await post(stub.url, prompt);
    await post(stub.url, result);
    expect(stub.requests).toEqual([
      { method: "POST", path: "/v1/messages", credentials: ["the-dummy-key"] },
      { method: "POST", path: "/v1/messages", credentials: ["the-dummy-key"] },
    ]);
  } finally {
    stub.stop();
  }
});

/**
 * Three headers, not every header: the one the pinned binary uses (`x-api-key`, and nothing else,
 * from a logged full run) and the two obvious proxies. A tripwire rather than the containment —
 * that is the environment, the empty `HOME` and `settingSources: []` — so a future binary
 * authenticating some other way is likely to be noticed, not certain to be. `Bearer ` is stripped,
 * because a token presented that way is still the token.
 */
test("the stub records a credential in each of the three headers it reads", async () => {
  const stub = startStubModel("git status");
  try {
    await fetch(`${stub.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-ant-the-owners-key",
        "proxy-authorization": "a-proxy-credential",
      },
      body: JSON.stringify(prompt),
    });
    expect(stub.requests[0]?.credentials.toSorted()).toEqual([
      "a-proxy-credential",
      "sk-ant-the-owners-key",
    ]);
  } finally {
    stub.stop();
  }
});

/** Every IPv4 address of this machine that is not the loopback one. */
function otherAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

/**
 * Criterion 6, and asserted on what the socket does rather than on a string the stub composed:
 * round 1's version read `stub.url`, which was built from a literal, so a stub bound to
 * `0.0.0.0` passed it. The bind is read back off the server, and — where this machine has one —
 * a connection to a non-loopback address of its own on the stub's port has to be refused.
 */
test("the stub listens on the loopback address and refuses every other", async () => {
  const stub = startStubModel("git status");
  try {
    expect(stub.hostname).toBe("127.0.0.1");
    expect(stub.url).toBe(`http://127.0.0.1:${stub.port}`);
    const reachable = await fetch(stub.url, { method: "HEAD" });
    expect(reachable.ok).toBe(true);
    for (const address of otherAddresses()) {
      const attempt = fetch(`http://${address}:${stub.port}`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2000),
      });
      expect([address, await attempt.then(() => "answered").catch(() => "refused")]).toEqual([
        address,
        "refused",
      ]);
    }
  } finally {
    stub.stop();
  }
});

test("every command word gets an executable that exits 0 and writes nothing", () => {
  const words = writeStubExecutables(dir, [
    "git status",
    "git push -u origin HEAD",
    "gh pr view --json url --jq .url",
    "skelcrew show PLACEHOLDER",
    "bun run check",
  ]);
  expect(words.toSorted()).toEqual(["bun", "gh", "git", "skelcrew"]);
  for (const word of words) {
    const run = Bun.spawnSync([join(dir, word), "any", "argument"], { env: {} });
    expect([word, run.exitCode, run.stdout.toString(), run.stderr.toString()]).toEqual([
      word,
      0,
      "",
      "",
    ]);
  }
});

/**
 * Minor 1 of review round 2. A SIGTERM mid-check exited 143 and left three things behind: the
 * spawned `claude`, the stub's listener, and a scratch directory holding a registered git
 * worktree. What a signal handler has to let go of is this, and it is a function so that it can
 * be called here rather than only by a signal: the handler's own plumbing
 * (`process.on("SIGTERM", …)`) is verified by hand, and the record says so.
 */
test("an interrupt closes the live session and the stub and removes the scratch directory", async () => {
  const stub = startStubModel("git status");
  const scratch = join(dir, "scratch");
  mkdirSync(join(scratch, "worktree"), { recursive: true });
  writeFileSync(join(scratch, "worktree", ".git"), "gitdir: elsewhere\n");
  let sessionClosed = false;
  const state: RunState = {
    scratch,
    interrupt: () => {
      sessionClosed = true;
      stub.stop();
    },
  };

  letGo(state);

  expect(sessionClosed).toBe(true);
  expect(existsSync(scratch)).toBe(false);
  const answered = await fetch(stub.url, { method: "HEAD", signal: AbortSignal.timeout(2000) })
    .then(() => "answered")
    .catch(() => "refused");
  expect(answered).toBe("refused");
});

test("an interrupt with nothing yet to let go of does nothing", () => {
  const state: RunState = {};
  expect(() => {
    letGo(state);
  }).not.toThrow();
});

/**
 * Criterion 3's "a tool result that is not an error". Round 1 read any tool result as the
 * command having run, and a *denied* call produces one too — the refusal, marked as an error —
 * so the control command read as executed and denied at once.
 */
const userMessage = (content: unknown[]): unknown => ({
  type: "user",
  message: { role: "user", content },
});

test("the command ran when its own tool call came back as a result that is not an error", () => {
  expect(
    ranTheCommand(userMessage([{ type: "tool_result", tool_use_id: "t1", content: "" }]), "t1"),
  ).toBe(true);
});

test("a denied call did not run, however much of a tool result its refusal is", () => {
  expect(
    ranTheCommand(
      userMessage([{ type: "tool_result", tool_use_id: "t1", content: "denied", is_error: true }]),
      "t1",
    ),
  ).toBe(false);
});

test("another tool call's result is not this command running", () => {
  expect(
    ranTheCommand(userMessage([{ type: "tool_result", tool_use_id: "other", content: "" }]), "t1"),
  ).toBe(false);
  expect(ranTheCommand(userMessage([{ type: "text", text: "hello" }]), "t1")).toBe(false);
  expect(ranTheCommand({ type: "assistant", message: { content: [] } }, "t1")).toBe(false);
});

/** The two lists the check puts through the harness, each with its own representatives. */
const [CODE_LIST, REVIEW_LIST] = LISTS_UNDER_TEST as [ListUnderTest, ListUnderTest];

const clean = (command: string, list = CODE_LIST.name): CommandOutcome => ({
  command,
  list,
  control: false,
  executed: true,
  denials: [],
  requests: 2,
  canUseToolCalls: 0,
  credentials: [STUB_API_KEY],
});

const control: CommandOutcome = {
  command: CONTROL_COMMAND,
  list: CODE_LIST.name,
  control: true,
  executed: false,
  denials: [{ tool: "Bash", reason: "dontAsk mode" }],
  requests: 2,
  canUseToolCalls: 0,
  credentials: [STUB_API_KEY],
};

/** The same control, under the review list: every list under test carries one of its own. */
const reviewControl: CommandOutcome = { ...control, list: REVIEW_LIST.name };

/**
 * A whole run of the check with `outcomes` in it: every representative of both lists ran under
 * its own list and each list's control was denied, which is what a passing run looks like. Each
 * test below puts exactly one thing wrong into it, so the verdict it asserts is on that one thing.
 */
const runWith = (...outcomes: CommandOutcome[]): CommandOutcome[] => [
  ...outcomes,
  ...LISTS_UNDER_TEST.flatMap((list) =>
    list.representatives.map((command) => clean(command, list.name)),
  ),
  control,
  reviewControl,
];

test("a run where every prescribed command executed and the control was denied passes", () => {
  expect(problemsIn(runWith(clean("git status"), clean("git add .")))).toEqual([]);
});

/**
 * Important 2 of review round 1, and the amended criterion 3. `instructedCommands()` excludes
 * the "pre-allowed, so they run unprompted" paragraph — rightly, for a test checked against a
 * model derived from the same list, and wrongly for this check, which asks the binary. Six
 * entries a Code run's artefact depends on (`git add`, `git commit`, `gh pr create`,
 * `gh pr diff`, `gh pr comment`, `gh repo view`) are instructed in prose only, so a green run
 * meant less than it looked. Every `Bash(...)` entry now has a representative, and an entry
 * without one fails the check rather than being quietly skipped.
 */
test("every Bash entry of both lists has a representative command", () => {
  for (const { name, list, representatives } of LISTS_UNDER_TEST) {
    const bashEntries = list.filter((entry) => entry.startsWith("Bash("));
    expect([name, unrepresentedEntries(representatives, list)]).toEqual([name, []]);
    expect(bashEntries.length).toBeGreaterThan(0);
    expect([name, representatives.length]).toEqual([name, bashEntries.length]);
  }
  expect(LISTS_UNDER_TEST.map((entry) => entry.kind)).toEqual(["code", "review"]);
  // The Code list under test is what a Code run is really spawned with, which since 020 is the
  // fixed list plus the two entries composed from the base branch's name — the same name the
  // playbook's `<base>` fills with, and the same one the temporary repository is created on.
  expect(CODE_LIST.list).toEqual([...FIXED_ALLOWLIST, ...baseBranchGrants(FILLED_BASE)]);
  expect(REVIEW_LIST.list).toEqual([...REVIEW_ALLOWLIST]);
});

/**
 * 020, criterion 1. An exact entry's representative is the entry itself: there is no argument to
 * choose, and the command the playbook instructs is that same string once `<base>` is filled. So
 * both are under test, and `unrepresentedEntries` would name either one left off.
 */
test("the two base-branch entries are representatives of the Code list, as themselves", () => {
  for (const command of [
    `git fetch origin ${FILLED_BASE}`,
    `git merge --no-edit refs/remotes/origin/${FILLED_BASE}`,
  ]) {
    expect([command, FIXED_LIST_REPRESENTATIVES.includes(command)]).toEqual([command, true]);
    expect([command, instructedCommands(loadPlaybooks().code).includes(command)]).toEqual([
      command,
      true,
    ]);
  }
});

test("a fixed-list entry whose representative is missing is named", () => {
  const short = FIXED_LIST_REPRESENTATIVES.filter((command) => command !== "git add -A");
  expect(unrepresentedEntries(short)).toEqual(["Bash(git add *)"]);
  const noExact = FIXED_LIST_REPRESENTATIVES.filter((command) => command !== "git push");
  expect(unrepresentedEntries(noExact)).toEqual(["Bash(git push)"]);
  const noVerdict = REVIEW_LIST_REPRESENTATIVES.filter(
    (command) => !command.startsWith("skelcrew review "),
  );
  expect(unrepresentedEntries(noVerdict, REVIEW_ALLOWLIST)).toEqual(["Bash(skelcrew review *)"]);
});

test("a fixed-list entry with no representative fails the check", () => {
  const short = FIXED_LIST_REPRESENTATIVES.filter((command) => !command.startsWith("gh pr create"));
  const problems = problemsIn(
    [...short.map((command) => clean(command)), control],
    [{ ...CODE_LIST, representatives: short }],
  );
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("Bash(gh pr create *)");
});

test("a representative the run never put through the harness fails the check", () => {
  const run = runWith().filter((outcome) => outcome.command !== "git add -A");
  expect(problemsIn(run)).toEqual([
    "`git add -A` is a representative of the Code list that this run never ran",
  ]);
});

/**
 * Criterion 1 of 019. A command that ran under the Code list says nothing about the review
 * run's grants, which are a different list with deny rules of its own — so coverage is counted
 * per list, and a review representative that only ever ran under the Code list is a gap.
 */
test("a review representative run only under the Code list does not cover the review list", () => {
  const verdict = REVIEW_LIST_REPRESENTATIVES.find((command) =>
    command.startsWith("skelcrew review "),
  ) as string;
  const run = runWith().map((outcome) =>
    outcome.list === REVIEW_LIST.name && outcome.command === verdict
      ? { ...outcome, list: CODE_LIST.name }
      : outcome,
  );
  expect(problemsIn(run)).toEqual([
    `\`${verdict}\` is a representative of the review list that this run never ran`,
  ]);
});

/**
 * Important 1 of review round 2. The one call the review contract depends on carries the findings
 * on its command line, and a backtick inside *double* quotes is a command substitution the pinned
 * harness asks about outright — so the representative that stands for `Bash(skelcrew review *)` is
 * written the way the playbook prescribes the findings, single-quoted with a backtick inside, and
 * `bun run check:harness` is what answers whether the harness asks about it.
 */
test("the review verdict's representative carries a backtick inside single quotes", () => {
  const verdict = REVIEW_LIST_REPRESENTATIVES.find((command) =>
    command.startsWith("skelcrew review "),
  ) as string;
  const quoted = /'[^']*`[^']*'/.exec(verdict);
  expect([verdict, quoted !== null]).toEqual([verdict, true]);
  expect(verdict).not.toContain('"');
});

test("a prescribed command the harness denied fails the check, naming it and the reason", () => {
  const denied: CommandOutcome = {
    ...clean("skelcrew mv PLACEHOLDER"),
    executed: false,
    denials: [{ tool: "Bash", reason: "Permission to use Bash has been denied" }],
  };
  const problems = problemsIn(runWith(denied));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("skelcrew mv PLACEHOLDER");
  expect(problems[0]).toContain("Permission to use Bash has been denied");
});

/**
 * Minor 2 of review round 2. The control used to be whichever outcome *equalled*
 * `CONTROL_COMMAND`, so a playbook prescribing `git push origin HEAD:main` had its denial read
 * as the control's own and the run passed — the one command whose denial the check is built to
 * tolerate, tolerated in the one place it must not be. The control is tagged where it is
 * appended, and a prescribed command that is the control is a problem of its own.
 */
test("a prescribed command that is the control command fails the check on its own account", () => {
  const harvested: CommandOutcome = {
    ...clean(CONTROL_COMMAND),
    control: false,
    executed: false,
    denials: [{ tool: "Bash", reason: "dontAsk mode" }],
  };
  const problems = problemsIn(runWith(harvested));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain(CONTROL_COMMAND);
  expect(problems[0]).toContain("prescribes");
});

test("two outcomes tagged as the control fail the check", () => {
  const problems = problemsIn([...runWith(), { ...control }]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("once");
});

test("a control command the harness did not deny fails the check", () => {
  const allowed = { ...control, executed: true, denials: [] };
  const problems = problemsIn([...runWith().filter((o) => o !== control), allowed]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain(CONTROL_COMMAND);
});

test("a check that never ran the control command fails", () => {
  const problems = problemsIn(runWith().filter((outcome) => outcome !== control));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain(CONTROL_COMMAND);
});

/**
 * Minor 3 of review round 2. The control used to be appended to the Code list's sessions alone,
 * so the one denial the whole check rests on was evidence about that list only: a review-list
 * session that allowed everything would still have passed. Every list under test carries its own.
 */
test("a list whose control command was never run fails, naming that list", () => {
  const problems = problemsIn(runWith().filter((outcome) => outcome !== reviewControl));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain(CONTROL_COMMAND);
  expect(problems[0]).toContain(REVIEW_LIST.name);
});

test("a list whose control command the harness did not deny fails, naming that list", () => {
  const allowed = { ...reviewControl, executed: true, denials: [] };
  const problems = problemsIn([
    ...runWith().filter((outcome) => outcome !== reviewControl),
    allowed,
  ]);
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain(CONTROL_COMMAND);
  expect(problems[0]).toContain(REVIEW_LIST.name);
});

test("a command the stub saw no request for fails the check, however it ended", () => {
  const problems = problemsIn(runWith({ ...clean("git status"), requests: 0 }));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("no request");
});

test("a command that reached canUseTool fails the check", () => {
  const problems = problemsIn(runWith({ ...clean("git status"), canUseToolCalls: 1 }));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("canUseTool");
});

/**
 * Criterion 6. The stub is what the harness authenticates to, so the credential it presented is
 * evidence about the environment the harness ran in that nothing in this repository had to be
 * trusted for: a session that presented anything but the dummy key found a credential somewhere,
 * and the owner's is the only one there is.
 */
test("a session where the harness presented a credential other than the dummy fails the check", () => {
  const leaked = { ...clean("git status"), credentials: [STUB_API_KEY, "sk-ant-the-owners-key"] };
  const problems = problemsIn(runWith(leaked));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("credential");
  // The key itself is not printed: the check's output is not where a credential belongs.
  expect(problems[0]).not.toContain("sk-ant-the-owners-key");
});

test("a command that ended without executing and without a denial fails the check", () => {
  const problems = problemsIn(runWith({ ...clean("git status"), executed: false }));
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("git status");
});
