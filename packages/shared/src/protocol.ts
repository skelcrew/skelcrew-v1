/**
 * The wire. One connection is one stream of newline-delimited UTF-8 JSON-RPC 2.0 messages
 * in both directions: one message per line, no batches, no client-to-daemon notifications.
 * The first request must be `hello`, which binds the connection to a member; every later
 * method acts as that member, so no message carries an actor id. The method names mirror
 * the core one to one, minus `actorId`.
 */
import type { Phase } from "./phases";
import type {
  Activity,
  Card,
  CardDetail,
  CardRefs,
  Member,
  OpenAttention,
  ReviewVerdict,
} from "./types";

export const PROTOCOL_VERSION = 1;

/**
 * Largest line either side accepts, in bytes, newline excluded. A defence against a runaway
 * peer, not a design limit: the largest legitimate message is a `getCard` result carrying a
 * full activity log, and the core caps a body at 64 KiB and a comment at 16 KiB. A longer
 * line is answered with a parse error and the connection is closed.
 */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Who is speaking. The owner needs no name: there is exactly one human member. */
export type HelloParams = { kind: "human" } | { kind: "agent"; name: string };

export interface HelloResult {
  member: Member;
  version: string;
  protocol: typeof PROTOCOL_VERSION;
}

/** Every method, with its named params and its result. Params never carry `actorId`. */
export interface Methods {
  hello: { params: HelloParams; result: HelloResult };
  createCard: { params: { title: string; body?: string }; result: Card };
  listCards: { params: { includeArchived?: boolean }; result: Card[] };
  getCard: { params: { id: number }; result: CardDetail };
  moveCard: { params: { id: number; phase: Phase }; result: Card };
  setBody: { params: { id: number; body: string }; result: Card };
  comment: { params: { id: number; text: string }; result: Activity };
  /**
   * Records a verdict on the card; `text` is the findings, required with `changes_requested`.
   * The core calls this one `review`: the wire spells a method naming a card `…Card`, as
   * `moveCard`, `claimCard` and `archiveCard` do.
   */
  reviewCard: { params: { id: number; verdict: ReviewVerdict; text?: string }; result: Activity };
  setRefs: { params: { id: number; refs: CardRefs }; result: Card };
  archiveCard: { params: { id: number }; result: Card };
  activitySince: { params: { seq: number }; result: Activity[] };
  listMembers: { params: Record<string, never>; result: Member[] };
  /** Hands the card to member `to`. `moves` are phase ids suggested as resolutions. */
  requestAttention: {
    params: { id: number; to: number; note: string; moves?: Phase[] };
    result: Card;
  };
  /** Answers the open request; `text`, if given, is posted as a comment first. */
  resolveAttention: { params: { id: number; text?: string }; result: Card };
  /** Open requests, oldest first, optionally only those addressed to `to`. */
  listAttention: { params: { to?: number }; result: OpenAttention[] };
  /**
   * Takes the card, or renews the member's own claim. `ttlSeconds` defaults to 120 and is
   * clamped to 10 through 3600. `conflict` when someone else holds a live claim; `invalid`
   * when the phase is not claimable or the card is archived.
   */
  claimCard: { params: { id: number; ttlSeconds?: number }; result: Card };
  /** Extends the member's live claim by its TTL. `conflict` when there is none to extend. */
  heartbeat: { params: { id: number }; result: Card };
  /** Clears the claim. The holder or the owner may; `forbidden` for anyone else. */
  releaseCard: { params: { id: number; reason?: string }; result: Card };
  /**
   * Turns on the `activity` stream for the connection. With `since`, events with
   * `seq > since` are delivered first, then live ones, with no gap or duplicate across the
   * join. Subscribing twice is a no-op.
   */
  subscribe: { params: { since?: number }; result: null };
  unsubscribe: { params: Record<string, never>; result: null };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]["params"];
export type Result<M extends MethodName> = Methods[M]["result"];

export const METHOD_NAMES: readonly MethodName[] = [
  "hello",
  "createCard",
  "listCards",
  "getCard",
  "moveCard",
  "setBody",
  "comment",
  "reviewCard",
  "setRefs",
  "archiveCard",
  "activitySince",
  "listMembers",
  "requestAttention",
  "resolveAttention",
  "listAttention",
  "claimCard",
  "heartbeat",
  "releaseCard",
  "subscribe",
  "unsubscribe",
];

/** JSON-RPC `error.code` by `error.data.code`. The core's four codes keep their names. */
export const ERROR_CODES = {
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
} as const;

export type ProtocolErrorCode = keyof typeof ERROR_CODES;

export type RequestId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data: { code: ProtocolErrorCode };
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: RequestId | null; result: unknown }
  | { jsonrpc: "2.0"; id: RequestId | null; error: JsonRpcError };

/** Sent by the daemon to every subscribed connection, once per event, in `seq` order. */
export interface ActivityNotification {
  jsonrpc: "2.0";
  method: "activity";
  params: { event: Activity };
}

export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export class LineTooLongError extends Error {
  constructor(maxBytes: number) {
    super(`line exceeds ${maxBytes} bytes`);
    this.name = "LineTooLongError";
  }
}

/** Splits a byte stream into lines. Feed it chunks; it hands back the lines they complete. */
export class LineDecoder {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private readonly decoder = new TextDecoder();

  constructor(private readonly maxBytes = Number.POSITIVE_INFINITY) {}

  /** Throws `LineTooLongError` as soon as a line exceeds the limit; the decoder is then done. */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let newline = chunk.indexOf(10, start); newline >= 0; newline = chunk.indexOf(10, start)) {
      this.add(chunk.subarray(start, newline));
      lines.push(this.take());
      start = newline + 1;
    }
    if (start < chunk.length) this.add(chunk.subarray(start));
    return lines;
  }

  private add(piece: Uint8Array): void {
    this.size += piece.length;
    if (this.size > this.maxBytes) throw new LineTooLongError(this.maxBytes);
    this.chunks.push(piece);
  }

  private take(): string {
    let bytes: Uint8Array;
    if (this.chunks.length === 1) {
      bytes = this.chunks[0] as Uint8Array;
    } else {
      bytes = new Uint8Array(this.size);
      let offset = 0;
      for (const piece of this.chunks) {
        bytes.set(piece, offset);
        offset += piece.length;
      }
    }
    this.chunks = [];
    this.size = 0;
    return this.decoder.decode(bytes);
  }
}
