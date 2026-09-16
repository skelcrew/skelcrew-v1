/**
 * The socket. One listener, one session per connection, one fan-out of the core's activity
 * to every subscribed connection. Requests on a connection are handled one at a time in the
 * order they arrive; the core is synchronous, so a response is written before the next
 * line is looked at, and a mutation's notifications go out before its response.
 */
import { chmodSync, rmSync } from "node:fs";
import {
  type Activity,
  type ActivityNotification,
  encodeLine,
  LineDecoder,
  LineTooLongError,
  MAX_LINE_BYTES,
} from "@skelcrew/shared";
import { type Core, memberName } from "../core/core";
import {
  handleRequest,
  ProtocolError,
  parseRequest,
  type Session,
  toJsonRpcError,
} from "./protocol";

interface Connection {
  session: Session;
  decoder: LineDecoder;
  subscribed: boolean;
  /** Bytes the kernel would not take yet; written on `drain`. */
  queue: Uint8Array[];
  /** Set after a fatal error: the error line goes out, then the socket ends. */
  endAfterFlush: boolean;
}

type ConnectionSocket = Bun.Socket<Connection>;

export interface Server {
  stop(): void;
}

export function startServer(options: {
  core: Core;
  socketPath: string;
  /** Agent member names `hello` refuses: the daemon's own members (028). */
  reserved?: readonly string[];
}): Server {
  const { core, socketPath } = options;
  // Normalised once, the way the core stores a member name, so the comparison in `hello` is
  // against what `ensureMember` would have found.
  const reserved = new Set((options.reserved ?? []).map(memberName));
  const connections = new Set<ConnectionSocket>();
  const encoder = new TextEncoder();

  function flush(socket: ConnectionSocket): void {
    const conn = socket.data;
    while (conn.queue.length > 0) {
      const head = conn.queue[0] as Uint8Array;
      const written = socket.write(head);
      if (written < 0) return;
      if (written < head.length) {
        conn.queue[0] = head.subarray(written);
        return;
      }
      conn.queue.shift();
    }
    if (conn.endAfterFlush) socket.end();
  }

  function send(socket: ConnectionSocket, message: unknown): void {
    socket.data.queue.push(encoder.encode(encodeLine(message)));
    flush(socket);
  }

  /** A framing failure: answer with a null id and close, as the wire promises. */
  function fail(socket: ConnectionSocket, error: unknown): void {
    socket.data.endAfterFlush = true;
    send(socket, { jsonrpc: "2.0", id: null, error: toJsonRpcError(error) });
  }

  function notification(event: Activity): ActivityNotification {
    return { jsonrpc: "2.0", method: "activity", params: { event } };
  }

  function hooksFor(socket: ConnectionSocket) {
    return {
      subscribe(since: number | undefined) {
        const conn = socket.data;
        if (conn.subscribed) return;
        if (since !== undefined) {
          for (const event of core.activitySince(since)) send(socket, notification(event));
        }
        conn.subscribed = true;
      },
      unsubscribe() {
        socket.data.subscribed = false;
      },
    };
  }

  // The core delivers synchronously, in `seq` order; a subscribed connection's queue keeps
  // that order. Nothing here may throw: a throwing listener would fail the mutation.
  const unsubscribeCore = core.subscribe((event) => {
    const message = notification(event);
    for (const socket of connections) {
      if (!socket.data.subscribed || socket.data.endAfterFlush) continue;
      try {
        send(socket, message);
      } catch {
        // A dead socket is released by its own close handler.
      }
    }
  });

  const listener = Bun.listen<Connection>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = {
          session: { member: null },
          decoder: new LineDecoder(MAX_LINE_BYTES),
          subscribed: false,
          queue: [],
          endAfterFlush: false,
        };
        connections.add(socket);
      },
      data(socket, chunk) {
        const conn = socket.data;
        if (conn.endAfterFlush) return;
        let lines: string[];
        try {
          lines = conn.decoder.push(chunk);
        } catch (error) {
          const reason =
            error instanceof LineTooLongError ? new ProtocolError("parse", error.message) : error;
          fail(socket, reason);
          return;
        }
        for (const line of lines) {
          let request: ReturnType<typeof parseRequest>;
          try {
            request = parseRequest(line);
          } catch (error) {
            fail(socket, error);
            return;
          }
          const ctx = { core, session: conn.session, reserved, stream: hooksFor(socket) };
          send(socket, handleRequest(ctx, request));
        }
      },
      drain(socket) {
        flush(socket);
      },
      close(socket) {
        connections.delete(socket);
      },
      error() {
        // The close handler releases the connection.
      },
    },
  });
  chmodSync(socketPath, 0o600);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeCore();
      listener.stop(true);
      connections.clear();
      rmSync(socketPath, { force: true });
    },
  };
}
