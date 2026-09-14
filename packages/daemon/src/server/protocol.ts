/**
 * One request at a time: parse a line into a JSON-RPC request, check the session, validate
 * the params against the method table, call the core as the connection's member, and map
 * whatever comes back onto the wire. Nothing here knows about sockets.
 */
import {
  ERROR_CODES,
  type HelloParams,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Member,
  type MethodName,
  type Methods,
  PHASES,
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  VERSION,
} from "@skelcrew/shared";
import type { Core } from "../core/core";
import { CoreError } from "../core/errors";

/** A protocol-level failure. `code` is the wire's `error.data.code`. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** What a connection remembers: who said `hello`. Nothing here outlives the connection. */
export interface Session {
  member: Member | null;
}

/** The stream is the server's; the dispatcher only asks for it to be turned on or off. */
export interface StreamHooks {
  subscribe(since: number | undefined): void;
  unsubscribe(): void;
}

export function toJsonRpcError(error: unknown): JsonRpcError {
  if (error instanceof ProtocolError || error instanceof CoreError) {
    return { code: ERROR_CODES[error.code], message: error.message, data: { code: error.code } };
  }
  const message = error instanceof Error ? error.message : "internal error";
  return { code: ERROR_CODES.internal, message, data: { code: "internal" } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one line. A failure here is fatal for the connection. */
export function parseRequest(line: string): JsonRpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError("parse", "line is not valid JSON");
  }
  if (Array.isArray(value)) {
    throw new ProtocolError("invalid_request", "batch requests are not supported");
  }
  if (!isObject(value)) throw new ProtocolError("invalid_request", "a request is a JSON object");
  const { jsonrpc, id, method, params } = value;
  if (jsonrpc !== "2.0") throw new ProtocolError("invalid_request", 'jsonrpc must be "2.0"');
  if (typeof id !== "number" && typeof id !== "string") {
    throw new ProtocolError(
      "invalid_request",
      "id must be a number or a string; notifications are not accepted",
    );
  }
  if (typeof method !== "string") {
    throw new ProtocolError("invalid_request", "method must be a string");
  }
  return { jsonrpc: "2.0", id, method, params };
}

interface Check {
  test(value: unknown): boolean;
  expected: string;
}

const string: Check = { test: (v) => typeof v === "string", expected: "a string" };
const boolean: Check = { test: (v) => typeof v === "boolean", expected: "a boolean" };
const integer: Check = {
  test: (v) => typeof v === "number" && Number.isInteger(v),
  expected: "an integer",
};
const object: Check = { test: isObject, expected: "an object" };
const phase: Check = {
  test: (v) => PHASES.some((p) => p.id === v),
  expected: `one of ${PHASES.map((p) => `"${p.id}"`).join(", ")}`,
};
const verdict: Check = {
  test: (v) => v === "approved" || v === "changes_requested",
  expected: '"approved" or "changes_requested"',
};
const phaseList: Check = {
  test: (v) => Array.isArray(v) && v.every((item) => phase.test(item)),
  expected: `an array of ${phase.expected}`,
};

type Shape = Record<string, { check: Check; optional?: boolean }>;

/** Exactly the documented keys, each of the documented type. Extra keys are wrong-shaped too. */
function validate(method: string, params: unknown, shape: Shape): Record<string, unknown> {
  const value = params === undefined ? {} : params;
  if (!isObject(value)) {
    throw new ProtocolError("invalid_params", `${method}: params must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) {
      throw new ProtocolError("invalid_params", `${method}: unknown param "${key}"`);
    }
  }
  for (const [key, field] of Object.entries(shape)) {
    const given = value[key];
    if (given === undefined) {
      if (field.optional) continue;
      throw new ProtocolError("invalid_params", `${method}: missing param "${key}"`);
    }
    if (!field.check.test(given)) {
      throw new ProtocolError(
        "invalid_params",
        `${method}: param "${key}" must be ${field.check.expected}`,
      );
    }
  }
  return value;
}

function validateHello(params: unknown): HelloParams {
  const value = params === undefined ? {} : params;
  if (!isObject(value))
    throw new ProtocolError("invalid_params", "hello: params must be an object");
  if (value.kind === "human") {
    validate("hello", value, { kind: { check: string } });
    return { kind: "human" };
  }
  if (value.kind === "agent") {
    const { name } = validate("hello", value, { kind: { check: string }, name: { check: string } });
    return { kind: "agent", name: name as string };
  }
  throw new ProtocolError("invalid_params", 'hello: param "kind" must be "human" or "agent"');
}

interface Context {
  core: Core;
  session: Session;
  stream: StreamHooks;
}

/** The one method that needs no member: it binds one. */
function hello(ctx: Context, params: unknown): Methods["hello"]["result"] {
  if (ctx.session.member) {
    throw new ProtocolError(
      "invalid",
      `hello was already said on this connection, as ${ctx.session.member.name}`,
    );
  }
  const who = validateHello(params);
  const member = who.kind === "human" ? owner(ctx.core) : ctx.core.ensureMember(who.name, "agent");
  ctx.session.member = member;
  return { member, version: VERSION, protocol: PROTOCOL_VERSION };
}

type BoundMethod = Exclude<MethodName, "hello">;

type Handler<M extends BoundMethod> = (
  ctx: Context,
  params: unknown,
  member: Member,
) => Methods[M]["result"];

/** Every method after `hello`, each acting as the connection's member. */
const HANDLERS: { [M in BoundMethod]: Handler<M> } = {
  createCard(ctx, params, member) {
    const p = validate("createCard", params, {
      title: { check: string },
      body: { check: string, optional: true },
    });
    return ctx.core.createCard({ title: p.title as string, body: p.body as string }, member.id);
  },
  listCards(ctx, params) {
    const p = validate("listCards", params, {
      includeArchived: { check: boolean, optional: true },
    });
    return ctx.core.listCards({ includeArchived: p.includeArchived as boolean });
  },
  getCard(ctx, params) {
    const p = validate("getCard", params, { id: { check: integer } });
    return ctx.core.getCard(p.id as number);
  },
  moveCard(ctx, params, member) {
    const p = validate("moveCard", params, { id: { check: integer }, phase: { check: phase } });
    return ctx.core.moveCard(
      p.id as number,
      p.phase as Methods["moveCard"]["params"]["phase"],
      member.id,
    );
  },
  setBody(ctx, params, member) {
    const p = validate("setBody", params, { id: { check: integer }, body: { check: string } });
    return ctx.core.setBody(p.id as number, p.body as string, member.id);
  },
  comment(ctx, params, member) {
    const p = validate("comment", params, { id: { check: integer }, text: { check: string } });
    return ctx.core.comment(p.id as number, p.text as string, member.id);
  },
  reviewCard(ctx, params, member) {
    const p = validate("reviewCard", params, {
      id: { check: integer },
      verdict: { check: verdict },
      text: { check: string, optional: true },
    });
    return ctx.core.review(
      p.id as number,
      {
        verdict: p.verdict as Methods["reviewCard"]["params"]["verdict"],
        text: p.text as string | undefined,
      },
      member.id,
    );
  },
  setRefs(ctx, params, member) {
    const p = validate("setRefs", params, { id: { check: integer }, refs: { check: object } });
    return ctx.core.setRefs(
      p.id as number,
      p.refs as Methods["setRefs"]["params"]["refs"],
      member.id,
    );
  },
  archiveCard(ctx, params, member) {
    const p = validate("archiveCard", params, { id: { check: integer } });
    return ctx.core.archiveCard(p.id as number, member.id);
  },
  activitySince(ctx, params) {
    const p = validate("activitySince", params, { seq: { check: integer } });
    return ctx.core.activitySince(p.seq as number);
  },
  listMembers(ctx, params) {
    validate("listMembers", params, {});
    return ctx.core.listMembers();
  },
  requestAttention(ctx, params, member) {
    const p = validate("requestAttention", params, {
      id: { check: integer },
      to: { check: integer },
      note: { check: string },
      moves: { check: phaseList, optional: true },
    });
    return ctx.core.requestAttention(
      p.id as number,
      {
        to: p.to as number,
        note: p.note as string,
        moves: p.moves as Methods["requestAttention"]["params"]["moves"],
      },
      member.id,
    );
  },
  resolveAttention(ctx, params, member) {
    const p = validate("resolveAttention", params, {
      id: { check: integer },
      text: { check: string, optional: true },
    });
    return ctx.core.resolveAttention(p.id as number, p.text as string | undefined, member.id);
  },
  listAttention(ctx, params) {
    const p = validate("listAttention", params, { to: { check: integer, optional: true } });
    return ctx.core.listAttention(p.to === undefined ? {} : { to: p.to as number });
  },
  claimCard(ctx, params, member) {
    const p = validate("claimCard", params, {
      id: { check: integer },
      ttlSeconds: { check: integer, optional: true },
    });
    return ctx.core.claimCard(
      p.id as number,
      p.ttlSeconds === undefined ? {} : { ttlSeconds: p.ttlSeconds as number },
      member.id,
    );
  },
  heartbeat(ctx, params, member) {
    const p = validate("heartbeat", params, { id: { check: integer } });
    return ctx.core.heartbeat(p.id as number, member.id);
  },
  releaseCard(ctx, params, member) {
    const p = validate("releaseCard", params, {
      id: { check: integer },
      reason: { check: string, optional: true },
    });
    return ctx.core.releaseCard(
      p.id as number,
      p.reason === undefined ? {} : { reason: p.reason as string },
      member.id,
    );
  },
  subscribe(ctx, params) {
    const p = validate("subscribe", params, { since: { check: integer, optional: true } });
    ctx.stream.subscribe(p.since as number | undefined);
    return null;
  },
  unsubscribe(ctx, params) {
    validate("unsubscribe", params, {});
    ctx.stream.unsubscribe();
    return null;
  },
};

function owner(core: Core): Member {
  const member = core.listMembers().find((m) => m.kind === "human");
  if (!member) throw new Error("the core has no owner");
  return member;
}

function isBoundMethod(name: string): name is BoundMethod {
  return Object.hasOwn(HANDLERS, name);
}

/** Answers one parsed request. Never throws: every outcome is a response. */
export function handleRequest(ctx: Context, request: JsonRpcRequest): JsonRpcResponse {
  try {
    const { method } = request;
    if (method === "hello") {
      return { jsonrpc: "2.0", id: request.id, result: hello(ctx, request.params) };
    }
    if (!isBoundMethod(method)) {
      throw new ProtocolError("method_not_found", `unknown method "${method}"`);
    }
    const member = ctx.session.member;
    if (!member) throw new ProtocolError("no_session", "say hello first");
    const handler = HANDLERS[method] as Handler<BoundMethod>;
    return { jsonrpc: "2.0", id: request.id, result: handler(ctx, request.params, member) };
  } catch (error) {
    return { jsonrpc: "2.0", id: request.id, error: toJsonRpcError(error) };
  }
}
