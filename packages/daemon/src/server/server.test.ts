import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, Member } from "@skelcrew/shared";
import { type Client, connect } from "@skelcrew/shared";
import { type Core, openCore } from "../core/core";
import { startServer } from "./server";

let dir: string;
let socketPath: string;
let core: Core;
let server: { stop(): void };
let owner: Member;
const open: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skc-"));
  socketPath = join(dir, "s.sock");
  core = openCore(":memory:", { owner: "simon" });
  owner = core.listMembers()[0] as Member;
  server = startServer({ core, socketPath });
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  server.stop();
  core.close();
  rmSync(dir, { recursive: true, force: true });
});

async function client(hello: { kind: "human" } | { kind: "agent"; name: string }) {
  const c = await connect(socketPath, hello);
  open.push(c);
  return c;
}

/** Records every activity notification a client receives and lets a test wait for a count. */
function recorder() {
  const events: Activity[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    events,
    handler(event: Activity) {
      events.push(event);
      for (const waiter of waiters.splice(0)) {
        if (events.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    until(count: number): Promise<void> {
      if (events.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

function seqs(events: Activity[]): number[] {
  return events.map((e) => e.seq);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

async function fiveMutations(c: Client): Promise<void> {
  const card = await c.call("createCard", { title: "streamed" });
  await c.call("moveCard", { id: card.id, phase: "spec" });
  await c.call("setBody", { id: card.id, body: "# spec" });
  await c.call("comment", { id: card.id, text: "hi" });
  await c.call("setRefs", { id: card.id, refs: { branch: "feat/s" } });
}

test("two subscribers each receive five mutations in seq order; unsubscribe stops one", async () => {
  const a = await client({ kind: "human" });
  const b = await client({ kind: "agent", name: "watcher" });
  const c = await client({ kind: "agent", name: "worker" });
  const ra = recorder();
  const rb = recorder();
  await a.subscribe(ra.handler);
  await b.subscribe(rb.handler);
  const before = core.activitySince(0).length;

  const card = await c.call("createCard", { title: "streamed" });
  core.moveCard(card.id, "code", owner.id);
  await c.call("moveCard", { id: card.id, phase: "pr" });
  await c.call("setBody", { id: card.id, body: "# spec" });
  await c.call("comment", { id: card.id, text: "hi" });
  await c.call("setRefs", { id: card.id, refs: { branch: "feat/s" } });

  await ra.until(6);
  await rb.until(6);
  const expected = core.activitySince(before);
  expect(expected).toHaveLength(6);
  expect(ra.events).toEqual(expected);
  expect(rb.events).toEqual(expected);
  expect(seqs(ra.events)).toEqual(range(before + 1, before + 6));

  await a.unsubscribe();
  await c.call("comment", { id: card.id, text: "after" });
  await c.call("archiveCard", { id: card.id });
  await rb.until(8);
  // Anything the daemon had sent to `a` before this reply would have arrived before it.
  await a.call("listCards", {});
  expect(ra.events).toHaveLength(6);
  expect(seqs(rb.events)).toEqual(range(before + 1, before + 8));
});

test("a connection's own mutations appear in its stream", async () => {
  const a = await client({ kind: "human" });
  const r = recorder();
  await a.subscribe(r.handler);
  await fiveMutations(a);
  await r.until(5);
  expect(r.events.map((e) => e.type)).toEqual([
    "card_created",
    "card_moved",
    "body_set",
    "comment",
    "refs_set",
  ]);
  expect(r.events.every((e) => e.actorId === owner.id)).toBe(true);
});

test("subscribing twice is a no-op: one notification per event", async () => {
  const a = await client({ kind: "human" });
  const r = recorder();
  await a.subscribe(r.handler);
  await a.call("subscribe", { since: 0 });
  await a.call("createCard", { title: "once" });
  await r.until(1);
  await a.call("listCards", {});
  expect(r.events).toHaveLength(1);
});

test("subscribe with since replays n+1..m and joins live events with no gap or duplicate", async () => {
  const writer = await client({ kind: "human" });
  const first = await writer.call("createCard", { title: "early" });
  await writer.call("comment", { id: first.id, text: "one" });
  await writer.call("comment", { id: first.id, text: "two" });
  const n = 1;
  expect(core.activitySince(0).length).toBeGreaterThan(n);

  const watcher = await client({ kind: "agent", name: "watcher" });
  const r = recorder();
  // The subscribe and a burst of mutations are in flight at the same time.
  const burst = fiveMutations(writer);
  const subscribed = watcher.subscribe(r.handler, n);
  await Promise.all([burst, subscribed]);
  await writer.call("comment", { id: first.id, text: "three" });
  await writer.call("comment", { id: first.id, text: "four" });

  const all = core.activitySince(n);
  await r.until(all.length);
  await watcher.call("listCards", {});
  expect(seqs(r.events)).toEqual(range(n + 1, all.at(-1)?.seq ?? n));
  expect(r.events).toEqual(all);
});

test("subscribe with since and nothing live replays only the backlog", async () => {
  const a = await client({ kind: "human" });
  await fiveMutations(a);
  const r = recorder();
  await a.subscribe(r.handler, 2);
  await a.call("listCards", {});
  expect(r.events).toEqual(core.activitySince(2));
  expect(seqs(r.events)).toEqual(range(3, 5));
});

test("closing a subscribed client removes it from fan-out and the others keep going", async () => {
  const a = await client({ kind: "human" });
  const b = await client({ kind: "agent", name: "watcher" });
  const c = await client({ kind: "agent", name: "worker" });
  const ra = recorder();
  const rb = recorder();
  await a.subscribe(ra.handler);
  await b.subscribe(rb.handler);
  await a.close();
  open.splice(open.indexOf(a), 1);

  const card = await c.call("createCard", { title: "after close" });
  await c.call("comment", { id: card.id, text: "still streaming" });
  await rb.until(2);
  expect(rb.events.map((e) => e.type)).toEqual(["card_created", "comment"]);
  expect(ra.events).toHaveLength(0);
  expect((await c.call("listCards", {})).map((x) => x.id)).toEqual([card.id]);
});

test("a subscriber that drops the socket without unsubscribing is released the same way", async () => {
  const b = await client({ kind: "agent", name: "watcher" });
  const c = await client({ kind: "agent", name: "worker" });
  const rb = recorder();
  await b.subscribe(rb.handler);
  const dropped = await Bun.connect({
    unix: socketPath,
    socket: { data() {} },
  });
  dropped.write('{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"human"}}\n');
  dropped.write('{"jsonrpc":"2.0","id":2,"method":"subscribe","params":{}}\n');
  dropped.terminate();

  await c.call("createCard", { title: "x" });
  await c.call("createCard", { title: "y" });
  await rb.until(2);
  expect(rb.events.map((e) => e.type)).toEqual(["card_created", "card_created"]);
});

test("closing the client mid-request rejects the pending call", async () => {
  const a = await client({ kind: "human" });
  open.splice(open.indexOf(a), 1);
  const pending = a.call("listCards", {});
  await a.close();
  await expect(pending).rejects.toThrow(/closed/);
});

test("stopping the server closes open connections", async () => {
  const a = await client({ kind: "human" });
  open.splice(open.indexOf(a), 1);
  server.stop();
  await expect(a.call("listCards", {})).rejects.toThrow(/closed/);
  await expect(connect(socketPath, { kind: "human" })).rejects.toThrow();
});
