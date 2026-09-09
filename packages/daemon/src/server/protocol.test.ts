import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, Attention, Card, Claim, Member } from "@skelcrew/shared";
import {
  BODY_MAX_BYTES,
  type Client,
  connect,
  ERROR_CODES,
  METHOD_NAMES,
  type MethodName,
  PROTOCOL_VERSION,
  RpcError,
  VERSION,
} from "@skelcrew/shared";
import { type Core, openCore } from "../core/core";
import { startServer } from "./server";

let dir: string;
let socketPath: string;
let core: Core;
let server: { stop(): void };
let owner: Member;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skc-"));
  socketPath = join(dir, "s.sock");
  core = openCore(":memory:", { owner: "simon" });
  owner = core.listMembers()[0] as Member;
  server = startServer({ core, socketPath });
});

afterEach(() => {
  server.stop();
  core.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A raw newline-delimited connection: what `nc -U` would see. */
async function rawConnect(path: string) {
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  const closeWaiters: Array<() => void> = [];
  let drainWaiter: (() => void) | undefined;
  let closed = false;
  let buffered = "";
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, chunk) {
        buffered += chunk.toString();
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const waiter = waiters.shift();
          if (waiter) waiter(line);
          else lines.push(line);
          newline = buffered.indexOf("\n");
        }
      },
      drain() {
        drainWaiter?.();
        drainWaiter = undefined;
      },
      close() {
        closed = true;
        for (const waiter of closeWaiters) waiter();
        drainWaiter?.();
      },
      error() {},
    },
  });
  return {
    async send(line: string): Promise<void> {
      const bytes = Buffer.from(`${line}\n`);
      let offset = 0;
      while (offset < bytes.length && !closed) {
        const written = socket.write(bytes, offset, bytes.length - offset);
        if (written < 0) return;
        offset += written;
        if (offset < bytes.length) {
          await new Promise<void>((resolve) => {
            drainWaiter = resolve;
          });
        }
      }
    },
    next(): Promise<string> {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      return new Promise((resolve) => waiters.push(resolve));
    },
    closed(): Promise<void> {
      if (closed) return Promise.resolve();
      return new Promise((resolve) => closeWaiters.push(resolve));
    },
    end() {
      socket.end();
    },
  };
}

async function asOwner(): Promise<Client> {
  return connect(socketPath, { kind: "human" });
}

async function asAgent(name = "crew-1"): Promise<Client> {
  return connect(socketPath, { kind: "agent", name });
}

async function expectRpcError(
  promise: Promise<unknown>,
  code: number,
  dataCode: RpcError["data"]["code"],
  ...fragments: string[]
): Promise<RpcError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RpcError);
  const error = caught as RpcError;
  expect(error.code).toBe(code);
  expect(error.data.code).toBe(dataCode);
  for (const fragment of fragments) {
    expect(error.message).toContain(fragment);
  }
  return error;
}

describe("method parity with the core", () => {
  test("every core method has a same-named wire method, or a named stand-in", () => {
    // `hello` is how a member joins (the core's `ensureMember`); `listMembers` covers
    // `getMember`; `close` is the process's, not a member's; `sweepClaims` is the daemon's
    // timer, not a member action, so it has no wire method.
    const standIns: Record<string, MethodName | null> = {
      ensureMember: "hello",
      getMember: "listMembers",
      close: null,
      sweepClaims: null,
    };
    const wireMethods: readonly string[] = METHOD_NAMES;
    const coreMethods = Object.keys(core);
    expect(coreMethods.length).toBeGreaterThan(10);
    for (const name of coreMethods) {
      const wire = Object.hasOwn(standIns, name) ? (standIns[name] as MethodName | null) : name;
      if (wire === null) continue;
      expect(wireMethods).toContain(wire);
    }
  });

  test("the 002 list is on the wire, plus listMembers, hello, and unsubscribe, and nothing else", () => {
    const from002 = [
      "createCard",
      "listCards",
      "getCard",
      "moveCard",
      "setBody",
      "comment",
      "setRefs",
      "archiveCard",
      "activitySince",
      "subscribe",
    ];
    const wireMethods: readonly string[] = METHOD_NAMES;
    for (const name of from002) expect(wireMethods).toContain(name);
    expect(wireMethods).toContain("listMembers");
    expect(wireMethods).toContain("hello");
    expect(wireMethods).toContain("unsubscribe");
    const coreMethods = new Set(Object.keys(core));
    for (const name of METHOD_NAMES) {
      if (name === "hello" || name === "unsubscribe") continue;
      expect(coreMethods.has(name)).toBe(true);
    }
  });

  test("the error table is the spec's", () => {
    expect(ERROR_CODES).toEqual({
      parse: -32700,
      invalid_request: -32600,
      method_not_found: -32601,
      invalid_params: -32602,
      no_session: -32000,
      not_found: -32001,
      invalid: -32002,
      forbidden: -32003,
      conflict: -32009,
      internal: -32603,
    });
  });
});

describe("framing and session over a raw socket", () => {
  test("a request before hello fails with no_session", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send('{"jsonrpc":"2.0","id":1,"method":"listCards","params":{}}');
    const reply = JSON.parse(await raw.next());
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: expect.any(String), data: { code: "no_session" } },
    });
    raw.end();
  });

  test("a line that is not JSON gets a parse error and the connection is closed", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send("this is not json");
    const reply = JSON.parse(await raw.next());
    expect(reply.id).toBeNull();
    expect(reply.error.code).toBe(-32700);
    expect(reply.error.data.code).toBe("parse");
    await raw.closed();
  });

  test("a batch (JSON array) gets invalid_request and the connection is closed", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send('[{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"human"}}]');
    const reply = JSON.parse(await raw.next());
    expect(reply.error.code).toBe(-32600);
    expect(reply.error.data.code).toBe("invalid_request");
    await raw.closed();
  });

  test("a JSON value that is not a JSON-RPC 2.0 request gets invalid_request and closes", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send('{"id":1,"method":"hello","params":{"kind":"human"}}');
    const reply = JSON.parse(await raw.next());
    expect(reply.error.code).toBe(-32600);
    expect(reply.error.data.code).toBe("invalid_request");
    await raw.closed();
  });

  test("a line over the documented limit is refused and the connection is closed", async () => {
    const raw = await rawConnect(socketPath);
    const { MAX_LINE_BYTES } = await import("@skelcrew/shared");
    const padding = "x".repeat(MAX_LINE_BYTES);
    await raw.send(`{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"${padding}"}}`);
    const reply = JSON.parse(await raw.next());
    expect([-32700, -32600]).toContain(reply.error.code);
    expect(["parse", "invalid_request"]).toContain(reply.error.data.code);
    await raw.closed();
  });

  test("a failing connection does not affect another", async () => {
    const good = await asOwner();
    const bad = await rawConnect(socketPath);
    await bad.send("garbage");
    await bad.next();
    await bad.closed();
    const card = await good.call("createCard", { title: "still here" });
    expect(card.title).toBe("still here");
    const another = await asAgent();
    expect((await another.call("listCards", {})).map((c) => c.id)).toEqual([card.id]);
    await good.close();
    await another.close();
  });

  test("hello as the owner returns the owner member, the version, and protocol 1", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send('{"jsonrpc":"2.0","id":"h","method":"hello","params":{"kind":"human"}}');
    const reply = JSON.parse(await raw.next());
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: "h",
      result: { member: owner, version: VERSION, protocol: PROTOCOL_VERSION },
    });
    expect(reply.result.protocol).toBe(1);
    raw.end();
  });

  test("hello as an agent on two connections is one member and one member_joined", async () => {
    const first = await rawConnect(socketPath);
    const second = await rawConnect(socketPath);
    const hello =
      '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"agent","name":"crew-1"}}';
    await first.send(hello);
    await second.send(hello);
    const a = JSON.parse(await first.next());
    const b = JSON.parse(await second.next());
    expect(a.result.member.kind).toBe("agent");
    expect(a.result.member.name).toBe("crew-1");
    expect(b.result.member.id).toBe(a.result.member.id);
    const joined = core.activitySince(0).filter((e) => e.type === "member_joined");
    expect(joined).toHaveLength(1);
    first.end();
    second.end();
  });

  test("a second hello on a connection is invalid", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send('{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"human"}}');
    await raw.next();
    await raw.send('{"jsonrpc":"2.0","id":2,"method":"hello","params":{"kind":"human"}}');
    const reply = JSON.parse(await raw.next());
    expect(reply.id).toBe(2);
    expect(reply.error.code).toBe(-32002);
    expect(reply.error.data.code).toBe("invalid");
    // The connection stays bound and usable.
    await raw.send('{"jsonrpc":"2.0","id":3,"method":"listCards","params":{}}');
    expect(JSON.parse(await raw.next())).toEqual({ jsonrpc: "2.0", id: 3, result: [] });
    raw.end();
  });

  test("a bad hello leaves the connection unbound", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send('{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"robot"}}');
    let reply = JSON.parse(await raw.next());
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.data.code).toBe("invalid_params");
    await raw.send('{"jsonrpc":"2.0","id":2,"method":"listCards","params":{}}');
    reply = JSON.parse(await raw.next());
    expect(reply.error.data.code).toBe("no_session");
    raw.end();
  });

  test("hello as the human takes no name: the owner needs none", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send(
      '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"human","name":"other"}}',
    );
    const reply = JSON.parse(await raw.next());
    expect(reply.error.code).toBe(-32602);
    raw.end();
  });

  test("a client notification (no id) is not a request the daemon accepts", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send('{"jsonrpc":"2.0","method":"hello","params":{"kind":"human"}}');
    const reply = JSON.parse(await raw.next());
    expect(reply.id).toBeNull();
    expect(reply.error.code).toBe(-32600);
    await raw.closed();
  });

  test("requests on one connection are answered in the order they arrived", async () => {
    const raw = await rawConnect(socketPath);
    await raw.send(
      [
        '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"kind":"human"}}',
        '{"jsonrpc":"2.0","id":2,"method":"createCard","params":{"title":"a"}}',
        '{"jsonrpc":"2.0","id":3,"method":"createCard","params":{"title":"b"}}',
        '{"jsonrpc":"2.0","id":4,"method":"listCards","params":{}}',
      ].join("\n"),
    );
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(JSON.parse(await raw.next()).id);
    expect(ids).toEqual([1, 2, 3, 4]);
    raw.end();
  });
});

describe("methods through the shared client", () => {
  test("the owner files a card, lists it, and reads it with its card_created event", async () => {
    const client = await asOwner();
    const card = await client.call("createCard", { title: "x" });
    expect(card).toMatchObject({ title: "x", phase: "idea", body: "", refs: {} });
    expect(Number.isInteger(card.id)).toBe(true);
    const listed = await client.call("listCards", {});
    expect(listed.map((c) => c.id)).toContain(card.id);
    const detail = await client.call("getCard", { id: card.id });
    expect(detail).toMatchObject(card);
    expect(detail.activity).toHaveLength(1);
    expect(detail.activity[0]).toMatchObject({ type: "card_created", actorId: owner.id });
    await client.close();
  });

  test("an agent's comment is attributed to the agent", async () => {
    const ownerClient = await asOwner();
    const agentClient = await asAgent("crew-1");
    const card = await ownerClient.call("createCard", { title: "x" });
    const event = await agentClient.call("comment", { id: card.id, text: "hi" });
    const agent = core.listMembers().find((m) => m.name === "crew-1") as Member;
    expect(event).toMatchObject({ type: "comment", actorId: agent.id, data: { text: "hi" } });
    const detail = await ownerClient.call("getCard", { id: card.id });
    const comments: Activity[] = detail.activity.filter((e) => e.type === "comment");
    expect(comments).toEqual([event]);
    await ownerClient.close();
    await agentClient.close();
  });

  test("an agent's gated move is forbidden and logged; the owner's succeeds", async () => {
    const ownerClient = await asOwner();
    const agentClient = await asAgent("crew-1");
    const card = await ownerClient.call("createCard", { title: "x" });
    await expectRpcError(
      agentClient.call("moveCard", { id: card.id, phase: "spec" }),
      -32003,
      "forbidden",
      "idea",
      "crew-1",
    );
    const detail = await agentClient.call("getCard", { id: card.id });
    expect(detail.phase).toBe("idea");
    expect(detail.activity.filter((e) => e.type === "move_rejected")).toHaveLength(1);
    const moved = await ownerClient.call("moveCard", { id: card.id, phase: "spec" });
    expect(moved.phase).toBe("spec");
    await ownerClient.close();
    await agentClient.close();
  });

  test("not_found, invalid, and invalid_params map to their codes", async () => {
    const client = await asOwner();
    await expectRpcError(client.call("getCard", { id: 999 }), -32001, "not_found", "999");
    const card = await client.call("createCard", { title: "x" });
    await expectRpcError(
      client.call("setBody", { id: card.id, body: "x".repeat(BODY_MAX_BYTES + 1) }),
      -32002,
      "invalid",
    );
    const before = core.activitySince(0).length;
    await expectRpcError(
      client.call("moveCard", { id: card.id, phase: 7 as unknown as "spec" }),
      -32602,
      "invalid_params",
    );
    expect(core.activitySince(0)).toHaveLength(before);
    expect(core.getCard(card.id).activity.some((e) => e.type === "move_rejected")).toBe(false);
    await client.close();
  });

  test("wrong-shaped params never reach the core", async () => {
    const client = await asOwner();
    const before = core.activitySince(0).length;
    const cases: Array<[MethodName, unknown]> = [
      ["createCard", {}],
      ["createCard", { title: 1 }],
      ["createCard", { title: "x", actorId: 1 }],
      ["createCard", ["x"]],
      ["getCard", { id: "1" }],
      ["getCard", { id: 1.5 }],
      ["moveCard", { id: 1, phase: "nowhere" }],
      ["setBody", { id: 1 }],
      ["comment", { id: 1, text: null }],
      ["setRefs", { id: 1, refs: "feat/x" }],
      ["archiveCard", {}],
      ["activitySince", { seq: "0" }],
      ["listCards", { includeArchived: "yes" }],
      ["subscribe", { since: -1.5 }],
      ["requestAttention", { id: 1, note: "x" }],
      ["requestAttention", { id: 1, to: 1 }],
      ["requestAttention", { id: 1, to: "simon", note: "x" }],
      ["requestAttention", { id: 1, to: 1, note: "x", moves: "code" }],
      ["requestAttention", { id: 1, to: 1, note: "x", moves: ["review"] }],
      ["requestAttention", { id: 1, to: 1, note: "x", actorId: 2 }],
      ["resolveAttention", { id: "1" }],
      ["resolveAttention", { id: 1, text: 7 }],
      ["listAttention", { to: "me" }],
      ["listAttention", { who: 1 }],
      ["claimCard", {}],
      ["claimCard", { id: "1" }],
      ["claimCard", { id: 1, ttlSeconds: "60" }],
      ["claimCard", { id: 1, ttlSeconds: 1.5 }],
      ["claimCard", { id: 1, actorId: 2 }],
      ["heartbeat", {}],
      ["heartbeat", { id: 1, ttlSeconds: 60 }],
      ["releaseCard", { id: 1, reason: 7 }],
      ["releaseCard", { reason: "x" }],
    ];
    for (const [method, params] of cases) {
      await expectRpcError(client.call(method, params as never), -32602, "invalid_params", method);
    }
    expect(core.activitySince(0)).toHaveLength(before);
    await client.close();
  });

  test("an unknown method is method_not_found", async () => {
    const client = await asOwner();
    await expectRpcError(
      client.call("frobnicate" as MethodName, {} as never),
      -32601,
      "method_not_found",
      "frobnicate",
    );
    await client.close();
  });

  test("hello through the client after the session is bound is invalid", async () => {
    const client = await asOwner();
    await expectRpcError(client.call("hello", { kind: "human" }), -32002, "invalid");
    await client.close();
  });

  test("every method round-trips as the owner", async () => {
    const client = await asOwner();
    const card = await client.call("createCard", { title: "round trip", body: "b" });
    expect(card.body).toBe("b");
    expect(await client.call("listCards", {})).toEqual([card]);
    expect((await client.call("getCard", { id: card.id })).id).toBe(card.id);
    const moved = await client.call("moveCard", { id: card.id, phase: "code" });
    expect(moved.phase).toBe("code");
    const bodied = await client.call("setBody", { id: card.id, body: "# spec" });
    expect(bodied.body).toBe("# spec");
    const commented = await client.call("comment", { id: card.id, text: "note" });
    expect(commented.type).toBe("comment");
    const refd = await client.call("setRefs", { id: card.id, refs: { branch: "feat/x" } });
    expect(refd.refs).toEqual({ branch: "feat/x" });
    const archived = await client.call("archiveCard", { id: card.id });
    expect(archived.archivedAt).not.toBeNull();
    expect(await client.call("listCards", {})).toEqual([]);
    expect(await client.call("listCards", { includeArchived: true })).toEqual([archived]);
    const since = await client.call("activitySince", { seq: 0 });
    expect(since.map((e) => e.type)).toEqual([
      "card_created",
      "card_moved",
      "body_set",
      "comment",
      "refs_set",
      "card_archived",
    ]);
    expect(await client.call("activitySince", { seq: since.at(-1)?.seq ?? -1 })).toEqual([]);
    const members = await client.call("listMembers", {});
    expect(members).toEqual([owner]);
    expect(await client.call("subscribe", {})).toBeNull();
    expect(await client.call("unsubscribe", {})).toBeNull();
    await client.close();
  });

  test("every method round-trips as an agent, with the gates in place", async () => {
    const client = await asAgent("crew-2");
    const agent = core.listMembers().find((m) => m.name === "crew-2") as Member;
    const card = await client.call("createCard", { title: "by agent" });
    expect(core.getCard(card.id).activity[0]?.actorId).toBe(agent.id);
    expect(await client.call("listCards", {})).toEqual([card]);
    expect((await client.call("getCard", { id: card.id })).activity).toHaveLength(1);
    await expectRpcError(
      client.call("moveCard", { id: card.id, phase: "spec" }),
      -32003,
      "forbidden",
    );
    core.moveCard(card.id, "code", owner.id);
    const moved = await client.call("moveCard", { id: card.id, phase: "pr" });
    expect(moved.phase).toBe("pr");
    const bodied = await client.call("setBody", { id: card.id, body: "# spec" });
    expect(bodied.body).toBe("# spec");
    const commented = await client.call("comment", { id: card.id, text: "note" });
    expect(commented.actorId).toBe(agent.id);
    const refd = await client.call("setRefs", { id: card.id, refs: { commits: ["abcdef0"] } });
    expect(refd.refs).toEqual({ commits: ["abcdef0"] });
    const archived = await client.call("archiveCard", { id: card.id });
    expect(archived.archivedAt).not.toBeNull();
    const since = await client.call("activitySince", { seq: 0 });
    // The agent's own join is attributed to the agent, then everything it did.
    expect(since.filter((e) => e.actorId === agent.id).map((e) => e.type)).toEqual([
      "member_joined",
      "card_created",
      "move_rejected",
      "card_moved",
      "body_set",
      "comment",
      "refs_set",
      "card_archived",
    ]);
    const members = await client.call("listMembers", {});
    expect(members.map((m) => m.name)).toEqual(["simon", "crew-2"]);
    expect(await client.call("subscribe", {})).toBeNull();
    expect(await client.call("unsubscribe", {})).toBeNull();
    await client.close();
  });

  test("results are the core's values as JSON", async () => {
    const client = await asOwner();
    const card: Card = await client.call("createCard", { title: "x" });
    expect(card).toEqual(core.listCards()[0] as Card);
    const detail = await client.call("getCard", { id: card.id });
    const activity: Activity[] = core.getCard(card.id).activity;
    expect(detail.activity).toEqual(activity);
    await client.close();
  });
});

describe("attention on the wire", () => {
  test("the three methods are on the wire and every core method still has a wire method", () => {
    const wireMethods: readonly string[] = METHOD_NAMES;
    for (const name of ["requestAttention", "resolveAttention", "listAttention"]) {
      expect(wireMethods).toContain(name);
      expect(Object.keys(core)).toContain(name);
    }
  });

  test("requestAttention, listAttention, and resolveAttention round-trip as the owner", async () => {
    const client = await asOwner();
    const card = await client.call("createCard", { title: "x" });
    expect(card.attention).toBeNull();

    const raised = await client.call("requestAttention", {
      id: card.id,
      to: owner.id,
      note: "remind me",
      moves: ["spec", "code"],
    });
    expect(raised.attention).toEqual({
      to: owner.id,
      note: "remind me",
      moves: ["spec", "code"],
      raisedBy: owner.id,
      raisedAt: expect.any(Number),
    });
    expect(raised).toEqual(core.listCards()[0] as Card);

    const open = await client.call("listAttention", {});
    expect(open).toEqual([{ cardId: card.id, ...(raised.attention as Attention) }]);
    expect(open).toEqual(core.listAttention());
    expect(await client.call("listAttention", { to: owner.id })).toEqual(open);
    expect(await client.call("listAttention", { to: owner.id + 1 })).toEqual([]);

    const resolved = await client.call("resolveAttention", { id: card.id, text: "done" });
    expect(resolved.attention).toBeNull();
    expect(await client.call("listAttention", {})).toEqual([]);
    const types = core.getCard(card.id).activity.map((e) => e.type);
    expect(types).toEqual(["card_created", "attention_requested", "comment", "attention_resolved"]);
    await client.close();
  });

  test("an agent raises to the owner, may not answer it, and sees the owner's answer", async () => {
    const ownerClient = await asOwner();
    const agentClient = await asAgent("crew-1");
    const agent = core.listMembers().find((m) => m.name === "crew-1") as Member;
    const card = await ownerClient.call("createCard", { title: "x" });

    const raised = await agentClient.call("requestAttention", {
      id: card.id,
      to: owner.id,
      note: "spec ready",
      moves: ["code"],
    });
    expect(raised.attention).toMatchObject({ to: owner.id, raisedBy: agent.id, moves: ["code"] });
    expect(
      (await agentClient.call("listAttention", { to: owner.id })).map((r) => r.cardId),
    ).toEqual([card.id]);

    await expectRpcError(
      agentClient.call("resolveAttention", { id: card.id }),
      -32003,
      "forbidden",
      "crew-1",
    );
    expect(core.getCard(card.id).attention).toEqual(raised.attention);

    const answered = await ownerClient.call("resolveAttention", { id: card.id });
    expect(answered.attention).toBeNull();
    await expectRpcError(
      agentClient.call("resolveAttention", { id: card.id, text: "again" }),
      -32002,
      "invalid",
    );

    // Addressed to the agent, the agent may answer.
    await ownerClient.call("requestAttention", { id: card.id, to: agent.id, note: "please" });
    expect(
      (await agentClient.call("resolveAttention", { id: card.id, text: "ok" })).attention,
    ).toBeNull();
    expect(core.getCard(card.id).activity.at(-2)).toMatchObject({
      type: "comment",
      actorId: agent.id,
      data: { text: "ok" },
    });
    await ownerClient.close();
    await agentClient.close();
  });

  test("not_found and invalid map for the attention methods and change nothing", async () => {
    const client = await asAgent("crew-1");
    const card = await client.call("createCard", { title: "x" });
    const before = core.activitySince(0).length;
    await expectRpcError(
      client.call("requestAttention", { id: card.id, to: 999, note: "x" }),
      -32001,
      "not_found",
      "999",
    );
    await expectRpcError(
      client.call("requestAttention", { id: card.id, to: owner.id, note: "  " }),
      -32002,
      "invalid",
    );
    await expectRpcError(
      client.call("requestAttention", { id: 999, to: owner.id, note: "x" }),
      -32001,
      "not_found",
      "999",
    );
    expect(core.activitySince(0)).toHaveLength(before);
    expect(core.getCard(card.id).attention).toBeNull();
    await client.close();
  });

  test("a subscribed client receives attention_requested and attention_resolved in seq order", async () => {
    const watcher = await asOwner();
    const agentClient = await asAgent("crew-1");
    const received: Activity[] = [];
    await watcher.subscribe((event) => received.push(event));
    const card = await watcher.call("createCard", { title: "x" });

    await agentClient.call("requestAttention", {
      id: card.id,
      to: owner.id,
      note: "spec ready",
      moves: ["code"],
    });
    await watcher.call("moveCard", { id: card.id, phase: "code" });
    await agentClient.call("requestAttention", { id: card.id, to: owner.id, note: "pr ready" });
    await watcher.call("resolveAttention", { id: card.id, text: "merging" });

    const types = received.map((e) => e.type);
    expect(types).toEqual([
      "card_created",
      "attention_requested",
      "card_moved",
      "attention_resolved",
      "attention_requested",
      "comment",
      "attention_resolved",
    ]);
    const seqs = received.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] as number) + i));
    const agent = core.listMembers().find((m) => m.name === "crew-1") as Member;
    expect(received[1]?.data).toEqual({
      to: owner.id,
      note: "spec ready",
      moves: ["code"],
      raisedBy: agent.id,
      raisedAt: expect.any(Number),
    });
    expect(received[3]?.data).toEqual({ how: "moved", phase: "code" });
    expect(received[6]?.data).toEqual({ how: "answered" });
    await agentClient.close();
    await watcher.close();
  });
});

describe("claims on the wire", () => {
  test("the three methods are on the wire and sweepClaims is not", () => {
    const wireMethods: readonly string[] = METHOD_NAMES;
    for (const name of ["claimCard", "heartbeat", "releaseCard"]) {
      expect(wireMethods).toContain(name);
      expect(Object.keys(core)).toContain(name);
    }
    expect(wireMethods).not.toContain("sweepClaims");
    expect(Object.keys(core)).toContain("sweepClaims");
  });

  test("claimCard, heartbeat, and releaseCard round-trip as the owner", async () => {
    const client = await asOwner();
    const card = await client.call("createCard", { title: "x" });
    expect(card.claim).toBeNull();
    await client.call("moveCard", { id: card.id, phase: "spec" });
    const before = Date.now();

    const claimed = await client.call("claimCard", { id: card.id });
    expect(claimed.claim).toEqual({
      by: owner.id,
      claimedAt: expect.any(Number),
      expiresAt: expect.any(Number),
      ttlSeconds: 120,
    });
    const claim = claimed.claim as Claim;
    expect(claim.claimedAt).toBeGreaterThanOrEqual(before);
    expect(claim.expiresAt).toBe(claim.claimedAt + 120_000);
    expect(claimed).toEqual(core.listCards()[0] as Card);

    const beat = await client.call("heartbeat", { id: card.id });
    expect(beat.claim).toMatchObject({ by: owner.id, claimedAt: claim.claimedAt, ttlSeconds: 120 });
    expect(beat.claim?.expiresAt).toBeGreaterThanOrEqual(claim.expiresAt);

    const shorter = await client.call("claimCard", { id: card.id, ttlSeconds: 5 });
    expect(shorter.claim).toMatchObject({ claimedAt: claim.claimedAt, ttlSeconds: 10 });

    const released = await client.call("releaseCard", { id: card.id, reason: "done" });
    expect(released.claim).toBeNull();
    expect(await client.call("releaseCard", { id: card.id })).toEqual(released);
    const types = core.getCard(card.id).activity.map((e) => e.type);
    expect(types).toEqual(["card_created", "card_moved", "claimed", "released"]);
    expect(core.getCard(card.id).activity.at(-1)?.data).toEqual({ reason: "done" });
    await client.close();
  });

  test("an agent claims, another agent gets conflict, the owner releases; forbidden and invalid map", async () => {
    const ownerClient = await asOwner();
    const first = await asAgent("crew-1");
    const second = await asAgent("crew-2");
    const crew1 = core.listMembers().find((m) => m.name === "crew-1") as Member;
    const card = await ownerClient.call("createCard", { title: "x" });

    await expectRpcError(first.call("claimCard", { id: card.id }), -32002, "invalid", "idea");
    await ownerClient.call("moveCard", { id: card.id, phase: "code" });

    const claimed = await first.call("claimCard", { id: card.id, ttlSeconds: 60 });
    expect(claimed.claim).toMatchObject({ by: crew1.id, ttlSeconds: 60 });
    await expectRpcError(second.call("claimCard", { id: card.id }), -32009, "conflict", "crew-1");
    await expectRpcError(second.call("heartbeat", { id: card.id }), -32009, "conflict", "crew-1");
    await expectRpcError(
      second.call("releaseCard", { id: card.id, reason: "mine" }),
      -32003,
      "forbidden",
      "crew-2",
    );
    await expectRpcError(
      second.call("moveCard", { id: card.id, phase: "pr" }),
      -32009,
      "conflict",
      "crew-1",
    );
    expect(core.getCard(card.id).claim).toEqual(claimed.claim);

    expect((await first.call("heartbeat", { id: card.id })).claim?.by).toBe(crew1.id);
    await expectRpcError(
      first.call("releaseCard", { id: card.id, reason: "  " }),
      -32002,
      "invalid",
    );
    const released = await ownerClient.call("releaseCard", { id: card.id });
    expect(released.claim).toBeNull();
    await expectRpcError(first.call("heartbeat", { id: card.id }), -32009, "conflict");
    await expectRpcError(first.call("claimCard", { id: 999 }), -32001, "not_found", "999");

    // Now free: the second agent takes it and moves it, which releases it.
    expect((await second.call("claimCard", { id: card.id })).claim?.by).not.toBe(crew1.id);
    const moved = await second.call("moveCard", { id: card.id, phase: "pr" });
    expect(moved.claim).toBeNull();
    expect(core.getCard(card.id).activity.map((e) => e.type)).toEqual([
      "card_created",
      "card_moved",
      "claimed",
      "released",
      "claimed",
      "card_moved",
      "released",
    ]);
    await ownerClient.close();
    await first.close();
    await second.close();
  });

  test("a subscribed client receives claimed, released, and run_interrupted in seq order", async () => {
    const T0 = 1_700_000_000_000;
    let clock = T0;
    // A server over a core on a movable clock, so the lapse is exercised without waiting.
    const timed = openCore(":memory:", { owner: "simon", now: () => clock });
    const timedPath = join(dir, "t.sock");
    const timedServer = startServer({ core: timed, socketPath: timedPath });
    try {
      const watcher = await connect(timedPath, { kind: "human" });
      const agentClient = await connect(timedPath, { kind: "agent", name: "crew-1" });
      const agent = timed.listMembers().find((m) => m.name === "crew-1") as Member;
      const received: Activity[] = [];
      await watcher.subscribe((event) => received.push(event));
      const card = await watcher.call("createCard", { title: "x" });
      await watcher.call("moveCard", { id: card.id, phase: "spec" });

      await agentClient.call("claimCard", { id: card.id, ttlSeconds: 10 });
      await agentClient.call("heartbeat", { id: card.id });
      await agentClient.call("releaseCard", { id: card.id, reason: "pausing" });
      await agentClient.call("claimCard", { id: card.id, ttlSeconds: 10 });
      clock += 10_000;
      expect(timed.sweepClaims()).toEqual([card.id]);
      // The sweep's event went out to the subscriber like any other; give the socket a turn.
      await watcher.call("listCards", {});

      const types = received.map((e) => e.type);
      expect(types).toEqual([
        "card_created",
        "card_moved",
        "claimed",
        "released",
        "claimed",
        "run_interrupted",
      ]);
      const seqs = received.map((e) => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] as number) + i));
      expect(received[2]).toMatchObject({
        actorId: agent.id,
        data: { ttlSeconds: 10, expiresAt: T0 + 10_000 },
      });
      expect(received[3]).toMatchObject({ actorId: agent.id, data: { reason: "pausing" } });
      expect(received[5]).toMatchObject({
        actorId: agent.id,
        data: { by: agent.id, expiresAt: T0 + 10_000 },
      });
      expect((await watcher.call("getCard", { id: card.id })).claim).toBeNull();
      await agentClient.close();
      await watcher.close();
    } finally {
      timedServer.stop();
      timed.close();
    }
  });
});
