/**
 * The client every thin client and every protocol test uses. It speaks the wire in
 * `protocol.ts` over a unix socket and nothing more: no reconnection, no retries, no
 * timeouts. Identity is the `hello` given to `connect`, established anew per connection.
 */
import {
  encodeLine,
  type HelloParams,
  type HelloResult,
  type JsonRpcError,
  LineDecoder,
  type MethodName,
  type Params,
  type ProtocolErrorCode,
  type Result,
} from "./protocol";
import type { Activity, Member } from "./types";

/** A `call` that the daemon answered with an error. `code` and `data.code` are the wire's. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: { code: ProtocolErrorCode };

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = "RpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export interface Client {
  /** The member this connection is bound to, from the `hello` result. */
  readonly member: Member;
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  /** Routes `activity` notifications to `handler` and turns the stream on. */
  subscribe(handler: (event: Activity) => void, since?: number): Promise<void>;
  unsubscribe(): Promise<void>;
  /** Rejects every pending `call`; resolves once the socket has closed. */
  close(): Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const CLOSED = () => new Error("connection closed");

export async function connect(socketPath: string, hello: HelloParams): Promise<Client> {
  const pending = new Map<number, Pending>();
  const decoder = new LineDecoder();
  const encoder = new TextEncoder();
  const queue: Uint8Array[] = [];
  const closeWaiters: Array<() => void> = [];
  let nextId = 1;
  let closed = false;
  let endAfterFlush = false;
  let handler: ((event: Activity) => void) | undefined;

  function flush(): void {
    while (queue.length > 0) {
      const head = queue[0] as Uint8Array;
      const written = socket.write(head);
      if (written < 0) return;
      if (written < head.length) {
        queue[0] = head.subarray(written);
        return;
      }
      queue.shift();
    }
    if (endAfterFlush) socket.end();
  }

  function send(message: unknown): void {
    queue.push(encoder.encode(encodeLine(message)));
    flush();
  }

  function onClose(): void {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) p.reject(CLOSED());
    pending.clear();
    for (const waiter of closeWaiters.splice(0)) waiter();
  }

  function onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if (message.method === "activity") {
      const params = message.params as { event: Activity } | undefined;
      if (params && handler) handler(params.event);
      return;
    }
    if (typeof message.id !== "number") return;
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    if ("error" in message) p.reject(new RpcError(message.error as JsonRpcError));
    else p.resolve(message.result);
  }

  function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    if (closed) return Promise.reject(CLOSED());
    const id = nextId;
    nextId += 1;
    return new Promise<Result<M>>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as Result<M>), reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    const done = new Promise<void>((resolve) => closeWaiters.push(resolve));
    for (const p of pending.values()) p.reject(CLOSED());
    pending.clear();
    endAfterFlush = true;
    flush();
    return done;
  }

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        for (const line of decoder.push(chunk)) onLine(line);
      },
      drain() {
        flush();
      },
      close() {
        onClose();
      },
      error() {},
      connectError() {},
    },
  });

  let greeting: HelloResult;
  try {
    greeting = await call("hello", hello);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    member: greeting.member,
    call,
    async subscribe(next, since) {
      handler = next;
      await call("subscribe", since === undefined ? {} : { since });
    },
    async unsubscribe() {
      await call("unsubscribe", {});
      handler = undefined;
    },
    close,
  };
}
