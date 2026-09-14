import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AccessDeniedError,
  alexaScopes,
  authorizeMcpRequest,
  hasMcpUserScope,
  parseMcpAuthMode,
  standardMcpChallenge,
  standardMcpResource,
  type AccessAuthorizer,
  type McpAuthMode,
} from "./auth.js";
import { ConfirmationConflict, TaskNotFoundError, EscalationNotFoundError, type CareRepository } from "./domain.js";
import { createMcpServer } from "./mcp.js";
import { createMcpInitializeTiming, startMcpTiming, type McpInitializeTimingSink } from "./mcp-initialize-timing.js";
import { WeeklyBriefService } from "./weekly-brief.js";
import { confirmWithReceipt, undoCompletionWithReceipt, pausePlanWithReceipt } from "./confirmation.js";
import { planPauseBody, PlanPauseConflict } from "./plan-pause.js";
import { completionUndoBody, completionUndoLifetime, CompletionUndoConflict } from "./response-undo.js";
import { FamilyAccessDeniedError, mcpCarePermission, requireMembership, type FamilyAccess, type Membership } from "./membership.js";
import { authorizeCareWrite, type CareWriteAuthorization } from "./care-write-authorization.js";
import { InvitationIssueError, issueInvitationBody, type InvitationIssuer } from "./invitation-issuer.js";
import type { BrowserAuthConfig } from "./browser-auth-config.js";
import { familyAssets } from "./family-assets.js";
import type { PushSubscriptions } from "./push-subscriptions.js";
import { pushEnrollmentBody, pushRemovalBody, pushConsentVersion } from "./web-push.js";
import { AccessChangeConflict, revokeAccessBody, type AccessManagement } from "./access-management.js";
import { PlanConflict, scheduleTaskBody, scheduleRoutineBody, scheduledTaskId } from "./care-plan.js";
import { routineChangeBody, RoutineConflict } from "./care-plan.js";
import { taskChangeBody, TaskChangeConflict } from "./task-change.js";
import { shiftCalendarDate } from "./calendar.js";
import { conversationBody, proposeConversation, type IntentGenerator } from "./demo-conversation.js";
import { createConversationFocus } from "./conversation-focus.js";
import { taskReviewSchema, TaskReviewConflict } from "./task-review.js";
import { DutyConflict } from "./duty-change.js";
import { dutyRotationBody, DutyRotationConflict } from "./duty-rotation.js";
import { RosterConflict, rosterChangeBody, type RosterManagement } from "./roster-management.js";
import { BudgetExceeded, ConsentRequired, ModelUnavailable, familyConversationConsentVersion, createFamilyConversationService } from "./family-conversation.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const simulatorDirectory = path.resolve(moduleDirectory, "../simulator");
const confirmationBody = z.object({
  expected: taskReviewSchema.optional(),
  response: z.enum(["done", "not_yet", "skipped"]),
  actor: z.string().trim().min(1).max(80),
  requestId: z.string().min(8).max(100),
}).strict();
const authenticatedConfirmationBody = confirmationBody.extend({ expected: taskReviewSchema });
const dutyBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  expectedMemberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).nullable().optional(),
  requestId: z.string().min(8).max(100).optional(),
}).strict().refine(input => (input.expectedMemberId !== undefined) === (input.requestId !== undefined));

export interface HttpAppOptions {
  reminderTickets?: import("./reminder-tickets.js").ReminderTickets;
  push?: { subscriptions: PushSubscriptions; publicKey: string };
  /** Optional metadata-only observer for initialize; never receives request data. */
  onMcpInitializeTiming?: McpInitializeTimingSink;
  mcpAuthMode?: McpAuthMode;
  demoIntentGenerator?: IntentGenerator;
  familyConversation?: ReturnType<typeof createFamilyConversationService>;
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
  rosterManagement?: RosterManagement;
  /** Enable only after all deployed task readers accept reschedule metadata. */
  rescheduleEnabled?: boolean;
}

export function createHttpApp(
  store: CareRepository,
  weeklyBrief: WeeklyBriefService = new WeeklyBriefService(store),
  options: HttpAppOptions = {},
) {
  const mcpAuthMode = parseMcpAuthMode(options.mcpAuthMode);
  if (mcpAuthMode === "standard" && (!options.accessAuthorizer || !options.canonicalMcpUri || !options.authorizationServer)) {
    throw new Error("Standard MCP auth requires authentication and OAuth metadata configuration");
  }
  const resolveMcpResource = async () => {
    const value = typeof options.canonicalMcpUri === "function" ? await options.canonicalMcpUri() : options.canonicalMcpUri!;
    return mcpAuthMode === "standard" ? standardMcpResource(value) : value;
  };
  if (mcpAuthMode === "standard") {
    if (typeof options.canonicalMcpUri === "string") standardMcpResource(options.canonicalMcpUri);
    standardMcpResource(options.authorizationServer!);
  }
  const familyEnabled = options.serveFamilyWorkspace === true;
  if (options.push && (!familyEnabled || !options.accessAuthorizer || !options.familyAccess)) {
    throw new Error("Push requires the authenticated family workspace");
  }
  if (options.rosterManagement && (!options.accessAuthorizer || !options.familyAccess)) {
    throw new Error("Roster management requires authentication and membership checks");
  }
  if (options.familyConversation && (!options.accessAuthorizer || !options.familyAccess)) {
    throw new Error("Family conversation requires authentication and membership checks");
  }
  if (familyEnabled && (!options.accessAuthorizer || !options.familyAccess || !options.browserAuth)) {
    throw new Error("Family workspace requires authentication, membership checks, and browser sign-in");
  }
  if (familyEnabled && options.serveSimulator !== false) {
    throw new Error("Family workspace cannot serve the simulator");
  }
  const app = express();
  app.disable("x-powered-by");
  // Origin is a browser boundary, not authentication. Native clients can omit
  // it; their existing token, scope and family checks still apply below.
  // Run before body parsing/auth and cover every method, including preflights.
  app.use("/mcp", async (request, response, next) => {
    response.set("cache-control", "no-store");
    const origin = request.headers.origin;
    if (origin === undefined) { next(); return; }
    const reject = () => { response.status(403).json({ error: "invalid_origin" }); };
    let supplied: URL;
    try {
      if (typeof origin !== "string") { reject(); return; }
      supplied = new URL(origin);
      // Require one serialized origin, not a URL with a path, credentials,
      // trailing slash, opaque/null origin, or a list that a parser might trim.
      if (!["http:", "https:"].includes(supplied.protocol) || origin !== supplied.origin) { reject(); return; }
    } catch { reject(); return; }
    try {
      if (options.canonicalMcpUri !== undefined) {
        // Only trusted configuration establishes the deployment's origin.
        // This also validates asynchronously resolved SSM configuration.
        const trustedOrigin = new URL(standardMcpResource(await resolveMcpResource())).origin;
        if (origin !== trustedOrigin) { reject(); return; }
      } else {
        // The unconfigured demo is local-only. Use the actual connection,
        // never Host, Forwarded, or Express's proxy-derived protocol/hostname.
        const { localAddress, remoteAddress, localPort } = request.socket;
        const loopback = (address: string | undefined) => address === "127.0.0.1" || address === "::ffff:127.0.0.1" || address === "::1";
        if (!loopback(localAddress) || !loopback(remoteAddress) || !Number.isInteger(localPort) || !localPort) { reject(); return; }
        const localHost = localAddress === "::1" ? "[::1]" : "127.0.0.1";
        const allowed = [`http://${localHost}:${localPort}`, `http://localhost:${localPort}`].map(value => new URL(value).origin);
        if (!allowed.includes(origin)) { reject(); return; }
      }
      next();
    } catch (error) { next(error); }
  });
  app.get("/family-auth-config", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.browserAuth || !familyEnabled) { response.status(404).json({ error: "not_enabled" }); return; }
    try { response.json(typeof options.browserAuth === "function" ? await options.browserAuth() : options.browserAuth); }
    catch (error) { next(error); }
  });
  app.use(express.json({ limit: "128kb" }));
  if (options.serveSimulator !== false) {
    app.get("/mcp-client.js", (_request, response) => {
      response.sendFile(path.resolve(moduleDirectory, "../dist/simulator/mcp-client.js"));
    });
    app.use(express.static(simulatorDirectory, { extensions: ["html"] }));
  }
  // Never register this unauthenticated, optional paid-model route on the family surface.
  if (options.serveSimulator !== false && !options.accessAuthorizer && !familyEnabled) {
    let interpreting = false;
    const focus = createConversationFocus();
    app.post("/demo/conversation", async (request, response) => {
      response.set("cache-control", "no-store");
      const parsed = conversationBody.safeParse(request.body);
      if (!parsed.success) { response.status(400).json({ error: "invalid_message" }); return; }
      if (interpreting) { response.status(429).json({ error: "conversation_busy" }); return; }
      interpreting = true;
      try {
        const snapshot = await store.today();
        const focusedTaskId = focus.resolve(parsed.data.contextToken, snapshot);
        const result = await proposeConversation(parsed.data.message, snapshot, options.demoIntentGenerator, focusedTaskId);
        response.json({ ...result, ...(result.action === "confirm"
          ? { contextToken: focus.remember(result.task.id, result.expected) } : {}) });
      }
      catch { response.status(503).json({ error: "conversation_unavailable" }); }
      finally { interpreting = false; }
    });
  }
  if (familyEnabled) {
    const headers = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
    app.get("/", (_request, response) => {
      response.sendFile("home.html", { root: options.familyAssetDirectory ?? simulatorDirectory,
        dotfiles: "deny", headers, lastModified: false, etag: false });
    });
    // Never derive a filesystem path from the request or expose the demo directory.
    for (const asset of familyAssets) {
      app.get(`/${asset}`, (_request, response) => {
        const root = options.familyAssetDirectory ?? (asset === "mcp-client.js" ? path.resolve(moduleDirectory, "../dist/simulator") : simulatorDirectory);
        response.sendFile(asset, { root, dotfiles: "deny", headers, lastModified: false, etag: false });
      });
    }
  }

  if (options.canonicalMcpUri || options.authorizationServer) {
    if (!options.canonicalMcpUri || !options.authorizationServer) {
      throw new Error("Both canonicalMcpUri and authorizationServer are required for OAuth metadata");
    }
    const metadataPaths = mcpAuthMode === "standard"
      ? ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]
      : ["/.well-known/oauth-protected-resource"];
    app.get(metadataPaths, async (_request, response, next) => {
      try {
        const resource = await resolveMcpResource();
        response.set("cache-control", "public, max-age=300").json({
          resource,
          authorization_servers: [options.authorizationServer],
          bearer_methods_supported: ["header"],
          scopes_supported: mcpAuthMode === "standard"
            ? [alexaScopes.tools, alexaScopes.resources] : Object.values(alexaScopes),
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
      const permission = ["GET", "POST"].includes(request.method) && request.path === "/circle/rotation" ? "manage_duty"
        : ["GET", "POST"].includes(request.method) && request.path === "/plan/pause" ? "pause_plan"
        : ["GET", "POST", "DELETE"].includes(request.method) && request.path === "/push/subscription" ? "manage_duty"
        : ["GET", "POST"].includes(request.method) && request.path === "/circle/people" ? "invite"
        : request.method === "GET" && request.path === "/invitations/options" ? "invite"
        : request.method === "GET" ? "read"
        : request.method === "POST" && request.path === "/invitations" ? "invite"
        : request.method === "POST" && request.path === "/access/revoke" ? "invite"
        : request.method === "POST" && ["/tasks", "/routines"].includes(request.path) ? "manage_plan"
        : request.method === "POST" && /^\/routines\/care-[a-f0-9]{40}\/change$/.test(request.path) ? "manage_plan"
        : request.method === "POST" && /^\/tasks\/[A-Za-z0-9_-]{1,100}\/change$/.test(request.path) ? "manage_plan"
        : request.method === "POST" && /^\/escalations\/[^/]+\/acknowledge$/.test(request.path) ? "manage_duty"
        : request.method === "POST" && /^\/tasks\/[^/]+\/confirm$/.test(request.path) ? "confirm"
        : request.method === "POST" && /^\/tasks\/[A-Za-z0-9_-]{1,100}\/undo$/.test(request.path) ? "confirm"
        : request.method === "POST" && request.path === "/conversation" ? "confirm"
        : request.method === "PUT" && request.path === "/circle/duty" ? "manage_duty" : null;
      if (!permission) throw new FamilyAccessDeniedError();
      response.locals.member = await requireMembership(options.familyAccess, principal, permission);
      response.locals.writeAuthorization = authorizeCareWrite(options.familyAccess, principal, response.locals.member, permission);
      response.locals.principal = principal;
      next();
    } catch (error) { next(error); }
  });

  // Model transfer is a separate, explicitly consented mode. Interpretation cannot save a task.
  app.post("/api/conversation", async (request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.accessAuthorizer || !response.locals.member) { response.status(401).json({ error: "invalid_token" }); return; }
    const body = z.union([
      z.object({ message: z.string().trim().min(1).max(800), mode: z.literal("explicit").optional(),
        selectedTaskId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }).strict(),
      z.object({ message: z.string().trim().min(1).max(800), mode: z.literal("bedrock"), transferConsent: z.literal(true),
        disclosureVersion: z.literal(familyConversationConsentVersion) }).strict(),
    ]).safeParse(request.body);
    if (!body.success) { response.status(400).json({ error: "invalid_message" }); return; }
    if (body.data.mode === "bedrock" && !options.familyConversation) { response.status(503).json({ error: "natural_language_not_enabled" }); return; }
    try {
      const snapshot = await store.today();
      if (body.data.mode === "bedrock") {
        response.json(await options.familyConversation!.propose({ message: body.data.message, consent: true }, snapshot, response.locals.member));
        return;
      }
      const selectedTaskId = body.data.selectedTaskId;
      if (selectedTaskId !== undefined) {
        const selected = snapshot.tasks.find(task => task.id === selectedTaskId && task.state === "scheduled");
        if (!selected) { response.status(409).json({ error: "selected_task_changed_refresh_required" }); return; }
        // Selection disambiguates an exact displayed title; it is not permission to
        // infer pronouns or ignore punctuation that could identify another task.
        const command = /^(done|not yet|skip)(?::\s*|\s+)(.+)$/.exec(body.data.message.toLowerCase());
        if (!command || command[2] !== selected.title.toLowerCase()) {
          response.json({ action: "clarify", mode: "limited" }); return;
        }
        response.json(await proposeConversation(body.data.message, { ...snapshot, tasks: [selected] }));
        return;
      }
      response.json(await proposeConversation(body.data.message, snapshot));
    } catch (error) {
      if (error instanceof BudgetExceeded) { response.set("retry-after", String(error.retryAfterSeconds)).status(429).json({ error: "natural_language_limited" }); return; }
      if (error instanceof ConsentRequired) { response.status(400).json({ error: "transfer_consent_required" }); return; }
      if (error instanceof ModelUnavailable) { response.status(503).json({ error: "natural_language_unavailable" }); return; }
      next(error);
    }
  });

  app.post("/api/escalations/:id/acknowledge", async (request, response, next) => {
    const parsed = z.object({ confirm: z.literal(true) }).strict().safeParse(request.body);
    const id = z.string().min(1).max(200).safeParse(request.params.id);
    if (!parsed.success || !id.success) { response.status(400).json({ error: "invalid_acknowledgment" }); return; }
    const member = response.locals.member as Membership | undefined;
    if (!member || member.role !== "caregiver") { response.status(403).json({ error: "family_access_denied" }); return; }
    try {
      response.set("cache-control", "no-store").json(await store.acknowledgeEscalation({ id: id.data, memberId: member.memberId, name: member.name }, response.locals.writeAuthorization));
    } catch (error) {
      if (error instanceof EscalationNotFoundError) { response.status(404).json({ error: "escalation_not_found" }); return; }
      next(error);
    }
  });

  app.get("/api/plan", async (_request, response, next) => {
    try {
      const { date } = await store.today();
      const plan = await store.activityBetween({ startDate: date, endDate: shiftCalendarDate(date, 30) });
      response.set("cache-control", "no-store").json({ startDate: plan.startDate, endDate: plan.endDate, tasks: plan.tasks,
        planPause: await store.planControl(),
        features: { reschedule: options.rescheduleEnabled === true, planPause: store.planPauseEnabled === true && response.locals.member?.role !== "viewer" } });
    } catch (error) { next(error); }
  });

  app.get("/api/plan/pause", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.accessAuthorizer || !response.locals.member) { response.status(401).json({ error: "invalid_token" }); return; }
    if (!store.planPauseEnabled) { response.status(404).json({ error: "not_enabled" }); return; }
    try {
      const proposal = await store.proposePlanPause(), control = await store.planControl();
      await response.locals.writeAuthorization.assertCurrent();
      response.json({ control, proposal });
    } catch (error) { next(error); }
  });

  app.post("/api/plan/pause", async (request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.accessAuthorizer || !response.locals.member) { response.status(401).json({ error: "invalid_token" }); return; }
    if (!store.planPauseEnabled) { response.status(404).json({ error: "not_enabled" }); return; }
    const parsed = planPauseBody.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "invalid_pause_request" }); return; }
    try {
      const result = await pausePlanWithReceipt(store, parsed.data, response.locals.member, response.locals.writeAuthorization);
      response.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });

  app.post("/api/tasks/:taskId/change", async (request, response, next) => {
    const parsed = taskChangeBody.safeParse(request.body);
    const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).safeParse(request.params.taskId);
    if (!parsed.success || !taskId.success) { response.status(400).json({ error: "invalid_task_change" }); return; }
    const member = response.locals.member as Membership | undefined;
    if (!member || member.role !== "caregiver") { response.status(403).json({ error: "family_access_denied" }); return; }
    if (parsed.data.action === "reschedule" && options.rescheduleEnabled !== true) {
      response.status(422).json({ error: "reschedule_unavailable" }); return;
    }
    try {
      const result = await store.changeTask({ ...parsed.data, taskId: taskId.data,
        requestId: scheduledTaskId(member.memberId, parsed.data.requestId), actor: member.name }, response.locals.writeAuthorization);
      response.set("cache-control", "no-store").json({ ...result, requestId: parsed.data.requestId });
    } catch (error) {
      if (error instanceof TaskChangeConflict) { response.status(409).json({ error: "task_changed_refresh_required" }); return; }
      if (error instanceof RangeError) { response.status(400).json({ error: "invalid_reschedule_time" }); return; }
      next(error);
    }
  });

  app.post("/api/routines/:routineId/change", async (request, response, next) => {
    const parsed = routineChangeBody.safeParse(request.body);
    if (!parsed.success || !/^care-[a-f0-9]{40}$/.test(String(request.params.routineId))) { response.status(400).json({ error: "invalid_routine_change" }); return; }
    const member = response.locals.member as Membership | undefined;
    if (!member || member.role !== "caregiver") { response.status(403).json({ error: "family_access_denied" }); return; }
    try {
      const result = await store.changeRoutine({ ...parsed.data, routineId: String(request.params.routineId),
        requestId: scheduledTaskId(member.memberId, parsed.data.requestId), actor: member.name }, response.locals.writeAuthorization);
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
      const tasks = await store.scheduleRoutine({ id: scheduledTaskId(member.memberId, requestId), ...input }, response.locals.writeAuthorization);
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
      const task = await store.scheduleTask({ id: scheduledTaskId(member.memberId, parsed.data.requestId), title: parsed.data.title, dueAt: parsed.data.dueAt }, response.locals.writeAuthorization);
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
    response.json({ name: member.name, memberId: member.memberId, role: member.role,
      ...(store.completionUndoEnabled && member.role !== "viewer" ? { features: { completionUndo: true, completionUndoWindowSeconds: completionUndoLifetime / 1000 } } : {}),
      ...(options.push && member.role === "caregiver" ? { push: { publicKey: options.push.publicKey, consentVersion: pushConsentVersion } } : {}),
      ...(options.mcpAuthMode === "standard" && member.role !== "viewer" ? { mcpConversation: true } : {}), permissions: {
      confirm: member.role !== "viewer", manageDuty: member.role === "caregiver",
      pausePlan: member.role !== "viewer",
      invite: member.role === "caregiver" && member.canInvite === true,
      ...(options.rosterManagement ? { manageRoster: member.role === "caregiver" && member.canInvite === true } : {}),
    }, ...(options.familyConversation && member.role !== "viewer"
      ? { conversation: { naturalLanguage: true, consentVersion: familyConversationConsentVersion } } : {}) });
  });

  app.get("/api/push/subscription", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.push) { response.status(503).json({ error: "push_unavailable" }); return; }
    const authorization = response.locals.writeAuthorization as CareWriteAuthorization | undefined;
    if (!authorization) { response.status(401).json({ error: "invalid_token" }); return; }
    try {
      const [enrollment, snapshot] = await Promise.all([options.push.subscriptions.status(authorization), store.today()]);
      await authorization.assertCurrent();
      response.json({ publicKey: options.push.publicKey, consentVersion: pushConsentVersion, enrollment,
        duty: { assigned: snapshot.onDuty !== null, onDuty: snapshot.onDuty?.memberId === authorization.member.memberId },
        // Enrollment configuration does not establish worker/scheduler health.
        delivery: "unverified" });
    } catch (error) {
      if (error instanceof FamilyAccessDeniedError) { next(error); return; }
      response.status(503).json({ error: "push_settings_unavailable" });
    }
  });
  for (const method of ["post", "delete"] as const) app[method]("/api/push/subscription", async (request, response) => {
    response.set("cache-control", "no-store");
    if (!options.push || !response.locals.writeAuthorization) { response.status(503).json({ error: "push_unavailable" }); return; }
    const parsed = method === "post" ? pushEnrollmentBody.safeParse(request.body) : pushRemovalBody.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "invalid_push_settings" }); return; }
    try {
      if ("subscription" in parsed.data) await options.push.subscriptions.enroll(response.locals.writeAuthorization, parsed.data.subscription);
      else await options.push.subscriptions.remove(response.locals.writeAuthorization, parsed.data.endpoint);
      response.status(204).end();
    } catch { response.status(503).json({ error: "push_settings_unavailable" }); }
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

  app.get("/api/circle/people", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.rosterManagement) { response.status(404).json({ error: "not_enabled" }); return; }
    if (!response.locals.principal) { response.status(401).json({ error: "invalid_token" }); return; }
    try {
      await requireMembership(options.familyAccess, response.locals.principal, "invite");
      response.json(await options.rosterManagement.list(response.locals.principal));
    } catch (error) { next(error); }
  });
  app.post("/api/circle/people", async (request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.rosterManagement) { response.status(404).json({ error: "not_enabled" }); return; }
    if (!response.locals.principal) { response.status(401).json({ error: "invalid_token" }); return; }
    const body = rosterChangeBody.safeParse(request.body);
    if (!body.success) { response.status(400).json({ error: "invalid_roster_change" }); return; }
    try {
      await requireMembership(options.familyAccess, response.locals.principal, "invite");
      response.json(await options.rosterManagement.change(response.locals.principal, body.data));
    } catch (error) {
      if (error instanceof RosterConflict) { response.status(409).json({ error: "roster_changed_refresh_required" }); return; }
      next(error);
    }
  });

  app.get("/api/circle/rotation", async (_request, response, next) => {
    response.set("cache-control", "no-store");
    try {
      if (options.accessAuthorizer) await requireMembership(options.familyAccess, response.locals.principal, "manage_duty");
      response.json(await store.proposeDutyRotation());
    }
    catch (error) {
      if (error instanceof DutyRotationConflict) { response.status(409).json({ error: "rotation_changed_refresh_required" }); return; }
      next(error);
    }
  });
  app.post("/api/circle/rotation", async (request, response, next) => {
    response.set("cache-control", "no-store");
    const body = dutyRotationBody.safeParse(request.body);
    if (!body.success) { response.status(400).json({ error: "invalid_rotation" }); return; }
    try {
      if (options.accessAuthorizer) await requireMembership(options.familyAccess, response.locals.principal, "manage_duty");
      const member = response.locals.member as Membership | undefined;
      const result = await store.acceptDutyRotation({ ...body.data,
        ...(member ? { requestId: scheduledTaskId(member.memberId, body.data.requestId), actor: member.name } : {}) }, response.locals.writeAuthorization);
      response.json({ ...result, requestId: body.data.requestId });
    } catch (error) {
      if (error instanceof DutyRotationConflict) { response.status(409).json({ error: "rotation_changed_refresh_required" }); return; }
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
      const member = response.locals.member as Membership | undefined;
      const result = await store.assignDuty({ ...body.data,
        ...(body.data.requestId && member ? { requestId: scheduledTaskId(member.memberId, body.data.requestId), actor: member.name } : {}) }, response.locals.writeAuthorization);
      response.set("cache-control", "no-store").json({ ...result, ...(body.data.requestId ? { requestId: body.data.requestId } : {}) });
    } catch (error) {
      if (error instanceof DutyConflict) { response.status(409).json({ error: "duty_changed_refresh_required" }); return; }
      if (error instanceof Error && /duty|caregiver/i.test(error.message)) {
        response.status(400).json({ error: "Duty assignment is not allowed" });
        return;
      }
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/undo", async (request, response, next) => {
    response.set("cache-control", "no-store");
    if (!options.accessAuthorizer || !response.locals.member) { response.status(401).json({ error: "invalid_token" }); return; }
    if (!store.completionUndoEnabled) { response.status(404).json({ error: "not_enabled" }); return; }
    const body = completionUndoBody.omit({ taskId: true }).safeParse(request.body);
    const taskId = completionUndoBody.shape.taskId.safeParse(request.params.taskId);
    if (!body.success || !taskId.success) { response.status(400).json({ error: "invalid_undo_request" }); return; }
    try {
      const result = await undoCompletionWithReceipt(store, { ...body.data, taskId: taskId.data }, response.locals.member, response.locals.writeAuthorization);
      response.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof CompletionUndoConflict) { response.status(409).json({ error: "undo_conflict" }); return; }
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/confirm", async (request, response, next) => {
    // Only the unauthenticated local simulator retains the legacy optional review.
    const body = (options.accessAuthorizer ? authenticatedConfirmationBody : confirmationBody).safeParse(request.body);
    const taskId = z.string().min(1).max(100).safeParse(request.params.taskId);
    if (!body.success || !taskId.success) {
      response.status(400).json({ error: "Invalid confirmation request" });
      return;
    }

    try {
      const member = response.locals.member as Membership | undefined;
      const result = await confirmWithReceipt(store, { taskId: taskId.data, ...body.data }, member, response.locals.writeAuthorization);
      response.set("cache-control", "no-store").status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof ConfirmationConflict) {
        response.status(409).json({ error: "confirmation_conflict" }); return;
      }
      if (error instanceof TaskReviewConflict) {
        response.status(409).json({ error: "review_conflict" }); return;
      }
      if (error instanceof TaskNotFoundError) {
        response.status(404).json({ error: "Care task not found" });
        return;
      }
      next(error);
    }
  });

  app.post("/mcp", async (request, response) => {
    const timing = request.body && typeof request.body === "object" && !Array.isArray(request.body) && request.body.method === "initialize"
      ? createMcpInitializeTiming(options.onMcpInitializeTiming) : undefined;
    let completed = false;
    try {
    response.set("cache-control", "no-store");
    let member: Membership | undefined;
    let writeAuthorization: CareWriteAuthorization | undefined;
    if (options.accessAuthorizer) {
      try {
        const principal = await authorizeMcpRequest(
          options.accessAuthorizer, request.get("authorization"), request.body,
          timing,
        );
        const permission = mcpCarePermission(request.body);
        // Service-only discovery stays independent of a family. A user-scoped
        // connection must still have current access, including on every list/ping.
        if (permission || hasMcpUserScope(principal)) {
          const endMembership = startMcpTiming(timing, "membership");
          try { member = await requireMembership(options.familyAccess, principal, permission ?? "read"); }
          finally { endMembership(); }
          writeAuthorization = authorizeCareWrite(options.familyAccess, principal, member, permission ?? "read");
        }
      } catch (error) {
        if (error instanceof FamilyAccessDeniedError) {
          response.status(403).set("cache-control", "no-store").json({ error: "family_access_denied" });
          return;
        }
        if (error instanceof AccessDeniedError) {
          // Standard clients need a user-scope challenge. The private Alexa
          // profile intentionally retains its no-challenge contract.
          if (mcpAuthMode === "standard") {
            response.set("www-authenticate", standardMcpChallenge(
              await resolveMcpResource(), request.body, request.get("authorization") ? error.code : undefined,
            ));
          }
          response.status(error.status).json({ error: error.code });
          return;
        }
        throw error;
      }
    }

    const endSetup = startMcpTiming(timing, "server_setup");
    let server: ReturnType<typeof createMcpServer>, transport: StreamableHTTPServerTransport;
    try {
      server = createMcpServer(store, weeklyBrief, member, writeAuthorization, options.reminderTickets);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    } finally { endSetup(); }
    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      const endConnect = startMcpTiming(timing, "server_connect");
      try { await server.connect(transport); } finally { endConnect(); }
      const endHandle = startMcpTiming(timing, "request_handle");
      try { await transport.handleRequest(request, response, request.body); } finally { endHandle(); }
      completed = true;
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
    } finally {
      timing?.finish(completed && response.statusCode < 400 ? "success" : "failure", response.headersSent ? response.statusCode : undefined);
    }
  });

  app.get("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.delete("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof PlanPauseConflict) { response.status(409).json({ error: "pause_conflict" }); return; }
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
