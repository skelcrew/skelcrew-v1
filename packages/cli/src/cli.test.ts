import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Activity,
  BODY_MAX_BYTES,
  type Card,
  type CardDetail,
  type Member,
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

beforeEach(() => {
  // Real path: macOS's temp dir is a symlink, and the CLI names the path it resolved.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skc-")));
  socketPath = join(dir, "skelcrew.sock");
  core = openCore(":memory:", { owner: "simon" });
  server = startServer({ core, socketPath });
});

afterEach(() => {
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
  await failed(2, []);
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
