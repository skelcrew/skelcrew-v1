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
  type Member,
  type OpenAttention,
  PHASES,
  TITLE_MAX_BYTES,
  VERSION,
} from "@skelcrew/shared";
import { type Core, openCore } from "../../daemon/src/core/core";
import { startServer } from "../../daemon/src/server/server";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

let dir: string;
let socketPath: string;
let core: Core;
let server: { stop(): void };
const extraServers: Array<{ stop(): void }> = [];
const extraDirs: string[] = [];
const watchers: Array<{ kill(): void }> = [];

beforeEach(() => {
  // Real path: macOS's temp dir is a symlink, and the CLI names the path it resolved.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  socketPath = join(dir, "skelcrew.sock");
  core = openCore(":memory:", { owner: "simon" });
  server = startServer({ core, socketPath });
});

afterEach(() => {
  for (const w of watchers.splice(0)) w.kill();
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
  for (const verb of ["add", "ls", "show", "comment", "mv", "body", "refs", "archive"]) {
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

test("show prints the card, the body verbatim, and the activity with actor names", async () => {
  const body = "# Goal\n\nSome text.\n\n## Acceptance criteria\n\n1. it works\n";
  const card = core.createCard({ title: "Shown", body }, member("simon").id);

  const run = await ok(["show", "1"]);
  expect(run.stdout).toContain("Shown");
  expect(run.stdout).toContain("Idea");
  expect(run.stdout).toContain(localTime(card.createdAt));
  expect(run.stdout).toContain(body);
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

test("an agent's move through a crew gate succeeds; through an owner gate it is refused and posts nothing", async () => {
  core.createCard({ title: "g" }, member("simon").id);
  core.moveCard(1, "spec", member("simon").id);
  core.moveCard(1, "code", member("simon").id);

  await ok(["mv", "1", "pr", "-m", "note", "--as", "crew-1"]);
  const crew = member("crew-1");
  expect(crew.kind).toBe("agent");
  const tail = core.getCard(1).activity.slice(-2);
  expect(tail.map((e) => e.type)).toEqual(["card_moved", "comment"]);
  expect(tail.map((e) => e.actorId)).toEqual([crew.id, crew.id]);

  const stderr = await failed(1, ["mv", "1", "code", "-m", "send back", "--as", "crew-1"]);
  expect(stderr).toContain("forbidden");
  const detail = core.getCard(1);
  expect(detail.phase).toBe("pr");
  expect(detail.activity.some((e) => e.type === "comment" && e.data.text === "send back")).toBe(
    false,
  );
  expect(detail.activity.at(-1)?.type).toBe("move_rejected");
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
  expect((await ok(["show", "1"])).stdout).toContain(fromStdin);

  const fromFile = "# Goal\n\nfrom a file\n\n## Out of scope\n\n- nothing\n";
  const path = join(dir, "spec.md");
  writeFileSync(path, fromFile);
  await ok(["body", "1", "--file", path]);
  expect(core.getCard(1).body).toBe(fromFile);
  expect((await ok(["show", "1"])).stdout).toContain(fromFile);

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
  expect(asOwner[1]?.startsWith("?")).toBe(true);
  expect(asOwner[1]).toContain("#2");
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

test("watch --json is a usage error", async () => {
  await failed(2, ["watch", "--json"]);
});
