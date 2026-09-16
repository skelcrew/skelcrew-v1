import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Activity,
  BODY_MAX_BYTES,
  type Card,
  type CardDetail,
  COMMENT_MAX_BYTES,
  type Member,
  type OpenAttention,
  PHASES,
  TITLE_MAX_BYTES,
  VERSION,
} from "@skelcrew/shared";
import { type Core, openCore } from "../../daemon/src/core/core";
import type { AgentDriver } from "../../daemon/src/runner/agent";
import { createGit } from "../../daemon/src/runner/git";
import { loadPlaybooks } from "../../daemon/src/runner/playbooks";
import { RUNNER_MEMBER_NAME, type Runner, startRunner } from "../../daemon/src/runner/runner";
import { startServer } from "../../daemon/src/server/server";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

let dir: string;
let socketPath: string;
let core: Core;
let server: { stop(): void };
const extraServers: Array<{ stop(): void }> = [];
const extraDirs: string[] = [];
const watchers: Array<{ kill(): void }> = [];
const runners: Runner[] = [];
/** Shifts the daemon's clock relative to the CLI's real one; zero unless a test moves it. */
let clockOffsetMs = 0;

beforeEach(() => {
  // Real path: macOS's temp dir is a symlink, and the CLI names the path it resolved.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  socketPath = join(dir, "skelcrew.sock");
  clockOffsetMs = 0;
  core = openCore(":memory:", { owner: "simon", now: () => Date.now() + clockOffsetMs });
  // The daemon reserves its runner's member name (028); a CLI against it sees that refusal.
  server = startServer({ core, socketPath, reserved: [RUNNER_MEMBER_NAME] });
});

afterEach(async () => {
  for (const w of watchers.splice(0)) w.kill();
  for (const r of runners.splice(0)) await r.stop();
  for (const s of extraServers.splice(0)) s.stop();
  server.stop();
  core.close();
  rmSync(dir, { recursive: true, force: true });
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  stdin?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** `null` leaves `SKELCREW_DIR` unset; default is the test's data directory. */
  dataDir?: string | null;
}

async function cli(args: string[], options: RunOptions = {}): Promise<Run> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SKELCREW_DIR;
  delete env.SKELCREW_AS;
  if (options.dataDir !== null) env.SKELCREW_DIR = options.dataDir ?? dir;
  env.TZ = TZ;
  Object.assign(env, options.env);
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: options.cwd ?? dir,
    env,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function ok(args: string[], options?: RunOptions): Promise<Run> {
  const run = await cli(args, options);
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
  return run;
}

/** A failed run: the given exit code, nothing on stdout, one `error:` line on stderr. */
async function failed(code: 1 | 2, args: string[], options?: RunOptions): Promise<string> {
  const run = await cli(args, options);
  expect(run.code).toBe(code);
  expect(run.stdout).toBe("");
  expect(run.stderr.startsWith("error: ")).toBe(true);
  return run.stderr;
}

function json<T>(run: Run): T {
  return JSON.parse(run.stdout) as T;
}

function lines(run: Run): string[] {
  return run.stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * The zone the CLI is spawned in. `bun test` pins its own process to UTC, so the expected
 * time is computed for this zone explicitly; a zone without daylight saving keeps it simple.
 */
const TZ = "Asia/Tokyo";

function localTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function member(name: string): Member {
  const found = core.listMembers().find((m) => m.name === name);
  if (!found) throw new Error(`no member ${name}`);
  return found;
}

/** The phase track with the given phase marked. */
const TRACK = { idea: "●○○○○", spec: "○●○○○", code: "○○●○○" };

test("--version prints the shared version without a daemon or a repository", async () => {
  const run = await cli(["--version"], { dataDir: null });
  expect(run).toEqual({ code: 0, stdout: `skelcrew ${VERSION}\n`, stderr: "" });
});

test("help and <command> --help print usage and exit 0", async () => {
  const help = await ok(["help"], { dataDir: null });
  for (const verb of [
    "add",
    "ls",
    "show",
    "comment",
    "mv",
    "body",
    "refs",
    "archive",
    "claim",
    "heartbeat",
    "release",
  ]) {
    expect(help.stdout).toContain(verb);
  }
  const mv = await ok(["mv", "--help"], { dataDir: null });
  expect(mv.stdout).toContain("mv <id> <phase>");
});

test("add files a card and prints its id and title; ls lists rows oldest first", async () => {
  const first = await ok(["add", "First card"]);
  expect(first.stdout).toContain("#1");
  expect(first.stdout).toContain("First card");

  const second = await ok(["add", "Second", "--body", "hello"]);
  expect(second.stdout).toContain("#2");
  expect(core.getCard(2).body).toBe("hello");

  const ls = await ok(["ls"]);
  const rows = lines(ls);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("#1");
  expect(rows[0]).toContain(TRACK.idea);
  expect(rows[0]).toContain("Idea");
  expect(rows[0]).toContain("First card");
  expect(rows[1]).toContain("#2");
  expect(rows[1]).toContain(TRACK.idea);
  expect(rows[1]).toContain("Idea");
  expect(rows[1]).toContain("Second");

  const cards = json<Card[]>(await ok(["ls", "--json"]));
  expect(cards).toEqual(core.listCards());
  expect(cards).toHaveLength(2);
});

test("add --json prints the card the daemon returned; --body-file reads the body", async () => {
  const bodyPath = join(dir, "body.md");
  writeFileSync(bodyPath, "# Goal\n\nfrom a file\n");
  const card = json<Card>(await ok(["add", "Filed", "--body-file", bodyPath, "--json"]));
  const { activity: _activity, ...stored } = core.getCard(card.id);
  expect(card).toEqual(stored);
  expect(card.body).toBe("# Goal\n\nfrom a file\n");
});

test("an empty list says so and points at add", async () => {
  const run = await ok(["ls"]);
  expect(lines(run)).toHaveLength(1);
  expect(run.stdout).toContain("add");
});

test("add with no title and stdin not a terminal files one card per non-empty line", async () => {
  const run = await ok(["add"], { stdin: "a\nb\n\nc\n" });
  expect(lines(run)).toHaveLength(3);
  expect(core.listCards().map((c) => c.title)).toEqual(["a", "b", "c"]);

  const cards = json<Card[]>(await ok(["add", "--json"], { stdin: "d\ne\n" }));
  expect(cards.map((c) => c.title)).toEqual(["d", "e"]);
  expect(cards).toEqual(core.listCards().slice(3));
});

test("bulk add keeps filing past a bad line, reports it with its number, and exits 1", async () => {
  const tooLong = "x".repeat(TITLE_MAX_BYTES + 1);
  const run = await cli(["add"], { stdin: `a\nb\nc\n${tooLong}\n` });
  expect(run.code).toBe(1);
  expect(lines(run)).toHaveLength(3);
  expect(run.stderr.startsWith("error: ")).toBe(true);
  expect(run.stderr).toContain("line 4");
  expect(core.listCards().map((c) => c.title)).toEqual(["a", "b", "c"]);

  // Every line failing is a failure: exit 1 and nothing at all on stdout.
  const allFailed = await cli(["add"], { stdin: `${tooLong}\n` });
  expect(allFailed.code).toBe(1);
  expect(allFailed.stdout).toBe("");
  expect(allFailed.stderr).toContain("line 1");
  expect(core.listCards()).toHaveLength(3);
});

test("an unreadable --body-file or --file is one error line, not a stack trace", async () => {
  core.createCard({ title: "f" }, member("simon").id);
  const missing = join(dir, "nonexistent.md");
  for (const args of [
    ["add", "t", "--body-file", missing],
    ["body", "1", "--file", missing],
  ]) {
    const stderr = await failed(2, args);
    expect(stderr.startsWith(`error: cannot read ${missing}: `)).toBe(true);
    expect(stderr).not.toContain("Bun v");
    expect(stderr).not.toContain("readFileSync");
  }
  expect(core.listCards()).toHaveLength(1);
  expect(core.getCard(1).body).toBe("");
});

test("add with no title and nothing on stdin is a usage error", async () => {
  await failed(2, ["add"], { stdin: "" });
  expect(core.listCards()).toEqual([]);
});

test("show prints the card, the body by line, and the activity with actor names", async () => {
  const body = "# Goal\n\nSome text.\n\n## Acceptance criteria\n\n1. it works\n";
  const card = core.createCard({ title: "Shown", body }, member("simon").id);

  const run = await ok(["show", "1"]);
  expect(run.stdout).toContain("Shown");
  expect(run.stdout).toContain("Idea");
  expect(run.stdout).toContain(localTime(card.createdAt));
  // Stored as given; shown line by line, every line marked (015): a line of the body cannot
  // read as an activity entry the member did not make.
  expect(core.getCard(1).body).toBe(body);
  expect(run.stdout).toContain(
    "> # Goal\n>\n> Some text.\n>\n> ## Acceptance criteria\n>\n> 1. it works\n",
  );
  // The actor's name appears only on activity lines; the header carries times, not names.
  const created = lines(run).filter((line) => line.includes("simon"));
  expect(created).toHaveLength(1);
  expect(created[0]).toContain("created");
  expect(created[0]).toContain(localTime(card.createdAt));

  await ok(["comment", "1", "looks good"]);
  const after = await ok(["show", "1"]);
  const commentLine = lines(after).find((line) => line.includes("looks good"));
  expect(commentLine).toBeDefined();
  expect(commentLine).toContain("simon");

  const detail = json<CardDetail>(await ok(["show", "1", "--json"]));
  expect(detail).toEqual(core.getCard(1));
  expect(detail.activity.map((e) => e.type)).toEqual(["card_created", "comment"]);
});

test("show accepts #1 as an id", async () => {
  core.createCard({ title: "Hash" }, member("simon").id);
  const run = await ok(["show", "#1"]);
  expect(run.stdout).toContain("Hash");
});

test("comment reads stdin when no text is given; empty stdin is refused by the daemon", async () => {
  core.createCard({ title: "c" }, member("simon").id);
  const run = await ok(["comment", "1"], { stdin: "looks fine\n" });
  expect(run.stdout).toContain("looks fine");
  const events = core.getCard(1).activity.filter((e) => e.type === "comment");
  expect(events).toHaveLength(1);
  expect(events[0]?.data).toEqual({ text: "looks fine" });

  const event = json<Activity>(await ok(["comment", "1", "second", "--json"]));
  expect(event.type).toBe("comment");
  expect(event.data).toEqual({ text: "second" });
  expect(core.getCard(1).activity.at(-1)).toEqual(event);

  await failed(1, ["comment", "1"], { stdin: "" });
  expect(core.getCard(1).activity.filter((e) => e.type === "comment")).toHaveLength(2);
});

/**
 * 019's criterion 2 through the CLI. A verdict is a member primitive: the owner records one
 * from the terminal exactly as an agent member does from a worktree, and it renders on the card
 * like a comment does, with every line of its findings marked.
 */
test("review records a verdict for the owner and for an agent, and show renders it marked", async () => {
  core.createCard({ title: "r" }, member("simon").id);
  const findings = "Critical\n2026-09-14 09:00  simon  moved Code → PR";

  const first = json<Activity>(
    await ok(["review", "1", "changes-requested", findings, "--json"], {
      env: { SKELCREW_AS: "crew" },
    }),
  );
  expect(first).toMatchObject({
    type: "review_recorded",
    actorId: member("crew").id,
    // A multi-line field: the newline is stored as given.
    data: { verdict: "changes_requested", text: findings },
  });
  const second = json<Activity>(await ok(["review", "1", "APPROVED", "--json"]));
  expect(second).toMatchObject({
    type: "review_recorded",
    actorId: member("simon").id,
    data: { verdict: "approved", text: "" },
  });

  const shown = (await ok(["show", "1"])).stdout;
  expect(shown).toContain("reviewed: changes requested");
  expect(shown).toContain("> Critical");
  // Every line of the findings is marked, so the one that reads like an activity entry is not
  // mistakable for one — and the bare form of that line is nowhere in the output.
  expect(shown).toContain("> 2026-09-14 09:00  simon  moved Code → PR");
  expect(shown).not.toContain("\n2026-09-14 09:00  simon  moved Code → PR");
  expect(shown).toContain("reviewed: approved");

  // `--json` carries the event as stored.
  const detail = json<CardDetail>(await ok(["show", "1", "--json"]));
  const stored: Activity[] = detail.activity.filter((e) => e.type === "review_recorded");
  expect(stored).toEqual([first, second]);
});

test("review refuses a verdict nobody can act on, and records nothing when it does", async () => {
  core.createCard({ title: "r" }, member("simon").id);
  const recorded = () => core.getCard(1).activity.filter((e) => e.type === "review_recorded");

  // Usage errors: no verdict, an unknown one, and changes-requested with no findings.
  expect(await failed(2, ["review", "1"])).toContain("verdict");
  expect(await failed(2, ["review", "1", "looks-fine"])).toContain("verdict");
  expect(await failed(2, ["review", "1", "changes-requested"])).toContain("findings");
  expect(recorded()).toHaveLength(0);

  // The daemon's refusals: a control character, and a text over the comment cap.
  expect(await failed(1, ["review", "1", "approved", "a\rb"])).toContain("U+000D");
  expect(await failed(1, ["review", "1", "approved", "a\x1b[2Kb"])).toContain("U+001B");
  await failed(1, ["review", "1", "approved", "a".repeat(COMMENT_MAX_BYTES + 1)]);
  expect(recorded()).toHaveLength(0);

  // And an archived card refuses.
  await ok(["review", "1", "approved"]);
  core.archiveCard(1, member("simon").id);
  expect(await failed(1, ["review", "1", "approved"])).toContain("archived");
  expect(recorded()).toHaveLength(1);
});

test("mv moves the card, case-insensitively, and posts -m after a successful move", async () => {
  core.createCard({ title: "m" }, member("simon").id);

  await ok(["mv", "1", "spec"]);
  expect((await ok(["show", "1"])).stdout).toContain("Spec");
  expect(core.getCard(1).phase).toBe("spec");
  expect(lines(await ok(["ls"]))[0]).toContain(TRACK.spec);

  const moved = json<Card>(await ok(["mv", "1", "CODE", "-m", "approved", "--json"]));
  expect(moved.phase).toBe("code");
  expect(lines(await ok(["ls"]))[0]).toContain(TRACK.code);
  const tail = core.getCard(1).activity.slice(-2);
  expect(tail[0]?.type).toBe("card_moved");
  expect(tail[0]?.data).toEqual({ from: "spec", to: "code" });
  expect(tail[1]?.type).toBe("comment");
  expect(tail[1]?.data).toEqual({ text: "approved" });
  expect(tail.map((e) => e.actorId)).toEqual([member("simon").id, member("simon").id]);
});

test("an agent's move through an owner gate is refused and posts nothing", async () => {
  core.createCard({ title: "g" }, member("simon").id);
  core.moveCard(1, "spec", member("simon").id);
  core.moveCard(1, "code", member("simon").id);

  // 016: every phase is the owner's to leave, Code included.
  const stderr = await failed(1, ["mv", "1", "pr", "-m", "send on", "--as", "crew-1"]);
  expect(stderr).toContain("forbidden");
  const crew = member("crew-1");
  expect(crew.kind).toBe("agent");
  const detail = core.getCard(1);
  expect(detail.phase).toBe("code");
  expect(detail.activity.some((e) => e.type === "comment" && e.data.text === "send on")).toBe(
    false,
  );
  expect(detail.activity.at(-1)).toMatchObject({
    type: "move_rejected",
    actorId: crew.id,
    data: { from: "code", to: "pr" },
  });

  // The owner's own move goes through, and posts its note.
  await ok(["mv", "1", "pr", "-m", "note"]);
  const tail = core.getCard(1).activity.slice(-2);
  expect(tail.map((e) => e.type)).toEqual(["card_moved", "comment"]);
  expect(tail.map((e) => e.actorId)).toEqual([member("simon").id, member("simon").id]);
});

/**
 * 016, criteria 3-7 where the agent meets them: the CLI, speaking as `crew`, against a live
 * daemon holding a card the `runner` member has claimed. The five verbs are the ones the
 * allowlist withholds from the agent's tool calls — reachable anyway from a subprocess, and
 * refused by the daemon on its own facts whatever called.
 */
test("the five gate verbs as crew are refused by the daemon on a card the runner holds", async () => {
  const runner = core.ensureMember("runner", "agent");
  const card = core.createCard({ title: "held by the runner" }, member("simon").id);
  core.moveCard(card.id, "code", member("simon").id);
  const claimed = core.claimCard(card.id, {}, runner.id);
  core.requestAttention(card.id, { to: member("simon").id, note: "allow Bash?" }, runner.id);
  const before = core.getCard(card.id);

  // The kind of refusal is part of the criteria: `forbidden` for the four the core decides on
  // the gate, `conflict` for the claim, which is the holder's lease saying so.
  const refusals: Array<[string, string[]]> = [
    ["forbidden", ["mv", "1", "pr"]],
    ["forbidden", ["mv", "1", "done"]],
    ["forbidden", ["mv", "1", "idea"]],
    ["forbidden", ["release", "1"]],
    ["forbidden", ["archive", "1"]],
    ["conflict", ["claim", "1"]],
    ["forbidden", ["resolve", "1", "-m", "allow"]],
  ];
  for (const [kind, args] of refusals) {
    const stderr = await failed(1, [...args, "--as", "crew"]);
    expect([args, stderr.includes(kind)]).toEqual([args, true]);
  }

  // The card is where it was: same phase, the runner's claim, the owner's request still open.
  const after = core.getCard(card.id);
  expect(after.phase).toBe("code");
  expect(after.claim).toEqual(claimed.claim);
  expect(after.archivedAt).toBeNull();
  expect(after.attention).toEqual(before.attention);
  expect(json<OpenAttention[]>(await ok(["queue", "--json"])).map((a) => a.cardId)).toEqual([1]);
  // The only thing recorded is the rejected moves, each attributed to crew.
  const crew = member("crew");
  expect(after.activity.filter((e) => e.seq > (before.activity.at(-1)?.seq ?? 0))).toHaveLength(3);
  expect(after.activity.slice(-3).map((e) => [e.type, e.actorId])).toEqual([
    ["move_rejected", crew.id],
    ["move_rejected", crew.id],
    ["move_rejected", crew.id],
  ]);

  // A free card is no different for archive: "done" is the owner's call either way.
  const free = core.createCard({ title: "free" }, member("simon").id);
  expect(
    (await failed(1, ["archive", String(free.id), "--as", "crew"])).includes("forbidden"),
  ).toBe(true);
  expect(core.getCard(free.id).archivedAt).toBeNull();
});

test("usage errors exit 2 and daemon errors exit 1, with stdout empty", async () => {
  core.createCard({ title: "u" }, member("simon").id);

  const badPhase = await failed(2, ["mv", "1", "review"]);
  for (const phase of PHASES) expect(badPhase).toContain(phase.id);

  const notFound = await failed(1, ["mv", "999", "spec"]);
  expect(notFound).toContain("999");

  await failed(2, ["frob"]);
  await failed(2, ["show"]);
  await failed(2, ["show", "abc"]);
  await failed(2, ["ls", "--bogus"]);
  await failed(2, ["add", "t", "--body", "x", "--body-file", "y"]);

  const notFoundJson = await cli(["show", "999", "--json"]);
  expect(notFoundJson.code).toBe(1);
  expect(notFoundJson.stdout).toBe("");
  expect(notFoundJson.stderr.startsWith("error: ")).toBe(true);
  expect(notFoundJson.stderr).toContain("999");
});

test("identity: owner by default, SKELCREW_AS, and --as beating the variable", async () => {
  core.createCard({ title: "who" }, member("simon").id);

  await ok(["comment", "1", "mine"]);
  await ok(["comment", "1", "hi"], { env: { SKELCREW_AS: "crew-2" } });
  await ok(["comment", "1", "hey", "--as", "crew-3"], { env: { SKELCREW_AS: "crew-2" } });

  const comments = core.getCard(1).activity.filter((e) => e.type === "comment");
  expect(comments.map((e) => e.actorId)).toEqual([
    member("simon").id,
    member("crew-2").id,
    member("crew-3").id,
  ]);
  expect(member("crew-2").kind).toBe("agent");
  expect(member("crew-3").kind).toBe("agent");

  const ls = await ok(["ls", "--json"]);
  expect(ls.stdout).not.toContain("crew-2");
  expect(ls.stdout).not.toContain("crew-3");

  const detail = json<CardDetail>(await ok(["show", "1", "--json"]));
  expect(detail.activity.map((e) => e.actorId)).toContain(member("crew-2").id);
  expect(detail.activity.map((e) => e.actorId)).toContain(member("crew-3").id);

  const shown = await ok(["show", "1"]);
  expect(lines(shown).find((l) => l.includes("hi"))).toContain("crew-2");
  expect(lines(shown).find((l) => l.includes("hey"))).toContain("crew-3");
});

test("--as runner is refused by the daemon: the runner's name is its own (028)", async () => {
  core.createCard({ title: "who" }, member("simon").id);

  const stderr = await failed(1, ["ls", "--as", "runner"]);
  expect(stderr).toContain("runner");
  expect(stderr).toContain("the daemon's own");
  // Nothing joined, here or under any other spelling of the same trimmed name.
  expect(core.listMembers().map((m) => m.name)).toEqual(["simon"]);
  expect(await failed(1, ["ls", "--as", " runner "])).toContain("runner");
  expect(core.listMembers().map((m) => m.name)).toEqual(["simon"]);
  // Every other name still speaks, including the crew the runner spawns agents as.
  await ok(["comment", "1", "still me", "--as", "crew"]);
  expect(core.listMembers().map((m) => m.name)).toEqual(["simon", "crew"]);
});

test('an empty identity fails closed: --as "" is a usage error, SKELCREW_AS="" is refused', async () => {
  core.createCard({ title: "who" }, member("simon").id);

  await failed(2, ["comment", "1", "flag", "--as", ""]);
  const stderr = await failed(1, ["comment", "1", "variable"], { env: { SKELCREW_AS: "" } });
  expect(stderr).toContain("(invalid)");
  // Neither posted anything, as anyone: the owner's name was never assumed.
  expect(core.getCard(1).activity.filter((e) => e.type === "comment")).toEqual([]);
  expect(core.listMembers().map((m) => m.name)).toEqual(["simon"]);

  // An empty variable does not hide a real flag, and vice versa the flag still wins.
  await ok(["comment", "1", "flagged", "--as", "crew-4"], { env: { SKELCREW_AS: "" } });
  expect(core.getCard(1).activity.at(-1)?.actorId).toBe(member("crew-4").id);
});

test("body replaces the body from stdin or a file; over the cap is refused", async () => {
  core.createCard({ title: "b" }, member("simon").id);

  const fromStdin = "# Goal\n\nx\n";
  const card = json<Card>(await ok(["body", "1", "--json"], { stdin: fromStdin }));
  expect(card.body).toBe(fromStdin);
  expect(core.getCard(1).body).toBe(fromStdin);
  // Stored as given, shown line by line with every line marked (015).
  expect((await ok(["show", "1"])).stdout).toContain("> # Goal\n>\n> x\n");

  const fromFile = "# Goal\n\nfrom a file\n\n## Out of scope\n\n- nothing\n";
  const path = join(dir, "spec.md");
  writeFileSync(path, fromFile);
  await ok(["body", "1", "--file", path]);
  expect(core.getCard(1).body).toBe(fromFile);
  expect((await ok(["show", "1"])).stdout).toContain(
    "> # Goal\n>\n> from a file\n>\n> ## Out of scope\n>\n> - nothing\n",
  );

  const stderr = await failed(1, ["body", "1"], { stdin: "y".repeat(BODY_MAX_BYTES + 1) });
  expect(stderr).toContain("body");
  expect(core.getCard(1).body).toBe(fromFile);
});

test("refs sets branch, pr, and commits; no flag is a usage error; a bad url is refused", async () => {
  core.createCard({ title: "r" }, member("simon").id);

  const card = json<Card>(
    await ok([
      "refs",
      "1",
      "--branch",
      "feat/x",
      "--pr",
      "https://github.com/o/r/pull/1",
      "--commit",
      "abcdef0",
      "--commit",
      "1234567",
      "--json",
    ]),
  );
  expect(card.refs).toEqual({
    branch: "feat/x",
    prUrl: "https://github.com/o/r/pull/1",
    commits: ["abcdef0", "1234567"],
  });

  const shown = (await ok(["show", "1"])).stdout;
  expect(shown).toContain("feat/x");
  expect(shown).toContain("https://github.com/o/r/pull/1");
  expect(shown).toContain("abcdef0");
  expect(shown).toContain("1234567");

  await failed(2, ["refs", "1"]);
  const stderr = await failed(1, ["refs", "1", "--pr", "http://github.com/o/r/pull/2"]);
  expect(stderr).toContain("https");
  expect(core.getCard(1).refs.prUrl).toBe("https://github.com/o/r/pull/1");
});

test("refs --spec records the spec path on the card, in show, and in the activity", async () => {
  core.createCard({ title: "r" }, member("simon").id);
  await ok(["refs", "1", "--branch", "skelcrew/1-artefact-refs"]);

  const run = await ok(["refs", "1", "--spec", "docs/specs/011-x.md"]);
  expect(run.stdout).toContain("spec=docs/specs/011-x.md");
  expect(core.getCard(1).refs.specPath).toBe("docs/specs/011-x.md");

  const shown = (await ok(["show", "1"])).stdout;
  expect(shown).toContain("spec:    docs/specs/011-x.md");
  // The activity names what this call set, not the branch the card already carried.
  const activity = shown.split("\n").filter((l) => l.includes("set refs"));
  expect(activity).toHaveLength(2);
  expect(activity[1]).toEndWith("set refs spec=docs/specs/011-x.md");

  const stderr = await failed(2, ["refs", "1"]);
  expect(stderr).toContain("at least one of --branch, --spec, --pr, --commit is required");
});

test("archive hides the card from ls, ls --all marks it, and show still works", async () => {
  core.createCard({ title: "keep" }, member("simon").id);
  core.createCard({ title: "gone" }, member("simon").id);

  const archived = json<Card>(await ok(["archive", "2", "--json"]));
  expect(archived.archivedAt).not.toBeNull();
  expect(archived).toEqual(core.listCards({ includeArchived: true })[1] as Card);

  const ls = await ok(["ls"]);
  expect(ls.stdout).toContain("#1");
  expect(ls.stdout).not.toContain("#2");

  const all = await ok(["ls", "--all"]);
  const row = lines(all).find((l) => l.includes("#2"));
  expect(row).toContain("gone");
  expect(row?.toLowerCase()).toContain("archived");

  const shown = await ok(["show", "2"]);
  expect(shown.stdout).toContain("gone");
});

test("every command names the socket path and bun run daemon when nothing listens", async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  extraDirs.push(empty);
  const deadSocket = join(empty, "skelcrew.sock");
  const commands: Array<{ args: string[]; stdin?: string }> = [
    { args: ["ls"] },
    { args: ["show", "1"] },
    { args: ["add", "x"] },
    { args: ["comment", "1", "x"] },
    { args: ["mv", "1", "spec"] },
    { args: ["body", "1"], stdin: "b" },
    { args: ["refs", "1", "--branch", "b"] },
    { args: ["archive", "1"] },
  ];
  for (const { args, stdin } of commands) {
    const stderr = await failed(1, args, { dataDir: empty, stdin });
    expect(stderr).toContain(deadSocket);
    expect(stderr).toContain("bun run daemon");
  }
  const withJson = await failed(1, ["ls", "--json"], { dataDir: empty });
  expect(withJson).toContain(deadSocket);
});

test("a socket file nobody answers on is reported the same way and left in place", async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  extraDirs.push(empty);
  const stale = join(empty, "skelcrew.sock");
  writeFileSync(stale, "");
  const stderr = await failed(1, ["ls"], { dataDir: empty });
  expect(stderr).toContain(stale);
  expect(stderr).toContain("bun run daemon");
  expect(existsSync(stale)).toBe(true);
});

test("outside a git repository with no SKELCREW_DIR it says so and exits 1", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  extraDirs.push(outside);
  const stderr = await failed(1, ["ls"], { dataDir: null, cwd: outside });
  expect(stderr).toContain("not inside a git repository");
  expect(existsSync(join(outside, ".skelcrew"))).toBe(false);
});

test("from a subdirectory of a git repository the CLI reaches the daemon on <root>/.skelcrew/", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  extraDirs.push(repo);
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".skelcrew"));
  const nested = join(repo, "a", "b");
  mkdirSync(nested, { recursive: true });
  const repoCore = openCore(":memory:", { owner: "simon" });
  const repoServer = startServer({
    core: repoCore,
    socketPath: join(repo, ".skelcrew", "skelcrew.sock"),
    reserved: [RUNNER_MEMBER_NAME],
  });
  extraServers.push({
    stop() {
      repoServer.stop();
      repoCore.close();
    },
  });
  repoCore.createCard({ title: "in the repo" }, 1);

  const run = await ok(["ls"], { dataDir: null, cwd: nested });
  expect(run.stdout).toContain("in the repo");
  expect(existsSync(join(nested, ".skelcrew"))).toBe(false);
});

// --- attention requests (010) ---

function openAttention(): OpenAttention[] {
  return core.listAttention();
}

test("no command and queue print what waits on the invoking member; --json is listAttention", async () => {
  core.createCard({ title: "First card" }, member("simon").id);
  core.createCard({ title: "Second" }, member("simon").id);

  const empty = await ok([]);
  expect(empty.stdout.toLowerCase()).toContain("nothing");
  expect(await ok(["queue"])).toEqual(empty);
  expect(json<OpenAttention[]>(await ok(["queue", "--json"]))).toEqual([]);

  await ok(["attention", "1", "spec ready", "--move", "code", "--as", "crew-1"]);
  const crew = member("crew-1");
  expect(core.getCard(1).attention).toMatchObject({
    to: member("simon").id,
    note: "spec ready",
    moves: ["code"],
    raisedBy: crew.id,
  });

  const home = await ok([]);
  for (const fragment of [
    "#1",
    "First card",
    "Idea",
    "crew-1",
    "spec ready",
    "skelcrew mv 1 code",
    "skelcrew resolve 1",
    localTime(core.getCard(1).attention?.raisedAt as number),
  ]) {
    expect(home.stdout).toContain(fragment);
  }
  expect(home.stdout).not.toContain("#2");
  expect(await ok(["queue"])).toEqual(home);
  expect(json<OpenAttention[]>(await ok(["queue", "--json"]))).toEqual(
    core.listAttention({ to: member("simon").id }),
  );

  // Addressed to crew-1: not in the owner's queue, in crew-1's, and in --all.
  const toCrew = await ok(["queue", "--as", "crew-1"]);
  expect(toCrew.stdout.toLowerCase()).toContain("nothing");
  await ok(["attention", "2", "your turn", "--to", "crew-1"]);
  const crewQueue = await ok(["queue", "--as", "crew-1"]);
  expect(crewQueue.stdout).toContain("#2");
  expect(crewQueue.stdout).toContain("your turn");
  expect(crewQueue.stdout).not.toContain("#1");
  expect(json<OpenAttention[]>(await ok(["queue", "--as", "crew-1", "--json"]))).toEqual(
    core.listAttention({ to: crew.id }),
  );
  const mine = await ok(["queue"]);
  expect(mine.stdout).toContain("#1");
  expect(mine.stdout).not.toContain("#2");

  const all = await ok(["queue", "--all"]);
  expect(all.stdout).toContain("#1");
  expect(all.stdout).toContain("#2");
  expect(all.stdout.indexOf("#1")).toBeLessThan(all.stdout.indexOf("#2"));
  expect(json<OpenAttention[]>(await ok(["queue", "--all", "--json"]))).toEqual(openAttention());
  expect(openAttention()).toHaveLength(2);

  await failed(2, ["queue", "extra"]);
  await failed(2, ["frob"]);
});

test("attention raises to the owner by default, to --to by name, and validates its arguments", async () => {
  core.createCard({ title: "a" }, member("simon").id);
  core.ensureMember("crew-2", "agent");

  const raised = json<Card>(
    await ok(["attention", "1", "spec ready", "--move", "code", "--as", "crew-1", "--json"]),
  );
  expect(raised.attention).toMatchObject({ to: member("simon").id, moves: ["code"] });
  expect(raised).toEqual(core.listCards()[0] as Card);
  const plain = await ok(["attention", "1", "again", "--move", "code", "--move", "pr"]);
  expect(plain.stdout).toContain("#1");
  expect(plain.stdout).toContain("simon");
  expect(core.getCard(1).attention).toMatchObject({ note: "again", moves: ["code", "pr"] });

  await ok(["attention", "1", "please look", "--to", "crew-2"]);
  expect(core.getCard(1).attention).toMatchObject({
    to: member("crew-2").id,
    note: "please look",
    moves: [],
    raisedBy: member("simon").id,
  });
  const requested = core.getCard(1).activity.filter((e) => e.type === "attention_requested");
  expect(requested).toHaveLength(3);

  const nobody = await failed(1, ["attention", "1", "hi", "--to", "nobody"]);
  expect(nobody).toContain("not_found");
  expect(nobody).toContain("nobody");
  const badPhase = await failed(2, ["attention", "1", "hi", "--move", "review"]);
  for (const phase of PHASES) expect(badPhase).toContain(phase.id);
  await failed(2, ["attention", "1"]);
  await failed(2, ["attention"]);
  const empty = await failed(1, ["attention", "1", "  "]);
  expect(empty).toContain("invalid");
  await failed(1, ["attention", "999", "hi"]);
  expect(core.getCard(1).attention?.note).toBe("please look");
  expect(core.listMembers().map((m) => m.name)).not.toContain("nobody");
});

test("mv resolves the request; resolve answers it; invalid and forbidden exit 1", async () => {
  core.createCard({ title: "r" }, member("simon").id);
  const agent = core.ensureMember("crew-1", "agent");
  core.requestAttention(
    1,
    { to: member("simon").id, note: "spec ready", moves: ["code"] },
    agent.id,
  );

  await ok(["mv", "1", "code"]);
  expect(openAttention()).toEqual([]);
  expect(json<OpenAttention[]>(await ok(["queue", "--json"]))).toEqual([]);
  expect(
    core
      .getCard(1)
      .activity.slice(-2)
      .map((e) => e.type),
  ).toEqual(["card_moved", "attention_resolved"]);

  core.requestAttention(1, { to: member("simon").id, note: "pr ready" }, agent.id);
  const resolved = json<Card>(await ok(["resolve", "1", "-m", "looks fine", "--json"]));
  expect(resolved.attention).toBeNull();
  const tail = core.getCard(1).activity.slice(-2);
  expect(tail[0]).toMatchObject({ type: "comment", data: { text: "looks fine" } });
  expect(tail[1]).toMatchObject({ type: "attention_resolved", data: { how: "answered" } });
  expect(openAttention()).toEqual([]);

  const again = await failed(1, ["resolve", "1"]);
  expect(again).toContain("invalid");

  core.requestAttention(1, { to: member("simon").id, note: "one more" }, agent.id);
  const forbidden = await failed(1, ["resolve", "1", "--as", "crew-9"]);
  expect(forbidden).toContain("forbidden");
  expect(core.getCard(1).attention?.note).toBe("one more");

  const plain = await ok(["resolve", "1"]);
  expect(plain.stdout).toContain("#1");
  expect(core.getCard(1).attention).toBeNull();
  await failed(2, ["resolve"]);
  await failed(2, ["resolve", "1", "extra"]);
});

test("ls marks a card waiting on me with ! and on someone else with ?; show prints the request", async () => {
  core.createCard({ title: "Mine" }, member("simon").id);
  core.createCard({ title: "Theirs" }, member("simon").id);
  core.createCard({ title: "Nobody's" }, member("simon").id);
  const agent = core.ensureMember("crew-1", "agent");
  core.requestAttention(
    1,
    { to: member("simon").id, note: "spec ready", moves: ["code", "pr"] },
    agent.id,
  );
  core.requestAttention(2, { to: agent.id, note: "your turn" }, member("simon").id);

  const asOwner = lines(await ok(["ls"]));
  expect(asOwner).toHaveLength(3);
  expect(asOwner[0]?.startsWith("!")).toBe(true);
  expect(asOwner[0]).toContain("#1");
  // 024: the same fact in words, between the phase and the title.
  expect(asOwner[0]).toContain("waiting on you: spec ready");
  expect(asOwner[1]?.startsWith("?")).toBe(true);
  expect(asOwner[1]).toContain("#2");
  expect(asOwner[1]).toContain("waiting on crew-1");
  expect(asOwner[2]?.startsWith("!")).toBe(false);
  expect(asOwner[2]?.startsWith("?")).toBe(false);
  expect(asOwner[2]).toContain("#3");
  expect(asOwner[2]).toContain(TRACK.idea);

  const asAgent = lines(await ok(["ls", "--as", "crew-1"]));
  expect(asAgent[0]?.startsWith("?")).toBe(true);
  expect(asAgent[1]?.startsWith("!")).toBe(true);
  expect(json<Card[]>(await ok(["ls", "--json"]))).toEqual(core.listCards());

  const shown = await ok(["show", "1"]);
  const header = shown.stdout.split("\n\n")[0] as string;
  expect(header).toContain("simon");
  expect(header).toContain("crew-1");
  expect(header).toContain("spec ready");
  expect(header).toContain("code");
  expect(header).toContain("pr");
  expect(header).toContain(localTime(core.getCard(1).attention?.raisedAt as number));
  const requestedLine = lines(shown).find((l) => l.includes("crew-1") && l.includes("spec ready"));
  expect(requestedLine).toBeDefined();

  await ok(["resolve", "1", "-m", "approved"]);
  await ok(["mv", "2", "spec"]);
  const after = lines(await ok(["ls"]));
  expect(after.every((l) => !l.startsWith("!") && !l.startsWith("?"))).toBe(true);
  const shownAfter = await ok(["show", "1"]);
  const headerAfter = shownAfter.stdout.split("\n\n")[0] as string;
  expect(headerAfter).not.toContain("spec ready");
  const activity = lines(shownAfter).filter((l) => l.includes("attention") || l.includes("asked"));
  const resolvedLine = lines(shownAfter).find((l) => l.includes("resolved"));
  expect(resolvedLine).toContain("simon");
  expect(resolvedLine).toContain("answered");
  expect(activity.length).toBeGreaterThanOrEqual(2);
  expect(json<CardDetail>(await ok(["show", "1", "--json"]))).toEqual(core.getCard(1));
  const movedLine = lines(await ok(["show", "2"])).find((l) => l.includes("resolved"));
  expect(movedLine).toContain("Spec");
});

/** Reads a stream line by line, on demand, with a timeout so a silent watch fails the test. */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffer = "";
  (async () => {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else queue.push(line);
        newline = buffer.indexOf("\n");
      }
    }
  })();
  return {
    next(): Promise<string> {
      const line = queue.shift();
      if (line !== undefined) return Promise.resolve(line);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no line within 4s")), 4000);
        waiters.push((l) => {
          clearTimeout(timer);
          resolve(l);
        });
      });
    },
    /** The lines already read but not taken, for a test that asserts silence. */
    pending(): string[] {
      return [...queue];
    },
  };
}

/** A notifier that records `(title, text)` pairs to a file instead of notifying anyone. */
function recordingNotifier() {
  const log = join(dir, "notify.log");
  const script = join(dir, "notify.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\t%s\\n' "$1" "$2" >> "${log}"\n`, { mode: 0o755 });
  return {
    script,
    entries(): string[][] {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => l.split("\t"));
    },
  };
}

function spawnWatch(args: string[], env: Record<string, string>) {
  const full: Record<string, string | undefined> = { ...process.env };
  delete full.SKELCREW_AS;
  // Each test's notifier comes from its own `env` and nowhere else: an inherited
  // `SKELCREW_NOTIFY` wins over `PATH` inside `selectNotifier`, so a developer who has the
  // variable set would otherwise have these tests fire real notifications.
  delete full.SKELCREW_NOTIFY;
  full.SKELCREW_DIR = dir;
  full.TZ = TZ;
  Object.assign(full, env);
  const proc = Bun.spawn([process.execPath, MAIN, "watch", ...args], {
    cwd: dir,
    env: full,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  watchers.push({
    kill() {
      if (proc.exitCode === null) proc.kill();
    },
  });
  return {
    proc,
    stdout: lineReader(proc.stdout as ReadableStream<Uint8Array>),
    stderr: lineReader(proc.stderr as ReadableStream<Uint8Array>),
  };
}

test("watch tails events, pings once for a request to me and not for one to someone else, exits 0 on SIGINT", async () => {
  const card = core.createCard({ title: "Watched" }, member("simon").id);
  const agent = core.ensureMember("crew-1", "agent");
  const rec = recordingNotifier();
  const watch = spawnWatch([], { SKELCREW_NOTIFY: rec.script });
  const ready = await watch.stderr.next();
  expect(ready).toContain("simon");

  core.comment(card.id, "hello there", agent.id);
  const commented = await watch.stdout.next();
  expect(commented).toContain("hello there");
  expect(commented).toContain("crew-1");

  core.moveCard(card.id, "spec", member("simon").id);
  const moved = await watch.stdout.next();
  expect(moved).toContain("Spec");
  expect(moved).toContain("simon");
  expect(rec.entries()).toEqual([]);

  core.requestAttention(
    card.id,
    { to: member("simon").id, note: "spec ready", moves: ["code"] },
    agent.id,
  );
  const requested = await watch.stdout.next();
  expect(requested).toContain("spec ready");
  expect(requested).toContain("crew-1");

  // Events are handled in order, so once the next event's line is out, the ping for the
  // previous one has finished: exactly one, for the request addressed to the watcher.
  core.comment(card.id, "after the ping", agent.id);
  expect(await watch.stdout.next()).toContain("after the ping");
  const entries = rec.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]?.[0]).toBe("skelcrew");
  expect(entries[0]?.[1]).toContain("#1");
  expect(entries[0]?.[1]).toContain("Watched");
  expect(entries[0]?.[1]).toContain("spec ready");

  // A request to someone else, on another card so the watcher's stays open: no ping.
  const theirs = core.createCard({ title: "Theirs" }, member("simon").id);
  expect(await watch.stdout.next()).toContain("Theirs");
  core.requestAttention(theirs.id, { to: agent.id, note: "your turn" }, member("simon").id);
  const other = await watch.stdout.next();
  expect(other).toContain("your turn");
  core.comment(theirs.id, "settled", agent.id);
  expect(await watch.stdout.next()).toContain("settled");
  expect(rec.entries()).toHaveLength(1);

  core.resolveAttention(theirs.id, "thanks", agent.id);
  expect(await watch.stdout.next()).toContain("thanks");
  expect(await watch.stdout.next()).toContain("resolved");

  watch.proc.kill("SIGINT");
  expect(await watch.proc.exited).toBe(0);
  expect(rec.entries()).toHaveLength(1);
});

test("watch --since replays existing events first, in order, without pinging for a resolved request", async () => {
  const card = core.createCard({ title: "History" }, member("simon").id);
  const agent = core.ensureMember("crew-1", "agent");
  core.comment(card.id, "one", agent.id);
  core.requestAttention(card.id, { to: member("simon").id, note: "spec ready" }, agent.id);
  core.moveCard(card.id, "spec", member("simon").id);
  core.comment(card.id, "two", member("simon").id);
  const history = core.activitySince(0);
  expect(history.map((e) => e.type)).toEqual([
    "card_created",
    "member_joined",
    "comment",
    "attention_requested",
    "card_moved",
    "attention_resolved",
    "comment",
  ]);

  const rec = recordingNotifier();
  const watch = spawnWatch(["--since", "0"], { SKELCREW_NOTIFY: rec.script });
  const replayed: string[] = [];
  for (let i = 0; i < history.length; i += 1) replayed.push(await watch.stdout.next());
  expect(replayed[0]).toContain("History");
  expect(replayed[1]).toContain("crew-1");
  expect(replayed[2]).toContain("one");
  expect(replayed[3]).toContain("spec ready");
  expect(replayed[4]).toContain("Spec");
  expect(replayed[5]).toContain("resolved");
  expect(replayed[6]).toContain("two");
  expect(rec.entries()).toEqual([]);

  // Live events follow the replay.
  core.comment(card.id, "three", agent.id);
  expect(await watch.stdout.next()).toContain("three");

  watch.proc.kill("SIGINT");
  expect(await watch.proc.exited).toBe(0);

  await failed(2, ["watch", "--since", "x"]);
  await failed(2, ["watch", "extra"]);
});

test("watch replays only after the given seq", async () => {
  const card = core.createCard({ title: "Partial" }, member("simon").id);
  core.comment(card.id, "old", member("simon").id);
  const pivot = core.activitySince(0).at(-1)?.seq as number;
  core.comment(card.id, "new", member("simon").id);

  const rec = recordingNotifier();
  const watch = spawnWatch(["--since", String(pivot)], { SKELCREW_NOTIFY: rec.script });
  const first = await watch.stdout.next();
  expect(first).toContain("new");
  expect(first).not.toContain("old");
  watch.proc.kill("SIGINT");
  expect(await watch.proc.exited).toBe(0);
});

test("watch exits 1 with an error naming the socket when the daemon goes away", async () => {
  core.createCard({ title: "Orphan" }, member("simon").id);
  const rec = recordingNotifier();
  const watch = spawnWatch([], { SKELCREW_NOTIFY: rec.script });
  await watch.stderr.next();

  server.stop();

  expect(await watch.proc.exited).toBe(1);
  const error = await watch.stderr.next();
  expect(error.startsWith("error: ")).toBe(true);
  expect(error).toContain(socketPath);
});

test("watch still prints the event line when the notifier fails, and reports the failure", async () => {
  const card = core.createCard({ title: "Unpingable" }, member("simon").id);
  const agent = core.ensureMember("crew-1", "agent");
  const watch = spawnWatch([], { SKELCREW_NOTIFY: join(dir, "missing-notifier.sh") });
  await watch.stderr.next();

  core.requestAttention(card.id, { to: member("simon").id, note: "spec ready" }, agent.id);
  const line = await watch.stdout.next();
  expect(line).toContain("spec ready");
  const error = await watch.stderr.next();
  expect(error.startsWith("error: ")).toBe(true);

  // The tail goes on after a failed ping.
  core.comment(card.id, "still here", agent.id);
  expect(await watch.stdout.next()).toContain("still here");
  watch.proc.kill("SIGINT");
  expect(await watch.proc.exited).toBe(0);
});

test("watch with SKELCREW_NOTIFY=none tails as usual and pings nobody, without an error", async () => {
  const card = core.createCard({ title: "Quiet" }, member("simon").id);
  const agent = core.ensureMember("crew-1", "agent");
  const watch = spawnWatch([], { SKELCREW_NOTIFY: "none" });
  await watch.stderr.next();

  core.requestAttention(card.id, { to: member("simon").id, note: "spec ready" }, agent.id);
  expect(await watch.stdout.next()).toContain("spec ready");

  // Events are handled in order, so once the next event's line is out, the ping for the
  // request has been dealt with: `none` is off, not a command named `none` that cannot run.
  core.comment(card.id, "still here", agent.id);
  expect(await watch.stdout.next()).toContain("still here");
  expect(watch.stderr.pending()).toEqual([]);

  watch.proc.kill("SIGINT");
  expect(await watch.proc.exited).toBe(0);
});

test("watch --json is a usage error", async () => {
  await failed(2, ["watch", "--json"]);
});

// --- claims as leases (009) ---

test("claim, heartbeat, and release as the holder, a second agent, and the owner", async () => {
  core.createCard({ title: "Claimed" }, member("simon").id);
  core.moveCard(1, "code", member("simon").id);

  const claimed = await ok(["claim", "1", "--as", "crew-1"]);
  const crew1 = member("crew-1");
  const claim = core.getCard(1).claim;
  expect(claim).toMatchObject({ by: crew1.id, ttlSeconds: 120 });
  expect(claimed.stdout).toContain("#1");
  expect(claimed.stdout).toContain("crew-1");
  expect(claimed.stdout).toContain(localTime(claim?.expiresAt as number));

  const shown = await ok(["show", "1"]);
  const header = shown.stdout.split("\n\n")[0] as string;
  expect(header).toContain("crew-1");
  expect(header).toContain(localTime(claim?.claimedAt as number));
  expect(header).toContain(localTime(claim?.expiresAt as number));
  const claimedLine = lines(shown).find((l) => l.includes("claimed"));
  expect(claimedLine).toContain("crew-1");
  expect(claimedLine).toContain("120");

  const conflict = await failed(1, ["claim", "1", "--as", "crew-2"]);
  expect(conflict).toContain("conflict");
  expect(conflict).toContain("crew-1");
  expect(core.getCard(1).claim).toEqual(claim);

  const beat = await ok(["heartbeat", "1", "--as", "crew-1"]);
  expect(beat.stdout).toContain("#1");
  expect(core.getCard(1).claim?.expiresAt).toBeGreaterThanOrEqual(claim?.expiresAt as number);
  expect(core.getCard(1).claim?.claimedAt).toBe(claim?.claimedAt as number);
  expect((await failed(1, ["heartbeat", "1", "--as", "crew-2"])).includes("conflict")).toBe(true);
  expect((await failed(1, ["heartbeat", "1"])).includes("conflict")).toBe(true);
  expect(core.getCard(1).activity.filter((e) => e.type === "claimed")).toHaveLength(1);

  const forbidden = await failed(1, ["release", "1", "--as", "crew-2"]);
  expect(forbidden).toContain("forbidden");
  expect(core.getCard(1).claim?.by).toBe(crew1.id);

  const released = json<Card>(await ok(["release", "1", "-m", "done", "--as", "crew-1", "--json"]));
  expect(released.claim).toBeNull();
  expect(released).toEqual(core.listCards()[0] as Card);
  expect(core.getCard(1).activity.at(-1)).toMatchObject({
    type: "released",
    actorId: crew1.id,
    data: { reason: "done" },
  });

  // The owner releases anyone's claim; without -m the reason is null.
  const short = json<Card>(await ok(["claim", "1", "--ttl", "30", "--as", "crew-2", "--json"]));
  expect(short.claim).toMatchObject({ by: member("crew-2").id, ttlSeconds: 30 });
  expect(short).toEqual(core.listCards()[0] as Card);
  const plain = await ok(["release", "1"]);
  expect(plain.stdout).toContain("#1");
  expect(core.getCard(1).claim).toBeNull();
  expect(core.getCard(1).activity.at(-1)).toMatchObject({
    type: "released",
    actorId: member("simon").id,
    data: { reason: null },
  });
  // Releasing an unclaimed card is a no-op.
  await ok(["release", "1", "--as", "crew-2"]);
  expect(core.getCard(1).activity.at(-1)?.type).toBe("released");
  expect(core.getCard(1).activity.filter((e) => e.type === "released")).toHaveLength(2);

  // The TTL is clamped, and heartbeat --json is the card.
  const clamped = json<Card>(await ok(["claim", "1", "--ttl", "5", "--as", "crew-1", "--json"]));
  expect(clamped.claim?.ttlSeconds).toBe(10);
  const beatJson = json<Card>(await ok(["heartbeat", "1", "--as", "crew-1", "--json"]));
  expect(beatJson).toEqual(core.listCards()[0] as Card);

  // Usage errors exit 2; the daemon's refusals exit 1.
  await failed(2, ["claim", "1", "--ttl", "abc"]);
  await failed(2, ["claim", "1", "--ttl", ""]);
  await failed(2, ["claim"]);
  await failed(2, ["claim", "1", "extra"]);
  await failed(2, ["heartbeat"]);
  await failed(2, ["release"]);
  await failed(2, ["release", "1", "extra"]);
  core.createCard({ title: "Idea" }, member("simon").id);
  const invalid = await failed(1, ["claim", "2", "--as", "crew-1"]);
  expect(invalid).toContain("invalid");
  expect(invalid).toContain("idea");
  await failed(1, ["claim", "999"]);
  await failed(1, ["heartbeat", "999"]);
  await failed(1, ["release", "999"]);
});

test("ls marks a live claim * and a lapsed one ~; attention markers win; show prints the claim", async () => {
  for (const title of ["Live", "Lapsed", "Waiting", "Free"]) {
    const card = core.createCard({ title }, member("simon").id);
    core.moveCard(card.id, "code", member("simon").id);
  }
  const agent = core.ensureMember("crew-1", "agent");
  const live = core.claimCard(1, {}, agent.id).claim;
  // Card 2's claim is made on a clock a minute behind the CLI's: lapsed, and unswept.
  clockOffsetMs = -60_000;
  core.claimCard(2, { ttlSeconds: 10 }, agent.id);
  clockOffsetMs = 0;
  core.claimCard(3, {}, agent.id);
  core.requestAttention(3, { to: member("simon").id, note: "stuck" }, agent.id);
  expect(core.getCard(2).claim?.expiresAt).toBeLessThan(Date.now());

  const asOwner = lines(await ok(["ls"]));
  expect(asOwner).toHaveLength(4);
  expect(asOwner[0]?.[0]).toBe("*");
  expect(asOwner[0]).toContain("#1");
  // 024: the same four states in words, waiting outranking running as the marker does.
  expect(asOwner[0]).toContain(`running since ${localTime(live?.claimedAt as number).slice(-5)}`);
  expect(asOwner[1]?.[0]).toBe("~");
  expect(asOwner[1]).toContain("#2");
  expect(asOwner[1]).toContain("interrupted");
  expect(asOwner[2]?.[0]).toBe("!");
  expect(asOwner[2]).toContain("#3");
  expect(asOwner[2]).toContain("waiting on you: stuck");
  expect(asOwner[3]?.[0]).toBe(" ");
  expect(asOwner[3]).toContain("#4");
  expect(asOwner[3]).toContain(TRACK.code);
  expect(asOwner[3]).toContain("queued");

  const asAgent = lines(await ok(["ls", "--as", "crew-1"]));
  expect(asAgent.map((l) => l[0])).toEqual(["*", "~", "?", " "]);
  expect(json<Card[]>(await ok(["ls", "--json"]))).toEqual(core.listCards());

  const lapsed = core.getCard(2).claim;
  const shown = await ok(["show", "2"]);
  const header = shown.stdout.split("\n\n")[0] as string;
  expect(header).toContain("crew-1");
  expect(header).toContain(localTime(lapsed?.claimedAt as number));
  expect(header).toContain(localTime(lapsed?.expiresAt as number));
  expect(header).toContain("lapsed");
  const liveHeader = (await ok(["show", "1"])).stdout.split("\n\n")[0] as string;
  expect(liveHeader).toContain("crew-1");
  expect(liveHeader).not.toContain("lapsed");

  // The sweep clears the lapsed one; ls drops its marker and show records the interruption.
  expect(core.sweepClaims()).toEqual([2]);
  const after = lines(await ok(["ls"]));
  expect(after.map((l) => l[0])).toEqual(["*", " ", "!", " "]);
  // Swept: the card is free in a claimable phase, which is what "queued" is.
  expect(after[1]).toContain("queued");
  const shownAfter = await ok(["show", "2"]);
  expect(shownAfter.stdout.split("\n\n")[0]).not.toContain("crew-1");
  const interruptedLine = lines(shownAfter).find((l) => l.includes("interrupted"));
  expect(interruptedLine).toContain("crew-1");
  expect(interruptedLine).toContain(localTime(lapsed?.expiresAt as number));

  // A release clears the marker too, and its line carries the reason.
  await ok(["release", "1", "-m", "paused", "--as", "crew-1"]);
  expect(lines(await ok(["ls"])).map((l) => l[0])).toEqual([" ", " ", "!", " "]);
  const releasedLine = lines(await ok(["show", "1"])).find((l) => l.includes("released"));
  expect(releasedLine).toContain("crew-1");
  expect(releasedLine).toContain("paused");
  // Resolving the request on the claimed card shows its claim marker again.
  await ok(["resolve", "3"]);
  expect(lines(await ok(["ls"])).map((l) => l[0])).toEqual([" ", " ", "*", " "]);
  expect(json<CardDetail>(await ok(["show", "3", "--json"]))).toEqual(core.getCard(3));
});

// --- the status column (024) ---

/**
 * A row's cells: the marker is the first character, and every cell after it is separated from
 * the next by at least the two spaces `row` joins them with. A blank status leaves no cell,
 * which is what the table's blank row means.
 */
function cells(row: string): string[] {
  return [row.slice(0, 1), ...row.slice(3).split(/ {2,}/)];
}

/**
 * 024's criterion 2: one card per row of the table, read through the real CLI. The statuses
 * are their own column, between the phase name and the title, and the marker column stays.
 */
test("ls says what each card is doing, in a column between the phase and the title", async () => {
  const simon = member("simon").id;
  const agent = core.ensureMember("crew-1", "agent");
  for (const title of ["Mine", "Theirs", "Running", "Interrupted", "Queued", "Idle", "Gone"]) {
    const card = core.createCard({ title }, simon);
    if (title !== "Idle" && title !== "Gone") core.moveCard(card.id, "code", simon);
  }
  // A real permission question, whose whole note is three lines long.
  const question =
    "allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)\ninput:\n> rm -rf build";
  core.requestAttention(1, { to: simon, note: question }, agent.id);
  core.requestAttention(2, { to: agent.id, note: "your turn" }, simon);
  core.claimCard(3, {}, agent.id);
  // Card 4's claim is made on a clock a minute behind: lapsed, and not yet swept.
  clockOffsetMs = -60_000;
  core.claimCard(4, { ttlSeconds: 10 }, agent.id);
  clockOffsetMs = 0;
  core.archiveCard(7, simon);
  const since = localTime(core.getCard(3).claim?.claimedAt as number).slice(-5);

  const board = lines(await ok(["ls", "--all"])).map(cells);

  expect(board).toEqual([
    // The label is 16 characters and the note's first line fills the column's 40.
    ["!", "#1", TRACK.code, "Code", "waiting on you: allow Bash? (skelcrew r…", "Mine"],
    ["?", "#2", TRACK.code, "Code", "waiting on crew-1", "Theirs"],
    ["*", "#3", TRACK.code, "Code", `running since ${since}`, "Running"],
    ["~", "#4", TRACK.code, "Code", "interrupted", "Interrupted"],
    [" ", "#5", TRACK.code, "Code", "queued", "Queued"],
    [" ", "#6", TRACK.idea, "Idea", "Idle"],
    // The status says archived, so the title carries no `(archived)` suffix after it.
    [" ", "#7", TRACK.idea, "Idea", "archived", "Gone"],
  ]);
  // The whole note is still on the card, and every column before the status is fixed-width,
  // so the status begins at the same character on every row.
  expect(core.getCard(1).attention?.note).toBe(question);
  const heads = lines(await ok(["ls", "--all"])).map((row) => row.slice(0, 20));
  expect(heads).toEqual([
    `!  #1  ${TRACK.code}  Code  `,
    `?  #2  ${TRACK.code}  Code  `,
    `*  #3  ${TRACK.code}  Code  `,
    `~  #4  ${TRACK.code}  Code  `,
    `   #5  ${TRACK.code}  Code  `,
    `   #6  ${TRACK.idea}  Idea  `,
    `   #7  ${TRACK.idea}  Idea  `,
  ]);
});

/**
 * The status column is one screen cell, so it escapes what it carries itself. A tab is the
 * character that makes the difference: a stored note is a multi-line field, so `main.ts`'s
 * sink keeps it, and one tab in a note would otherwise jump the title of that row to the next
 * tab stop while the column's width counted it as a single character.
 */
test("a tab in a note is escaped in the status column, and the titles still line up", async () => {
  const simon = member("simon").id;
  const agent = core.ensureMember("crew-1", "agent");
  for (const title of ["Tabbed", "Queued"]) {
    const card = core.createCard({ title }, simon);
    core.moveCard(card.id, "code", simon);
  }
  core.requestAttention(1, { to: simon, note: "allow\tBash?" }, agent.id);

  const board = lines(await ok(["ls"]));
  expect(board[0]).toContain("waiting on you: allow\\tBash?");
  expect(board[0]).not.toContain("\t");
  expect(core.getCard(1).attention?.note).toBe("allow\tBash?");
  expect(board[0]?.indexOf("Tabbed")).toBe(board[1]?.indexOf("Queued") as number);
});

/**
 * A note that opens with a blank line has nothing on its literal first line, and
 * `waiting on you:` followed by nothing says less than the marker did. The column carries the
 * note's first line with something on it.
 */
test("a note that starts with a newline shows its first line with something on it", async () => {
  const simon = member("simon").id;
  const agent = core.ensureMember("crew-1", "agent");
  const card = core.createCard({ title: "Led with a blank line" }, simon);
  core.moveCard(card.id, "code", simon);
  core.requestAttention(card.id, { to: simon, note: "\nallow Bash?" }, agent.id);

  expect(lines(await ok(["ls"]))[0]).toContain("waiting on you: allow Bash?");
  expect((await ok(["show", String(card.id)])).stdout.split("\n")[1]).toBe(
    "now:     waiting on you: allow Bash?",
  );
  // The whole note, blank first line and all, is still on the card.
  expect(core.getCard(card.id).attention?.note).toBe("\nallow Bash?");
});

/**
 * A board with nothing to say about any card holds no status column at all: the cell is a
 * column, and a column of nothing but padding still pushes every title right.
 */
test("no card with a status means no status column, and the title follows the phase", async () => {
  const simon = member("simon").id;
  for (const title of ["Idea one", "Idea two"]) core.createCard({ title }, simon);

  expect(lines(await ok(["ls"]))).toEqual([
    `   #1  ${TRACK.idea}  Idea  Idea one`,
    `   #2  ${TRACK.idea}  Idea  Idea two`,
  ]);
});

/** Criterion 3: the same status text, as the header's second line. */
test("show leads with now:, and the activity is still oldest first", async () => {
  const simon = member("simon").id;
  const agent = core.ensureMember("crew-1", "agent");
  for (const title of ["Waiting", "Running", "Interrupted", "Queued"]) {
    const card = core.createCard({ title }, simon);
    core.moveCard(card.id, "code", simon);
  }
  core.requestAttention(1, { to: simon, note: "spec ready" }, agent.id);
  core.claimCard(2, {}, agent.id);
  clockOffsetMs = -60_000;
  core.claimCard(3, { ttlSeconds: 10 }, agent.id);
  clockOffsetMs = 0;
  const since = localTime(core.getCard(2).claim?.claimedAt as number).slice(-5);

  const nows: string[] = [];
  for (const id of ["1", "2", "3", "4"]) {
    const shown = await ok(["show", id]);
    nows.push(shown.stdout.split("\n")[1] as string);
  }
  expect(nows).toEqual([
    "now:     waiting on you: spec ready",
    `now:     running since ${since}`,
    "now:     interrupted",
    "now:     queued",
  ]);

  // Unchanged: the header, then the body, then the activity oldest first.
  const shown = await ok(["show", "1"]);
  const header = (shown.stdout.split("\n\n")[0] as string).split("\n");
  expect(header[0]).toContain("#1");
  expect(header[2]).toStartWith("phase:");
  const activity = (shown.stdout.split("\n\n")[1] as string).trim().split("\n");
  expect(activity[0]).toContain('created "Waiting"');
  expect(activity.at(-1)).toContain("asked simon for attention");
});

/** Criterion 6: what the sweep's withdrawal reads as, and what `--json` carries. */
test("show renders the sweep's withdrawal as resolved attention: interrupted", async () => {
  const simon = member("simon").id;
  const agent = core.ensureMember("crew-1", "agent");
  const card = core.createCard({ title: "Slept through it" }, simon);
  core.moveCard(card.id, "code", simon);
  clockOffsetMs = -60_000;
  core.claimCard(card.id, { ttlSeconds: 10 }, agent.id);
  core.requestAttention(card.id, { to: simon, note: "allow Bash?" }, agent.id);
  clockOffsetMs = 0;
  // The daemon names the member whose claims are runs; `crew-1` holds this one, so it plays it.
  expect(core.sweepClaims(agent.id)).toEqual([card.id]);

  const shown = await ok(["show", String(card.id)]);
  const resolved = lines(shown).find((line) => line.includes("resolved attention"));
  expect(resolved).toContain("crew-1");
  expect(resolved).toEndWith("resolved attention: interrupted");
  // The card is free again, and says so at the top.
  expect(shown.stdout.split("\n")[1]).toBe("now:     queued");
  expect(json<CardDetail>(await ok(["show", String(card.id), "--json"]))).toEqual(
    core.getCard(card.id),
  );
  expect(
    json<CardDetail>(await ok(["show", String(card.id), "--json"])).activity.at(-1),
  ).toMatchObject({ type: "attention_resolved", data: { how: "interrupted" } });
});

// --- the runner (006) ---

test("queue shows the runner's request with the worktree path; show prints the branch and the runner's lines", async () => {
  // A real runner against a temp repository, in this process, driving the same core.
  const gitEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["commit", "-q", "--allow-empty", "-m", "init"],
  ]) {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, env: gitEnv, stdout: "ignore" });
    expect(await proc.exited).toBe(0);
  }
  const data = join(dir, "data");
  mkdirSync(data);
  const warnings: string[] = [];
  runners.push(
    startRunner({
      core,
      dataDir: data,
      repoRoot: repo,
      git: createGit({ env: gitEnv }),
      member: core.ensureMember("runner", "agent"),
      crew: core.ensureMember("crew", "agent"),
      warn: (line) => warnings.push(line),
    }),
  );

  await ok(["add", "Add login page"]);
  const requested = new Promise<void>((resolve) => {
    const unsubscribe = core.subscribe((event) => {
      if (event.type !== "attention_requested" || event.cardId !== 1) return;
      unsubscribe();
      resolve();
    });
  });
  await ok(["mv", "1", "spec"]);
  await Promise.race([
    requested,
    Bun.sleep(2000).then(() => {
      throw new Error("no attention request within 2 s");
    }),
  ]);
  const path = join(data, "worktrees", "1");
  expect(existsSync(join(path, ".git"))).toBe(true);

  const queue = await ok(["queue"]);
  expect(queue.stdout).toContain("#1 Add login page  [Spec]");
  expect(queue.stdout).toContain("runner → simon");
  expect(queue.stdout).toContain(`no playbook for spec yet; work in ${path}`);
  expect(queue.stdout).toContain("skelcrew resolve 1");
  expect(await ok([])).toEqual(queue);

  const shown = await ok(["show", "1"]);
  const header = shown.stdout.split("\n\n")[0] as string;
  expect(header).toContain("branch:  skelcrew/1-add-login-page");
  expect(header).toContain("waiting: simon");
  expect(header).toContain("raised by runner");
  const byRunner = lines(shown).filter((l) => l.includes("  runner  "));
  expect(byRunner.map((l) => l.split("  runner  ")[1]?.split(" ")[0])).toEqual([
    "claimed",
    "set",
    "commented:",
    "asked",
    "released",
  ]);
  expect(byRunner[1]).toContain("branch=skelcrew/1-add-login-page");
  expect(byRunner[2]).toContain(
    `worktree ready at ${path} on skelcrew/1-add-login-page (from main)`,
  );
  expect(byRunner[3]).toContain("asked simon for attention: no playbook for spec");
  expect(byRunner[4]).toContain("no playbook");
  expect(json<CardDetail>(await ok(["show", "1", "--json"]))).toEqual(core.getCard(1));
  expect(warnings).toEqual([]);
});

/**
 * 022, criterion 3, rendered. The note is built by the runner and printed by the CLI, and what
 * the owner actually reads is the second of those — so the reason is asserted here as `queue`
 * prints it, under the marker every note line carries, and not only as the string the card
 * holds. The agent is scripted: no coding agent is spawned and no model is called.
 */
test("queue prints the agent's reason for a permission question, between the frame and the input", async () => {
  const gitEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["commit", "-q", "--allow-empty", "-m", "init"],
  ]) {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, env: gitEnv, stdout: "ignore" });
    expect(await proc.exited).toBe(0);
  }
  const data = join(dir, "data");
  mkdirSync(data);
  const driver: AgentDriver = {
    async *run(options) {
      yield { type: "text", text: "Reading the manifests to see how the workspaces are laid out." };
      await options.canUseTool("Bash", { command: "sed -n 1,60p package.json" });
      yield { type: "result", ok: true };
    },
  };
  runners.push(
    startRunner({
      core,
      dataDir: data,
      repoRoot: repo,
      git: createGit({ env: gitEnv }),
      member: core.ensureMember("runner", "agent"),
      crew: core.ensureMember("crew", "agent"),
      warn: () => {},
      agent: { driver, playbooks: loadPlaybooks() },
    }),
  );

  await ok(["add", "Build a TUI"]);
  const requested = new Promise<void>((resolve) => {
    const unsubscribe = core.subscribe((event) => {
      if (event.type !== "attention_requested" || event.cardId !== 1) return;
      unsubscribe();
      resolve();
    });
  });
  await ok(["mv", "1", "spec"]);
  await Promise.race([
    requested,
    Bun.sleep(2000).then(() => {
      throw new Error("no attention request within 2 s");
    }),
  ]);

  const queue = await ok(["queue"]);
  expect(queue.stdout).toContain("#1 Build a TUI  [Spec]");
  expect(queue.stdout).toContain(
    [
      "> allow Bash? (skelcrew resolve 1 -m allow | skelcrew resolve 1 -m deny)",
      "> why: Reading the manifests to see how the workspaces are laid out.",
      "> input:",
      "> > sed -n 1,60p package.json",
    ].join("\n"),
  );

  await ok(["resolve", "1", "-m", "no"]);
});

test("from inside a runner worktree the CLI reaches the repo's daemon with no SKELCREW_DIR: the exit ramp works", async () => {
  const gitEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  // A real repository whose daemon lives at <repo>/.skelcrew/, as it does outside tests.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  extraDirs.push(repo);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["commit", "-q", "--allow-empty", "-m", "init"],
  ]) {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, env: gitEnv, stdout: "ignore" });
    expect(await proc.exited).toBe(0);
  }
  const data = join(repo, ".skelcrew");
  mkdirSync(data);
  const repoCore = openCore(":memory:", { owner: "simon" });
  const repoServer = startServer({
    core: repoCore,
    socketPath: join(data, "skelcrew.sock"),
    reserved: [RUNNER_MEMBER_NAME],
  });
  extraServers.push({
    stop() {
      repoServer.stop();
      repoCore.close();
    },
  });
  runners.push(
    startRunner({
      core: repoCore,
      dataDir: data,
      repoRoot: repo,
      git: createGit({ env: gitEnv }),
      member: repoCore.ensureMember("runner", "agent"),
      crew: repoCore.ensureMember("crew", "agent"),
      warn: () => {},
    }),
  );
  const requested = new Promise<void>((resolve) => {
    const unsubscribe = repoCore.subscribe((event) => {
      if (event.type !== "attention_requested") return;
      unsubscribe();
      resolve();
    });
  });
  repoCore.createCard({ title: "Work by hand" }, 1);
  repoCore.moveCard(1, "spec", 1);
  await Promise.race([
    requested,
    Bun.sleep(2000).then(() => {
      throw new Error("no attention request within 2 s");
    }),
  ]);
  const worktree = join(data, "worktrees", "1");
  expect(existsSync(join(worktree, ".git"))).toBe(true);

  // cd into the worktree the queue names, then use the CLI as the exit ramp promises.
  const listed = await ok(["ls"], { dataDir: null, cwd: worktree });
  expect(listed.stdout).toContain("Work by hand");
  const nested = join(worktree, "src");
  mkdirSync(nested);
  const moved = await ok(["mv", "1", "code"], { dataDir: null, cwd: nested });
  expect(moved.stdout).toContain("#1");
  expect(repoCore.getCard(1).phase).toBe("code");
  expect(existsSync(join(worktree, ".skelcrew"))).toBe(false);
});

// --- control characters (015) ---

/**
 * Criterion 5. A file's line endings are the machine that wrote it talking, not the author,
 * and a shell redirect is a file in practice: CRLF becomes LF on both ways in. A lone `\r` is
 * the repaint character and is refused on every path; an argument is the author's and is
 * normalised nowhere.
 */
test("a file's and stdin's CRLF become LF; a lone carriage return is refused on every path", async () => {
  core.createCard({ title: "b" }, member("simon").id);
  const crlf = join(dir, "crlf.md");
  writeFileSync(crlf, "# Goal\r\n\r\nwritten on another machine\r\n");
  const lone = join(dir, "lone.md");
  writeFileSync(lone, "# Goal\r\n\rRESOLVED: approved\r\n");
  const fromFile = "# Goal\n\nwritten on another machine\n";

  await ok(["body", "1", "--file", crlf]);
  expect(core.getCard(1).body).toBe(fromFile);
  expect(await failed(1, ["body", "1", "--file", lone])).toContain("U+000D");
  expect(core.getCard(1).body).toBe(fromFile);

  // The same through standard input: `skelcrew body <id> < spec.md`.
  await ok(["body", "1"], { stdin: "# Goal\r\n\r\nfrom stdin\r\n" });
  expect(core.getCard(1).body).toBe("# Goal\n\nfrom stdin\n");
  expect(await failed(1, ["body", "1"], { stdin: "# Goal\r\n\rRESOLVED\r\n" })).toContain("U+000D");
  expect(core.getCard(1).body).toBe("# Goal\n\nfrom stdin\n");

  // And for a comment read from standard input, whose final newline is dropped as before.
  await ok(["comment", "1"], { stdin: "a note\r\nwith CRLF\r\n" });
  const said = core.getCard(1).activity.filter((e) => e.type === "comment");
  expect(said.at(-1)?.data.text).toBe("a note\nwith CRLF");
  expect(await failed(1, ["comment", "1"], { stdin: "a\rnote\n" })).toContain("U+000D");

  // An argument is not a file: nothing is normalised, and the CRLF in it is refused.
  expect(await failed(1, ["comment", "1", "a note\r\nwith CRLF"])).toContain("U+000D");
  expect(core.getCard(1).activity.filter((e) => e.type === "comment")).toHaveLength(said.length);
});

/** A daemon of its own on a file database, so a test can write rows the core would refuse. */
function fileDaemon(): { home: string; dbPath: string; daemonCore: Core } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  extraDirs.push(home);
  const dbPath = join(home, "skelcrew.db");
  const daemonCore = openCore(dbPath, { owner: "simon" });
  const fileServer = startServer({
    core: daemonCore,
    socketPath: join(home, "skelcrew.sock"),
    reserved: [RUNNER_MEMBER_NAME],
  });
  extraServers.push({
    stop() {
      fileServer.stop();
      daemonCore.close();
    },
  });
  return { home, dbPath, daemonCore };
}

/**
 * Criterion 6, the second layer: rows written straight into the database, as every row
 * predating this spec was. The core refuses these values now, so SQL is the only way to put
 * them there — and what the CLI prints is what keeps them off the terminal's hands.
 *
 * Each case is the control character itself, what it carries after it, and the escape it must
 * be shown as; every assertion of absence is of the bare character, which is what a terminal
 * would act on.
 */
const SEQUENCES: Array<[string, string, string, string]> = [
  ["an escape sequence", "\x1b", "[2J", "\\x1b"],
  ["a carriage return", "\r", "", "\\r"],
  ["a delete", "\x7f", "", "\\x7f"],
  ["a C1 control", "\x85", "", "\\x85"],
];

for (const [label, control, tail, visible] of SEQUENCES) {
  const raw = `${control}${tail}`;
  const shown = `${visible}${tail}`;
  test(`a row carrying ${label} is printed escaped by show, ls, queue and --json`, async () => {
    const { home, dbPath, daemonCore } = fileDaemon();
    const ownerId = (daemonCore.listMembers()[0] as Member).id;
    daemonCore.createCard({ title: "clean" }, ownerId);

    const db = new Database(dbPath);
    db.query("UPDATE cards SET title = ?, body = ?, refs = ?, attention = ? WHERE id = 1").run(
      `Paint${raw}ed`,
      `bo${raw}dy`,
      JSON.stringify({ branch: `br${raw}anch` }),
      JSON.stringify({
        to: ownerId,
        note: `note${raw}here`,
        moves: [],
        raisedBy: ownerId,
        raisedAt: Date.now(),
      }),
    );
    db.query("UPDATE members SET name = ? WHERE id = ?").run(`simon${raw}`, ownerId);
    const insert = db.query(
      "INSERT INTO activity (card_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(1, ownerId, "comment", JSON.stringify({ text: `cleared${raw}` }), Date.now());
    insert.run(1, ownerId, "released", JSON.stringify({ reason: `stopped${raw}` }), Date.now());
    db.close();

    const detail = await ok(["show", "1"], { dataDir: home });
    for (const fragment of [
      `Paint${shown}ed`,
      `bo${shown}dy`,
      `br${shown}anch`,
      `note${shown}here`,
      `cleared${shown}`,
      `stopped${shown}`,
      `simon${shown}`,
    ]) {
      expect(detail.stdout).toContain(fragment);
    }
    expect(detail.stdout).not.toContain(control);

    const listed = await ok(["ls"], { dataDir: home });
    expect(listed.stdout).toContain(`Paint${shown}ed`);
    expect(listed.stdout).not.toContain(control);

    const waiting = await ok(["queue"], { dataDir: home });
    expect(waiting.stdout).toContain(`note${shown}here`);
    expect(waiting.stdout).not.toContain(control);

    // `--json` is a machine's copy: escaped as JSON, so it parses back to what is stored.
    const asJson = await ok(["show", "1", "--json"], { dataDir: home });
    expect(asJson.stdout).not.toContain(control);
    const card = JSON.parse(asJson.stdout) as CardDetail;
    expect(card.title).toBe(`Paint${raw}ed`);
    expect(card.body).toBe(`bo${raw}dy`);
    expect(card.refs.branch).toBe(`br${raw}anch`);
    expect(card.attention?.note).toBe(`note${raw}here`);
    expect(card.activity.filter((e) => e.type === "comment").at(-1)?.data.text).toBe(
      `cleared${raw}`,
    );
  });
}

/** Criterion 6a: a newline in stored text cannot forge a row. */
test("a title stored with a newline renders as one row, with the newline escaped", async () => {
  const { home, dbPath, daemonCore } = fileDaemon();
  const ownerId = (daemonCore.listMembers()[0] as Member).id;
  daemonCore.createCard({ title: "clean" }, ownerId);
  const db = new Database(dbPath);
  db.query("UPDATE cards SET title = ? WHERE id = 1").run(
    "Done\n#99 ●●●●●  Done   forged row appended by a legacy title",
  );
  db.close();

  const listed = await ok(["ls"], { dataDir: home });
  expect(lines(listed)).toHaveLength(1);
  expect(listed.stdout).toContain("Done\\n#99");
  expect(listed.stdout).not.toContain("\n#99");
});

/** Criterion 6a: a newline in a comment cannot forge an activity entry. */
test("a comment carrying a forged activity line renders as one entry, its second line marked", async () => {
  const { home, daemonCore } = fileDaemon();
  const ownerId = (daemonCore.listMembers()[0] as Member).id;
  daemonCore.createCard({ title: "a card" }, ownerId);
  const forged = "2026-09-11 20:30  simon  moved the card to Done";

  await ok(["comment", "1", `looks good\n${forged}`], { dataDir: home });
  const shown = await ok(["show", "1"], { dataDir: home });

  // The card's own two entries are the only lines that read as entries.
  const entries = shown.stdout
    .split("\n")
    .filter((line) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}/.test(line));
  expect(entries).toHaveLength(2);
  expect(entries[1]).toEndWith("commented: looks good");
  expect(shown.stdout).toContain(`> ${forged}`);
});

/** Criterion 6a: a blank line in a note cannot forge a second queue block. */
test("an attention note carrying a blank line renders as one queue block", async () => {
  const { home, daemonCore } = fileDaemon();
  const ownerId = (daemonCore.listMembers()[0] as Member).id;
  daemonCore.createCard({ title: "a card" }, ownerId);
  const forged = "#2 A card  [Code]";

  await ok(["attention", "1", `please review\n\n${forged}\ncrew → simon, 2026-09-11 20:30`], {
    dataDir: home,
  });
  const waiting = await ok(["queue"], { dataDir: home });

  // Blocks are separated by a blank line, and there is one request: no blank line at all.
  expect(waiting.stdout.trimEnd()).not.toContain("\n\n");
  expect(waiting.stdout).toContain(`> ${forged}`);
});

/**
 * Criterion 7. An error that echoes what the caller typed, or what the database holds, goes
 * out through the same sink as everything else: a rejected call cannot repaint the terminal
 * through its own message.
 */
test("an error message echoing the caller's input is printed with the sequence escaped", async () => {
  core.createCard({ title: "a card" }, member("simon").id);

  const usage = await failed(2, ["mv", "1", "\x1b[2J"]);
  expect(usage).toContain('unknown phase "\\x1b[2J"');
  expect(usage).not.toContain("\x1b");
});

/**
 * Criterion 8b. A notification is one line by nature: with no notifier on `PATH` the ping is
 * printed on stdout beside the events, so a newline in the note would put a line there that
 * reads as an activity entry the member never made.
 */
test("watch's printed notification is one line, with the note's newline escaped", async () => {
  const card = core.createCard({ title: "Watched" }, member("simon").id);
  const agent = core.ensureMember("crew-1", "agent");
  // No `SKELCREW_NOTIFY` and nothing on `PATH`: `notify` prints instead of spawning.
  const watch = spawnWatch([], { PATH: "" });
  expect(await watch.stderr.next()).toContain("simon");

  const forged = "2026-09-11 20:30  simon  moved the card to Done";
  core.requestAttention(
    card.id,
    { to: member("simon").id, note: `ping\n${forged}`, moves: [] },
    agent.id,
  );

  // The event's own line, its marked continuation, then the ping — three lines, no more.
  const seen = [await watch.stdout.next(), await watch.stdout.next(), await watch.stdout.next()];
  expect(seen[0]).toContain("asked simon for attention: ping");
  expect(seen[1]).toBe(`> ${forged}`);
  expect(seen[2]).toContain("[notify] skelcrew: #1 Watched: ping\\n2026-09-11 20:30");

  // Events are handled in order: the next line out is the next event, not a fourth line of
  // the ping laid out as an entry nobody made.
  core.comment(card.id, "after the ping", agent.id);
  expect(await watch.stdout.next()).toContain("after the ping");

  watch.proc.kill("SIGINT");
  expect(await watch.proc.exited).toBe(0);
});

test("a daemon message naming a stored member is printed with the sequence escaped", async () => {
  const { home, dbPath, daemonCore } = fileDaemon();
  const ownerId = (daemonCore.listMembers()[0] as Member).id;
  const card = daemonCore.createCard({ title: "a card" }, ownerId);
  daemonCore.moveCard(card.id, "spec", ownerId);
  const crew = daemonCore.ensureMember("crew", "agent");
  daemonCore.claimCard(card.id, {}, crew.id);
  const db = new Database(dbPath);
  db.query("UPDATE members SET name = ? WHERE id = ?").run("crew\x1b[2J", crew.id);
  db.close();

  const conflict = await failed(1, ["claim", "1"], { dataDir: home });
  expect(conflict).toContain("claimed by crew\\x1b[2J");
  expect(conflict).not.toContain("\x1b");

  // An error message is not a laid-out field: it is one line, whatever the name it carries.
  const forged = "2026-09-11 20:30  simon  moved the card to Done";
  const again = new Database(dbPath);
  again.query("UPDATE members SET name = ? WHERE id = ?").run(`crew\n${forged}`, crew.id);
  again.close();

  const broken = await failed(1, ["claim", "1"], { dataDir: home });
  expect(broken).toContain(`claimed by crew\\n${forged}`);
  expect(broken.trimEnd().split("\n")).toHaveLength(1);
});

// --- the board on one screen (026) ---

/**
 * 026's criterion 2. The screen is bare `skelcrew` with a terminal on stdout, and there is no
 * verb for it: these runs are piped, which is what a script and an agent get, and that answer
 * is the one they always got.
 */
test("there is no board subcommand, and bare skelcrew without a terminal is still the queue", async () => {
  core.createCard({ title: "First card" }, member("simon").id);

  const unknown = await failed(2, ["board"]);
  expect(unknown).toContain('unknown command "board"');

  const listing = await ok(["help"]);
  expect(listing.stdout).not.toContain("skelcrew board");

  const bare = await ok([]);
  expect(bare.stdout.toLowerCase()).toContain("nothing is waiting on you");
  expect(bare).toEqual(await ok(["queue"]));
});
