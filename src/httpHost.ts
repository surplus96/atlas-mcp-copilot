import crypto from "crypto";
import express, { Express, NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Config } from "./config";
import { ApiClient } from "./http/apiClient";
import { Logger } from "./util/logger";
import { createServer } from "./mcpServer";

/** Constant-time string compare so a wrong token can't be brute-forced via response timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so this branch doesn't
    // return measurably faster than a real mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireBearerToken(config: Config, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token || !safeEqual(token, config.mcpAuthToken)) {
      logger.warn("Rejected /mcp request with missing or invalid bearer token", {
        path: req.path,
        ip: req.ip,
      });
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
        id: null,
      });
      return;
    }
    next();
  };
}

/**
 * Rejects requests whose Host header isn't one we expect this server to be reached
 * as, before the auth check runs. Defends against DNS rebinding: without this, a
 * hostile web page a developer visits could rebind a DNS name to 127.0.0.1 and
 * drive a browser fetch() against this server using the victim's own network
 * position — the bearer token alone doesn't stop that if the token is later also
 * leaked, and per the MCP spec, HTTP-transport servers should validate Origin/Host
 * regardless. Override via ALLOWED_HOSTS (comma-separated) if this server is
 * legitimately reached under a different hostname (e.g. inside a docker network).
 */
function requireAllowedHost(config: Config, logger: Logger) {
  const extra = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowed = new Set([
    "localhost",
    "127.0.0.1",
    `localhost:${config.mcpPort}`,
    `127.0.0.1:${config.mcpPort}`,
    ...extra,
  ]);

  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.header("host") ?? "";
    if (!allowed.has(host)) {
      logger.warn("Rejected /mcp request with disallowed Host header (possible DNS rebinding)", {
        host,
        ip: req.ip,
      });
      res.status(421).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Misdirected request: Host header not allowed." },
        id: null,
      });
      return;
    }
    next();
  };
}

/**
 * Hosts the MCP over Streamable HTTP in stateless mode: each POST /mcp
 * request gets its own McpServer + transport pair, so no session state is
 * kept between requests. Simpler and safe for multi-instance deployments;
 * the tradeoff is no server-initiated notifications between calls, which
 * none of these tools need.
 */
export function buildApp(config: Config, apiClient: ApiClient, logger: Logger): Express {
  const app = express();
  app.use(express.json());

  // /health intentionally stays open (no bearer check) so container/orchestrator
  // health probes don't need the secret.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const hostGate = requireAllowedHost(config, logger);
  const authGate = requireBearerToken(config, logger);

  app.post("/mcp", hostGate, authGate, async (req, res) => {
    try {
      const server = createServer(apiClient, logger);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("Unhandled error servicing /mcp request", { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode." },
      id: null,
    });
  };
  app.get("/mcp", hostGate, authGate, methodNotAllowed);
  app.delete("/mcp", hostGate, authGate, methodNotAllowed);

  return app;
}
