import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AccessDeniedError,
  alexaScopes,
  requiredScopesForMcpRequest,
  type AccessAuthorizer,
} from "./auth.js";
import { TaskNotFoundError, type CareRepository } from "./domain.js";
import { createMcpServer } from "./mcp.js";
import { WeeklyBriefService } from "./weekly-brief.js";
import { confirmWithReceipt } from "./confirmation.js";
import { FamilyAccessDeniedError, mcpCarePermission, requireMembership, type FamilyAccess, type Membership } from "./membership.js";
import { InvitationIssueError, issueInvitationBody, type InvitationIssuer } from "./invitation-issuer.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const simulatorDirectory = path.resolve(moduleDirectory, "../simulator");
const confirmationBody = z.object({
  response: z.enum(["done", "not_yet", "skipped"]),
  actor: z.string().trim().min(1).max(80),
  requestId: z.string().min(8).max(100),
}).strict();
const dutyBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
}).strict();

export interface HttpAppOptions {
  accessAuthorizer?: AccessAuthorizer;
  familyAccess?: FamilyAccess;
  invitationIssuer?: InvitationIssuer;
  canonicalMcpUri?: string | (() => Promise<string>);
  authorizationServer?: string;
  serveSimulator?: boolean;
}

export function createHttpApp(
  store: CareRepository,
  weeklyBrief: WeeklyBriefService = new WeeklyBriefService(store),
  options: HttpAppOptions = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));
  if (options.serveSimulator !== false) {
    app.use(express.static(simulatorDirectory, { extensions: ["html"] }));
  }

  if (options.canonicalMcpUri || options.authorizationServer) {
    if (!options.canonicalMcpUri || !options.authorizationServer) {
      throw new Error("Both canonicalMcpUri and authorizationServer are required for OAuth metadata");
    }
    app.get("/.well-known/oauth-protected-resource", async (_request, response, next) => {
      try {
        const resource = typeof options.canonicalMcpUri === "string"
          ? options.canonicalMcpUri
          : await options.canonicalMcpUri!();
        response.set("cache-control", "public, max-age=300").json({
          resource,
          authorization_servers: [options.authorizationServer],
          bearer_methods_supported: ["header"],
          scopes_supported: Object.values(alexaScopes),
        });
      } catch (error) {
        next(error);
      }
    });
  }

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "kin", version: "0.1.0" });
  });

  if (options.serveSimulator === false) {
    app.use("/api", (_request, response) => {
      response.status(404).json({ error: "Not found" });
    });
  }

  app.use("/api", async (request, response, next) => {
    if (!options.accessAuthorizer) { next(); return; }
    try {
      const principal = await options.accessAuthorizer.authorize(request.get("authorization"), [alexaScopes.tools]);
      const permission = request.method === "GET" ? "read"
        : request.method === "POST" && request.path === "/invitations" ? "invite"
        : request.method === "POST" && /^\/tasks\/[^/]+\/confirm$/.test(request.path) ? "confirm"
        : request.method === "PUT" && request.path === "/circle/duty" ? "manage_duty" : null;
      if (!permission) throw new FamilyAccessDeniedError();
      response.locals.member = await requireMembership(options.familyAccess, principal, permission);
      response.locals.principal = principal;
      next();
    } catch (error) { next(error); }
  });

  app.post("/api/invitations", async (request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.invitationIssuer) { response.status(404).json({ error: "Not found" }); return; }
    if (!options.accessAuthorizer || !response.locals.principal) { response.status(401).json({ error: "invalid_token" }); return; }
    const body = issueInvitationBody.safeParse(request.body);
    if (!body.success) { response.status(400).json({ error: "invalid_invitation" }); return; }
    try {
      response.status(201).json(await options.invitationIssuer.issue(response.locals.principal, body.data));
    } catch (error) {
      if (error instanceof InvitationIssueError) { response.status(409).json({ error: "invitation_unavailable" }); return; }
      next(error);
    }
  });

  app.get("/api/today", async (_request, response, next) => {
    try {
      response.set("cache-control", "no-store").json(await store.today());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/weekly-brief", async (_request, response, next) => {
    try {
      response.set("cache-control", "no-store").json(await weeklyBrief.create());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/circle", async (_request, response, next) => {
    try {
      response.set("cache-control", "no-store").json(await store.circle());
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/circle/duty", async (request, response, next) => {
    const body = dutyBody.safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ error: "Invalid duty assignment" });
      return;
    }
    try {
      response.set("cache-control", "no-store").json(await store.assignDuty(body.data));
    } catch (error) {
      if (error instanceof Error && /duty|caregiver/i.test(error.message)) {
        response.status(400).json({ error: "Duty assignment is not allowed" });
        return;
      }
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/confirm", async (request, response, next) => {
    const body = confirmationBody.safeParse(request.body);
    const taskId = z.string().min(1).max(100).safeParse(request.params.taskId);
    if (!body.success || !taskId.success) {
      response.status(400).json({ error: "Invalid confirmation request" });
      return;
    }

    try {
      const member = response.locals.member as Membership | undefined;
      const result = await confirmWithReceipt(store, { taskId: taskId.data, ...body.data }, member);
      response.set("cache-control", "no-store").status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        response.status(404).json({ error: "Care task not found" });
        return;
      }
      next(error);
    }
  });

  app.post("/mcp", async (request, response) => {
    let member: Membership | undefined;
    if (options.accessAuthorizer) {
      try {
        const principal = await options.accessAuthorizer.authorize(
          request.get("authorization"),
          requiredScopesForMcpRequest(request.body),
        );
        const permission = mcpCarePermission(request.body);
        if (permission) member = await requireMembership(options.familyAccess, principal, permission);
      } catch (error) {
        if (error instanceof FamilyAccessDeniedError) {
          response.status(403).set("cache-control", "no-store").json({ error: "family_access_denied" });
          return;
        }
        if (error instanceof AccessDeniedError) {
          // Alexa+ explicitly forbids WWW-Authenticate on this integration.
          response.status(error.status).json({ error: error.code });
          return;
        }
        throw error;
      }
    }

    const server = createMcpServer(store, weeklyBrief, member);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.delete("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof FamilyAccessDeniedError) {
      response.status(403).set("cache-control", "no-store").json({ error: "family_access_denied" });
      return;
    }
    if (error instanceof AccessDeniedError) {
      response.status(error.status).set("cache-control", "no-store").json({ error: error.code });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 413
    ) {
      response.status(413).json({ error: "Request body too large" });
      return;
    }
    response.status(500).json({ error: "Internal server error" });
  });

  return app;
}
