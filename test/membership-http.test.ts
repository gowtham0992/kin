import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { AccessDeniedError, type AccessAuthorizer } from "../src/auth.js";
import type { Membership } from "../src/membership.js";

const member: Membership = { circleId: "family-a", memberId: "maya", name: "Maya", role: "caregiver", status: "active" };
const authorizer: AccessAuthorizer = {
  async authorize(header) {
    if (!header) throw new AccessDeniedError(401, "invalid_token");
    return { subject: "subject-a", scopes: new Set(["mcp:tools", "mcp:resources", "mcp:service"]), claims: { iss: "https://issuer.example" } };
  },
};
const toolRequest = (name = "show_today", args = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
function setup(record: unknown = member) {
  const store = createDemoStore(() => new Date("2026-09-02T08:00:00Z"));
  const find = vi.fn(async () => record);
  const app = createHttpApp(store, undefined, { accessAuthorizer: authorizer, familyAccess: { circleId: "family-a", directory: { find } } });
  return { store, find, app };
}

describe("family authorization at the HTTP boundary", () => {
  it("requires caregiver authority for acknowledgment and takes the name from membership", async () => {
    const { app, store, find } = setup();
    const task = (await store.today()).tasks[0]!;
    const { record } = await store.queueEscalation({ taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, reason: "no_active_duty_assignment" });
    const url = `/api/escalations/${encodeURIComponent(record.id)}/acknowledge`;
    await request(app).post(url).send({ confirm: true }).expect(401);
    find.mockResolvedValue({ ...member, role: "viewer" });
    await request(app).post(url).set("authorization", "Bearer user").send({ confirm: true }).expect(403);
    find.mockResolvedValue(member);
    await request(app).post(url).set("authorization", "Bearer user").send({ confirm: true, name: "Forged" }).expect(400);
    const response = await request(app).post(url).set("authorization", "Bearer user").send({ confirm: true }).expect(200);
    expect(response.body.acknowledgedBy).toBe("Maya");
    expect(response.body.status).toBe("blocked");
  });
  it.each([null, { ...member, circleId: "family-b" }, { ...member, status: "revoked" }, { ...member, role: "admin" }])(
    "denies missing, foreign, revoked, or malformed membership: %j", async record => {
      const { app, store } = setup(record);
      const read = vi.spyOn(store, "today");
      await request(app).get("/api/today").set("authorization", "Bearer user").expect(403);
      await request(app).post("/mcp").set("authorization", "Bearer user").send(toolRequest()).expect(403);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("protects every family read even when simulator serving is enabled", async () => {
    const { app } = setup();
    for (const path of ["/api/today", "/api/circle", "/api/weekly-brief"]) {
      await request(app).get(path).expect(401);
      await request(app).get(path).set("authorization", "Bearer user").expect(200);
    }
  });

  it.each(["viewer", "care_recipient", "caregiver"] as const)("enforces the %s write permissions", async role => {
    const { app, store } = setup({ ...member, role });
    const body = { response: "done", actor: "Forged actor", requestId: "permission-request" };
    const result = await request(app).post("/api/tasks/morning-water/confirm").set("authorization", "Bearer user").send(body);
    expect(result.status).toBe(role === "viewer" ? 403 : 201);
    if (role !== "viewer") expect(result.body.confirmation.actor).toBe("Maya");
    else expect((await store.today()).summary.completed).toBe(0);
    await request(app).put("/api/circle/duty").set("authorization", "Bearer user")
      .send({ date: "2026-09-02", memberId: "maya" }).expect(role === "caregiver" ? 200 : 403);
  });

  it("denies a viewer's MCP confirmation before mutation", async () => {
    const { app, store } = setup({ ...member, role: "viewer" });
    await request(app).post("/mcp").set("authorization", "Bearer user")
      .send(toolRequest("confirm_care_task", { taskId: "morning-water", response: "done", actor: "Maya", requestId: "mcp-denied-request" })).expect(403);
    expect((await store.today()).summary.completed).toBe(0);
  });

  it("keeps discovery available without giving a service identity family data", async () => {
    const { app, find } = setup(null);
    await request(app).post("/mcp").set("authorization", "Bearer service").set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(200);
    expect(find).not.toHaveBeenCalled();
    await request(app).post("/mcp").set("authorization", "Bearer service").send(toolRequest()).expect(403);
  });

  it("fails closed without a directory and during directory failure", async () => {
    const app = createHttpApp(createDemoStore(), undefined, { accessAuthorizer: authorizer });
    await request(app).post("/mcp").set("authorization", "Bearer user").send(toolRequest()).expect(403);
    const failing = setup();
    failing.find.mockRejectedValue(new Error("database unavailable"));
    const response = await request(failing.app).get("/api/today").set("authorization", "Bearer user").expect(500);
    expect(response.body).toEqual({ error: "Internal server error" });
  });

  it("rechecks membership after revocation instead of caching the previous grant", async () => {
    const { app, find } = setup();
    await request(app).get("/api/today").set("authorization", "Bearer user").expect(200);
    find.mockResolvedValue(null);
    await request(app).get("/api/today").set("authorization", "Bearer user").expect(403);
  });

  it("isolates retry identities between members while preserving each member's retries", async () => {
    const { app, find } = setup();
    const send = (task: string) => request(app).post(`/api/tasks/${task}/confirm`).set("authorization", "Bearer user")
      .send({ response: "done", actor: "Forged", requestId: "same-client-request" });
    const first = await send("morning-water").expect(201);
    expect(first.body.confirmation).toMatchObject({ actor: "Maya", requestId: "same-client-request" });
    await send("morning-water").expect(200);
    find.mockResolvedValue({ ...member, memberId: "theo", name: "Theo" });
    const second = await send("afternoon-walk").expect(201);
    expect(second.body.confirmation).toMatchObject({ actor: "Theo", taskId: "afternoon-walk" });
  });

  it("uses the authenticated member for MCP confirmations", async () => {
    const { app, store } = setup();
    await request(app).post("/mcp").set("authorization", "Bearer user").set("accept", "application/json, text/event-stream")
      .send(toolRequest("confirm_care_task", { taskId: "morning-water", response: "done", actor: "Impersonated", requestId: "mcp-member-request" })).expect(200);
    expect((await store.today()).tasks.find(task => task.id === "morning-water")?.confirmedBy).toBe("Maya");
  });
});
