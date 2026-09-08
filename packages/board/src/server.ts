/**
 * The board's HTTP surface: a JSON API, an SSE activity stream, the MCP endpoint,
 * and the static web UI. No model clients, no repository contents — this server coordinates.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Activity, MemberKind } from "@kanbot/shared";
import * as core from "./core.js";
import { BoardError } from "./core.js";
import { createMcpServer } from "./mcp.js";
import { PUBLIC_DIR } from "./db.js";

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

/** Send whatever the handler returns as JSON; turn BoardErrors into status codes. */
function route(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await handler(req, res);
      if (res.headersSent) return;
      res.json(result ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BoardError(400, `"${field}" is required`);
  }
  return value;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Express 5 types route params as string | string[]; our routes only ever take one. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== "string" || single === "") {
    throw new BoardError(400, `missing route parameter "${name}"`);
  }
  return single;
}

/** Every mutation names an actor; the API defaults to the owner so the UI can stay simple. */
function actor(body: Record<string, unknown>): string {
  const given = optStr(body.actorId);
  if (given) return given;
  return core.getOwner().id;
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  /* --------------------------------------------------------------- reads */

  app.get("/api/board", route(() => core.getBoard()));

  app.get("/api/owner", route(() => core.getOwner()));

  app.get(
    "/api/cards/:id",
    route((req) => core.getCardDetail(param(req, "id"))),
  );

  /* ----------------------------------------------------------- mutations */

  app.post(
    "/api/members",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      const kind = (optStr(body.kind) ?? "agent") as MemberKind;
      if (kind !== "human" && kind !== "agent") {
        throw new BoardError(400, `"kind" must be "human" or "agent"`);
      }
      return core.upsertMember(str(body.name, "name"), kind);
    }),
  );

  app.post(
    "/api/cards",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      return core.createCard(
        str(body.title, "title"),
        typeof body.body === "string" ? body.body : "",
        optStr(body.actorId),
      );
    }),
  );

  app.post(
    "/api/cards/:id/move",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      return core.moveCard(param(req, "id"), str(body.laneId, "laneId"), actor(body));
    }),
  );

  app.post(
    "/api/cards/:id/comment",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      return core.comment(param(req, "id"), str(body.text, "text"), actor(body));
    }),
  );

  app.post(
    "/api/cards/:id/spec",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      return core.setSpec(param(req, "id"), str(body.markdown, "markdown"), actor(body));
    }),
  );

  app.post(
    "/api/cards/:id/refs",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      return core.setRefs(
        param(req, "id"),
        { branch: optStr(body.branch), prUrl: optStr(body.prUrl) },
        actor(body),
      );
    }),
  );

  app.post(
    "/api/cards/:id/claim",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      const ttl = typeof body.ttlSec === "number" ? body.ttlSec : 120;
      return core.claimCard(param(req, "id"), str(body.actorId, "actorId"), ttl);
    }),
  );

  app.post(
    "/api/cards/:id/heartbeat",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      const ttl = typeof body.ttlSec === "number" ? body.ttlSec : 120;
      return core.heartbeat(param(req, "id"), str(body.actorId, "actorId"), ttl);
    }),
  );

  app.post(
    "/api/cards/:id/release",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      return core.releaseCard(param(req, "id"), str(body.actorId, "actorId"), optStr(body.reason));
    }),
  );

  app.post(
    "/api/cards/:id/attention",
    route((req) => {
      const body = req.body as Record<string, unknown>;
      const to = optStr(body.toId) ?? core.getOwner().id;
      return core.requestAttention(
        param(req, "id"),
        to,
        typeof body.note === "string" ? body.note : "",
        actor(body),
      );
    }),
  );

  /* ------------------------------------------------------------- SSE feed */

  app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    res.write(": connected\n\n");

    const onActivity = (activity: Activity): void => {
      res.write(`event: activity\ndata: ${JSON.stringify(activity)}\n\n`);
    };
    core.events.on("activity", onActivity);

    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20000);

    req.on("close", () => {
      clearInterval(keepAlive);
      core.events.off("activity", onActivity);
      res.end();
    });
  });

  /* ---------------------------------------------------------- MCP endpoint */

  // Stateless: a fresh server + transport per request, so any number of agents can
  // connect without the board holding session state.
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp]", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // The MCP spec's other verbs have no meaning in stateless mode.
  const noSession = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: kanbot's MCP endpoint is stateless" },
      id: null,
    });
  };
  app.get("/mcp", noSession);
  app.delete("/mcp", noSession);

  /* ------------------------------------------------------------------ UI */

  app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

  /* --------------------------------------------------------------- errors */

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BoardError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[board]", err);
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: message });
  });

  return app;
}
