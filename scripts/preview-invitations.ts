// Local synthetic UI fixture only. No AWS clients, persisted data, or live accounts.
import express from "express";
import { readFile } from "node:fs/promises";
import { createHttpApp } from "../src/http.js";
import { AccessDeniedError, type AccessPrincipal } from "../src/auth.js";
import { createDemoStore, InMemoryCareStore } from "../src/domain.js";
import { createFamilyConversationService, BudgetExceeded } from "../src/family-conversation.js";
import { createMemoryRosterManagement, type RosterMemberRecord } from "../src/roster-management.js";

const mode = process.argv[2] ?? "success";
const port = Number(process.argv[3] ?? 3014);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");
if (!["mcp-family", "success", "denied", "empty", "roster", "roster-empty", "roster-uncertain", "roster-refresh-failure", "model", "model-limited", "model-unavailable", "coverage-empty", "duty-uncertain", "today-empty", "viewer-empty", "plan-uncertain", "plan-refresh-failure", "conflict", "uncertain", "viewer", "offline", "alerts"].includes(mode)) throw new Error("Unknown fixture mode");
const app = express();
app.use((_request, response, next) => { response.set("cache-control", "no-store"); next(); });
const rosterMembers: RosterMemberRecord[] = mode === "roster-empty" ? [] : [
  { id: "evelyn", name: "Evelyn", relationship: "parent", canReceiveAlerts: false },
  { id: "maya", name: "Maya", relationship: "daughter", canReceiveAlerts: true },
  { id: "theo", name: "Theo", relationship: "son", canReceiveAlerts: true },
];
const store = mode === "coverage-empty" || mode === "duty-uncertain"
  ? new InMemoryCareStore([], () => new Date(), null, "America/Denver", [], rosterMembers)
  : createDemoStore(mode === "mcp-family" ? () => new Date("2026-09-08T15:00:00.000Z") : undefined, undefined, rosterMembers);
if (process.env.KIN_PREVIEW_PAUSE_FIXTURE === "true") {
  const base = Date.now();
  for (const [id, title, hours] of [["pause-call", "Synthetic call", 24], ["pause-walk", "Synthetic walk", 72], ["after-pause", "Synthetic next week", 192]] as const) {
    await store.scheduleTask({ id, title, dueAt: new Date(base + hours * 3_600_000).toISOString() });
  }
}
if (mode === "duty-uncertain") {
  const assign = store.assignDuty.bind(store); let first = true;
  store.assignDuty = async input => {
    const result = await assign(input);
    if (first) { first = false; throw new Error("Synthetic lost handoff acknowledgment after saving"); }
    return result;
  };
}
if (["plan-uncertain", "plan-refresh-failure"].includes(mode)) {
  const schedule = store.scheduleRoutine.bind(store), activity = store.activityBetween.bind(store);
  let saved = false;
  store.scheduleRoutine = async input => {
    const result = await schedule(input), first = !saved; saved = true;
    if (first && mode === "plan-uncertain") throw new Error("Synthetic lost acknowledgment after saving");
    return result;
  };
  store.activityBetween = async input => {
    if (saved && mode === "plan-refresh-failure") throw new Error("Synthetic refresh failure after saving");
    return activity(input);
  };
}
if (["today-empty", "viewer-empty"].includes(mode)) {
  const today = await store.today();
  store.today = async () => ({ ...today, tasks: [], escalations: [], summary: { ...today.summary, total: 0, completed: 0 } });
}
if (mode === "alerts") {
  const task = (await store.today()).tasks[0]!;
  await store.queueEscalation({ taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, reason: "no_active_duty_assignment" });
}
if (mode === "offline") store.today = async () => { throw new Error("Synthetic offline fixture"); };
if (mode === "empty") store.circle = async () => ({ startDate: "2026-09-05", endDate: "2026-09-11", members: [], assignments: [] });
let targetStatus = "active";
const familyAccess = { circleId: "synthetic", directory: { async find(principal?: AccessPrincipal) { return {
  circleId: "synthetic", memberId: mode === "mcp-family" && principal?.subject === "synthetic-theo" ? "theo" : "maya",
  name: mode === "mcp-family" && principal?.subject === "synthetic-theo" ? "Theo" : mode.startsWith("roster") ? "Maya · synthetic preview" : "Maya", role: process.env.KIN_PREVIEW_ROLE === "care_recipient" ? "care_recipient" : mode.startsWith("viewer") ? "viewer" : "caregiver", status: "active", canInvite: process.env.KIN_PREVIEW_ROLE !== "care_recipient" && mode !== "denied" && !mode.startsWith("viewer"),
}; } } };
const rosterManagement = createMemoryRosterManagement({ familyAccess, members: rosterMembers, accessMemberIds: new Set(["maya"]) });
if (mode.startsWith("roster")) {
  const change = rosterManagement.change.bind(rosterManagement), list = rosterManagement.list.bind(rosterManagement);
  let saved = false;
  rosterManagement.change = async (principal, body) => {
    const result = await change(principal, body), first = !saved; saved = true;
    if (first && mode === "roster-uncertain") throw new Error("Synthetic lost roster acknowledgment after saving");
    return result;
  };
  rosterManagement.list = async principal => {
    if (saved && mode === "roster-refresh-failure") throw new Error("Synthetic roster refresh failure");
    return list(principal);
  };
}
if (mode === "mcp-family") {
  // An explicit local test harness, not OAuth and never part of production assets.
  app.get("/", (_request, response) => { response.redirect("/home.html"); });
  const markup = (await readFile(new URL("../simulator/invite.html", import.meta.url), "utf8"))
    .replace('<script type="module" src="/invite.js"></script>', '<script type="module" src="/synthetic-family-mcp.js"></script>')
    .replace("Your family workspace — Kin", "Synthetic authenticated MCP verification — Kin")
    .replace('<footer class="kin-trust-link">', '<p class="care-note">Local preview · synthetic family and sign-in · no real accounts, AWS, or messages.</p><footer class="kin-trust-link">');
  app.get("/invite.html", (_request, response) => { response.type("html").send(markup); });
  app.get("/synthetic-family-mcp.js", (_request, response) => { response.type("js").send(`
    import { createWorkspace } from '/workspace.js';
    let identity = 'maya', generation = 0, active = true;
    const byId = id => document.getElementById(id);
    const workspace = createWorkspace({
      async request(url, options = {}) {
        const current = generation, target = new URL(url, location.origin);
        if (!active || target.origin !== location.origin || !(target.pathname.startsWith('/api/') || target.pathname === '/mcp')) throw Object.assign(new Error('Synthetic session unavailable'), { status: 401 });
        const headers = new Headers(options.headers); headers.set('authorization', 'Bearer synthetic-family-mcp-' + identity);
        const response = await fetch(target, { ...options, headers });
        if (current !== generation) throw Object.assign(new Error('Synthetic session changed'), { stale: true });
        // This local account proxy advertises the MCP UI after real fixture
        // authentication. It does not simulate an HTTPS OAuth deployment.
        if (target.pathname === '/api/session' && response.ok) {
          const session = await response.json();
          if (current !== generation) throw Object.assign(new Error('Synthetic session changed'), { stale: true });
          const sessionHeaders = new Headers(response.headers);
          for (const name of ['content-length', 'content-encoding', 'etag']) sessionHeaders.delete(name);
          return new Response(JSON.stringify({ ...session, mcpConversation: true }), {
            status: response.status, statusText: response.statusText, headers: sessionHeaders,
          });
        }
        return response;
      },
      onAccessLost() { active = false; generation += 1; byId('invite-status').textContent = 'Synthetic session ended.'; },
      onInvite() {}, onLeaveInvite() {},
    });
    const close = byId('browser-disconnect'), reopen = byId('invite-reload');
    close.hidden = false; close.textContent = 'Close synthetic workspace';
    reopen.textContent = 'Open synthetic Theo session';
    close.addEventListener('click', () => { active = false; generation += 1; workspace.reset(); close.hidden = true; reopen.hidden = false; });
    reopen.addEventListener('click', async () => { identity = 'theo'; active = true; generation += 1; reopen.hidden = true; close.hidden = false; await workspace.open(); });
    byId('invite-status').textContent = 'Synthetic account proxy · real HTTP/MCP · no OAuth, AWS, microphone, model, or messages.';
    await workspace.open();
  `); });
}
app.use(createHttpApp(store, undefined, {
  rescheduleEnabled: process.env.KIN_PREVIEW_RESCHEDULE === "true",
  // No canonical HTTPS resource belongs to this loopback-only synthetic
  // account proxy. The real socket's origin guard and bearer checks apply.
  rosterManagement: mode.startsWith("roster") ? rosterManagement : undefined,
  familyConversation: mode.startsWith("model") ? createFamilyConversationService({
    budget: { async reserve() { if (mode === "model-limited") throw new BudgetExceeded(); } },
    async generate() {
      if (mode === "model-unavailable") throw new Error("Synthetic model outage");
      return { action: "confirm", taskId: "morning-water", response: "done" };
    },
  }) : undefined,
  accessAuthorizer: { async authorize(header, requiredScopes) {
    if (mode === "mcp-family") {
      if (header !== "Bearer synthetic-family-mcp-maya" && header !== "Bearer synthetic-family-mcp-theo") throw new AccessDeniedError(401, "invalid_token");
      const scopes = new Set(["mcp:tools", "mcp:resources"]);
      if (!requiredScopes.every(scope => scopes.has(scope))) throw new AccessDeniedError(403, "insufficient_scope");
      return { subject: header.endsWith("theo") ? "synthetic-theo" : "synthetic-maya", scopes, claims: { iss: "https://synthetic.example" } };
    }
    return { subject: "synthetic-organizer", scopes: new Set(["mcp:tools"]), claims: { iss: "https://example.invalid" } };
  } },
  familyAccess,
  accessManagement: {
    async list() { return [{ memberId: "maya", name: "Maya", role: "caregiver", status: "active", organizer: true, canRevoke: false },
      { memberId: "theo", name: "Theo", role: "viewer", status: targetStatus, organizer: false, canRevoke: targetStatus === "active" }]; },
    async revoke() { targetStatus = "revoked"; },
  },
  invitationIssuer: { async issue(_principal, input) {
    if (mode === "conflict") {
      const { InvitationIssueError } = await import("../src/invitation-issuer.js");
      throw new InvitationIssueError();
    }
    if (mode === "uncertain") throw new Error("Synthetic unavailable service");
    return { code: "synthetic-preview-not-a-real-invitation-code!".replace(/!/g, "x").padEnd(43, "x").slice(0, 43),
      expiresAt: Math.floor(Date.now() / 1000) + 86400, memberId: input.memberId, role: input.role };
  } },
}));
const server = app.listen(port, "127.0.0.1", () => console.log(`Synthetic invitation preview (${mode}): http://127.0.0.1:${port}/invite.html`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
