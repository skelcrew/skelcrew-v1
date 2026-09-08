import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, RpcError } from "./client";
import type { Activity, Member } from "./types";

/**
 * A scripted server: the client's contract is the wire, so the tests speak it directly
 * rather than importing the daemon. `onLine` sees each request line and may reply.
 */
type Scripted = (
  line: string,
  reply: (message: unknown) => void,
  socket: Bun.Socket<{ buffered: string }>,
) => void;

let dir: string;
let socketPath: string;
let listener: Bun.UnixSocketListener<{ buffered: string }> | undefined;
let closedByPeer = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skc-"));
  socketPath = join(dir, "s.sock");
  closedByPeer = 0;
});

afterEach(() => {
  listener?.stop(true);
  listener = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function serve(script: Scripted): void {
  listener = Bun.listen<{ buffered: string }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { buffered: "" };
      },
      data(socket, chunk) {
        socket.data.buffered += chunk.toString();
        let newline = socket.data.buffered.indexOf("\n");
        while (newline >= 0) {
          const line = socket.data.buffered.slice(0, newline);
          socket.data.buffered = socket.data.buffered.slice(newline + 1);
          script(line, (message) => socket.write(`${JSON.stringify(message)}\n`), socket);
          newline = socket.data.buffered.indexOf("\n");
        }
      },
      close() {
        closedByPeer += 1;
      },
    },
  });
}

const member: Member = { id: 1, name: "simon", kind: "human", createdAt: 0 };

function answerHello(): Scripted {
  return (line, reply) => {
    const request = JSON.parse(line);
    if (request.method === "hello") {
      reply({
        jsonrpc: "2.0",
        id: request.id,
        result: { member, version: "0.0.1", protocol: 1 },
      });
    }
  };
}

async function settle(): Promise<void> {
  await Bun.sleep(10);
}

test("connect sends hello first and resolves with the client once it succeeds", async () => {
  const seen: string[] = [];
  serve((line, reply) => {
    seen.push(line);
    answerHello()(line, reply, undefined as never);
  });
  const client = await connect(socketPath, { kind: "agent", name: "crew-1" });
  expect(seen).toHaveLength(1);
  expect(JSON.parse(seen[0] as string)).toEqual({
    jsonrpc: "2.0",
    id: expect.anything(),
    method: "hello",
    params: { kind: "agent", name: "crew-1" },
  });
  expect(typeof client.call).toBe("function");
  expect(typeof client.subscribe).toBe("function");
  expect(typeof client.unsubscribe).toBe("function");
  expect(typeof client.close).toBe("function");
  await client.close();
});

test("connect rejects with the daemon's error when hello fails, and closes the connection", async () => {
  serve((line, reply) => {
    reply({
      jsonrpc: "2.0",
      id: JSON.parse(line).id,
      error: { code: -32002, message: "no such kind", data: { code: "invalid" } },
    });
  });
  let caught: unknown;
  try {
    await connect(socketPath, { kind: "human" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RpcError);
  const error = caught as RpcError;
  expect(error.code).toBe(-32002);
  expect(error.data.code).toBe("invalid");
  expect(error.message).toBe("no such kind");
  await settle();
  expect(closedByPeer).toBe(1);
});

test("connect rejects when nothing listens on the path", async () => {
  await expect(connect(join(dir, "nothing.sock"), { kind: "human" })).rejects.toThrow();
});

test("call resolves with the result and rejects with the JSON-RPC code and data.code", async () => {
  serve((line, reply) => {
    const request = JSON.parse(line);
    if (request.method === "hello") return answerHello()(line, reply, undefined as never);
    if (request.method === "listCards")
      return reply({ jsonrpc: "2.0", id: request.id, result: [] });
    reply({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32001, message: "card 999 not found", data: { code: "not_found" } },
    });
  });
  const client = await connect(socketPath, { kind: "human" });
  expect(await client.call("listCards", {})).toEqual([]);
  let caught: unknown;
  try {
    await client.call("getCard", { id: 999 });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(-32001);
  expect((caught as RpcError).data.code).toBe("not_found");
  expect((caught as RpcError).message).toContain("999");
  await client.close();
});

test("responses are matched by id, whatever order they arrive in", async () => {
  const pending: Array<{ id: unknown; title: string }> = [];
  serve((line, reply) => {
    const request = JSON.parse(line);
    if (request.method === "hello") return answerHello()(line, reply, undefined as never);
    pending.push({ id: request.id, title: request.params.title });
    if (pending.length === 2) {
      for (const p of pending.reverse()) {
        reply({ jsonrpc: "2.0", id: p.id, result: { id: 0, title: p.title } });
      }
    }
  });
  const client = await connect(socketPath, { kind: "human" });
  const [a, b] = await Promise.all([
    client.call("createCard", { title: "a" }),
    client.call("createCard", { title: "b" }),
  ]);
  expect(a.title).toBe("a");
  expect(b.title).toBe("b");
  await client.close();
});

test("a pending call rejects when the client closes", async () => {
  serve(answerHello());
  const client = await connect(socketPath, { kind: "human" });
  const pending = client.call("listCards", {});
  await client.close();
  await expect(pending).rejects.toThrow(/closed/);
});

test("a pending call rejects when the server closes the connection", async () => {
  serve((line, reply, socket) => {
    const request = JSON.parse(line);
    if (request.method === "hello") return answerHello()(line, reply, socket);
    socket.end();
  });
  const client = await connect(socketPath, { kind: "human" });
  await expect(client.call("listCards", {})).rejects.toThrow(/closed/);
});

test("closed resolves when the server goes away, and after close()", async () => {
  serve(answerHello());
  const client = await connect(socketPath, { kind: "human" });
  let settled = false;
  client.closed.then(() => {
    settled = true;
  });
  await settle();
  expect(settled).toBe(false);

  listener?.stop(true);
  listener = undefined;
  await client.closed;
  expect(settled).toBe(true);

  serve(answerHello());
  const second = await connect(socketPath, { kind: "human" });
  await second.close();
  await second.closed;
});

test("subscribe and unsubscribe send their requests, and activity notifications reach the handler", async () => {
  const event: Activity = {
    seq: 1,
    cardId: 1,
    actorId: 1,
    type: "card_created",
    data: { title: "x" },
    createdAt: 0,
  };
  const methods: Array<{ method: string; params: unknown }> = [];
  serve((line, reply) => {
    const request = JSON.parse(line);
    methods.push({ method: request.method, params: request.params });
    if (request.method === "hello") return answerHello()(line, reply, undefined as never);
    if (request.method === "subscribe") {
      reply({ jsonrpc: "2.0", method: "activity", params: { event } });
      reply({ jsonrpc: "2.0", id: request.id, result: null });
      reply({ jsonrpc: "2.0", method: "activity", params: { event: { ...event, seq: 2 } } });
      return;
    }
    reply({ jsonrpc: "2.0", id: request.id, result: null });
  });
  const client = await connect(socketPath, { kind: "human" });
  const received: Activity[] = [];
  await client.subscribe((e) => received.push(e), 0);
  await settle();
  expect(received.map((e) => e.seq)).toEqual([1, 2]);
  await client.unsubscribe();
  expect(methods.map((m) => m.method)).toEqual(["hello", "subscribe", "unsubscribe"]);
  expect(methods[1]?.params).toEqual({ since: 0 });
  await client.close();
});
