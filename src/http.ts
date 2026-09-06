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
import { TaskNotFoundError, EscalationNotFoundError, type CareRepository } from "./domain.js";
import { createMcpServer } from "./mcp.js";
import { WeeklyBriefService } from "./weekly-brief.js";
import { confirmWithReceipt } from "./confirmation.js";
import { FamilyAccessDeniedError, mcpCarePermission, requireMembership, type FamilyAccess, type Membership } from "./membership.js";
import { InvitationIssueError, issueInvitationBody, type InvitationIssuer } from "./invitation-issuer.js";
import type { BrowserAuthConfig } from "./browser-auth-config.js";
import { familyAssets } from "./family-assets.js";
import { AccessChangeConflict, revokeAccessBody, type AccessManagement } from "./access-management.js";
import { PlanConflict, scheduleTaskBody, scheduleRoutineBody, scheduledTaskId } from "./care-plan.js";
import { routineChangeBody, RoutineConflict } from "./care-plan.js";
import { shiftCalendarDate } from "./calendar.js";

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
  browserAuth?: BrowserAuthConfig | (() => Promise<BrowserAuthConfig>);
  canonicalMcpUri?: string | (() => Promise<string>);
  authorizationServer?: string;
  serveSimulator?: boolean;
  serveFamilyWorkspace?: boolean;
  familyAssetDirectory?: string;
  accessManagement?: AccessManagement;
}

export function createHttpApp(
  store: CareRepository,
  weeklyBrief: WeeklyBriefService = new WeeklyBriefService(store),
  options: HttpAppOptions = {},
) {
  const familyEnabled = options.serveFamilyWorkspace === true;
  if (familyEnabled && (!options.accessAuthorizer || !options.familyAccess || !options.browserAuth)) {
    throw new Error("Family workspace requires authentication, membership checks, and browser sign-in");
  }
  if (familyEnabled && options.serveSimulator !== false) {
    throw new Error("Family workspace cannot serve the simulator");
  }
  const app = express();
  app.disable("x-powered-by");
  app.get("/family-auth-config", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.browserAuth || !familyEnabled) { response.status(404).json({ error: "not_enabled" }); return; }
    try { response.json(typeof options.browserAuth === "function" ? await options.browserAuth() : options.browserAuth); }
    catch (error) { next(error); }
  });
  app.use(express.json({ limit: "128kb" }));
  if (options.serveSimulator !== false) {
    app.use(express.static(simulatorDirectory, { extensions: ["html"] }));
  }
  if (familyEnabled) {
    const headers = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    app.get("/", (_request, response) => { response.set(headers).redirect("/invite.html"); });
    // Never derive a filesystem path from the request or expose the demo directory.
    for (const asset of familyAssets) {
      app.get(`/${asset}`, (_request, response) => {
        response.sendFile(asset, { root: options.familyAssetDirectory ?? simulatorDirectory, dotfiles: "deny", headers, lastModified: false, etag: false });
      });
    }
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

  if (options.serveSimulator === false && !familyEnabled) {
    app.use("/api", (_request, response) => {
      response.status(404).json({ error: "Not found" });
    });
  }

  app.use("/api", async (request, response, next) => {
    if (!options.accessAuthorizer) { next(); return; }
    try {
      const principal = await options.accessAuthorizer.authorize(request.get("authorization"), [alexaScopes.tools]);
      const permission = request.method === "GET" && request.path === "/invitations/options" ? "invite"
        : request.method === "GET" ? "read"
        : request.method === "POST" && request.path === "/invitations" ? "invite"
        : request.method === "POST" && request.path === "/access/revoke" ? "invite"
        : request.method === "POST" && ["/tasks", "/routines"].includes(request.path) ? "manage_plan"
        : request.method === "POST" && /^\/routines\/care-[a-f0-9]{40}\/change$/.test(request.path) ? "manage_plan"
        : request.method === "POST" && /^\/escalations\/[^/]+\/acknowledge$/.test(request.path) ? "manage_duty"
        : request.method === "POST" && /^\/tasks\/[^/]+\/confirm$/.test(request.path) ? "confirm"
        : request.method === "PUT" && request.path === "/circle/duty" ? "manage_duty" : null;
      if (!permission) throw new FamilyAccessDeniedError();
      response.locals.member = await requireMembership(options.familyAccess, principal, permission);
      response.locals.principal = principal;
      next();
    } catch (error) { next(error); }
  });

  app.post("/api/escalations/:id/acknowledge", async (request, response, next) => {
    const parsed = z.object({ confirm: z.literal(true) }).strict().safeParse(request.body);
    const id = z.string().min(1).max(200).safeParse(request.params.id);
    if (!parsed.success || !id.success) { response.status(400).json({ error: "invalid_acknowledgment" }); return; }
    const member = response.locals.member as Membership | undefined;
    if (!member || member.role !== "caregiver") { response.status(403).json({ error: "family_access_denied" }); return; }
    try {
      response.set("cache-control", "no-store").json(await store.acknowledgeEscalation({ id: id.data, memberId: member.memberId, name: member.name }));
    } catch (error) {
      if (error instanceof EscalationNotFoundError) { response.status(404).json({ error: "escalation_not_found" }); return; }
      next(error);
    }
  });

  app.get("/api/plan", async (_request, response, next) => {
    try {
      const { date } = await store.today();
      const plan = await store.activityBetween({ startDate: date, endDate: shiftCalendarDate(date, 30) });
      response.set("cache-control", "no-store").json({ startDate: plan.startDate, endDate: plan.endDate, tasks: plan.tasks });
    } catch (error) { next(error); }
  });

  app.post("/api/routines/:routineId/change", async (request, response, next) => {
    const parsed = routineChangeBody.safeParse(request.body);
    if (!parsed.success || !/^care-[a-f0-9]{40}$/.test(String(request.params.routineId))) { response.status(400).json({ error: "invalid_routine_change" }); return; }
    const member = response.locals.member as Membership | undefined;
    if (!member || member.role !== "caregiver") { response.status(403).json({ error: "family_access_denied" }); return; }
    try {
      const result = await store.changeRoutine({ ...parsed.data, routineId: String(request.params.routineId),
        requestId: scheduledTaskId(member.memberId, parsed.data.requestId), actor: member.name });
      response.set("cache-control", "no-store").json({ ...result, requestId: parsed.data.requestId });
    } catch (error) {
      if (error instanceof RoutineConflict) { response.status(409).json({ error: "routine_changed_refresh_required" }); return; }
      next(error);
    }
  });

  app.post("/api/routines", async (request, response, next) => {
    const parsed = scheduleRoutineBody.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "invalid_care_routine" }); return; }
    const member = response.locals.member as Membership | undefined;
    if (!member || member.role !== "caregiver") { response.status(403).json({ error: "family_access_denied" }); return; }
    try {
      const { requestId, ...input } = parsed.data;
      const tasks = await store.scheduleRoutine({ id: scheduledTaskId(member.memberId, requestId), ...input });
      response.set("cache-control", "no-store").json({ tasks, requestId });
    } catch (error) {
      if (error instanceof RangeError) { response.status(400).json({ error: "Choose consecutive daily check-ins at the same local time within the next 30 days" }); return; }
      if (error instanceof PlanConflict) { response.status(409).json({ error: "scheduling_request_conflict" }); return; }
      next(error);
    }
  });

  app.post("/api/tasks", async (request, response, next) => {
    const parsed = scheduleTaskBody.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "invalid_care_task" }); return; }
    const member = response.locals.member as Membership | undefined;
    if (!member || member.role !== "caregiver") { response.status(403).json({ error: "family_access_denied" }); return; }
    try {
      const task = await store.scheduleTask({ id: scheduledTaskId(member.memberId, parsed.data.requestId), title: parsed.data.title, dueAt: parsed.data.dueAt });
      response.set("cache-control", "no-store").json({ task, requestId: parsed.data.requestId });
    } catch (error) {
      if (error instanceof RangeError) { response.status(400).json({ error: "Schedule a check-in in the next 30 days" }); return; }
      if (error instanceof PlanConflict) { response.status(409).json({ error: "scheduling_request_conflict" }); return; }
      next(error);
    }
  });

  app.get("/api/access", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.accessManagement) { response.status(404).json({ error: "not_enabled" }); return; }
    if (!response.locals.principal) { response.status(401).json({ error: "invalid_token" }); return; }
    try {
      await requireMembership(options.familyAccess, response.locals.principal, "invite");
      response.json({ members: await options.accessManagement.list(response.locals.principal) });
    } catch (error) { next(error); }
  });
  app.post("/api/access/revoke", async (request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.accessManagement) { response.status(404).json({ error: "not_enabled" }); return; }
    if (!response.locals.principal) { response.status(401).json({ error: "invalid_token" }); return; }
    const parsed = revokeAccessBody.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "invalid_access_change" }); return; }
    try {
      await requireMembership(options.familyAccess, response.locals.principal, "invite");
      await options.accessManagement.revoke(response.locals.principal, parsed.data.memberId);
      response.json({ memberId: parsed.data.memberId, status: "revoked" });
    } catch (error) {
      if (error instanceof AccessChangeConflict) { response.status(409).json({ error: "access_change_unavailable" }); return; }
      next(error);
    }
  });

  app.get("/api/session", (_request, response) => {
    response.set("cache-control", "no-store");
    const member = response.locals.member as Membership | undefined;
    if (!member) { response.status(401).json({ error: "invalid_token" }); return; }
    response.json({ name: member.name, memberId: member.memberId, role: member.role, permissions: {
      confirm: member.role !== "viewer", manageDuty: member.role === "caregiver",
      invite: member.role === "caregiver" && member.canInvite === true,
    } });
  });

  app.get("/api/invitations/options", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.invitationIssuer) { response.status(404).json({ error: "Not found" }); return; }
    if (!options.accessAuthorizer || !response.locals.principal) { response.status(401).json({ error: "invalid_token" }); return; }
    try {
      const organizer = await requireMembership(options.familyAccess, response.locals.principal, "invite");
      const circle = await store.circle();
      response.json({ members: circle.members
        .filter(member => member.id !== organizer.memberId)
        .map(({ id, name, relationship }) => ({ id, name, relationship })) });
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
