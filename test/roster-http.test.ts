import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { AccessDeniedError } from "../src/auth.js";
import { createMemoryRosterManagement } from "../src/roster-management.js";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);

const organizer = { circleId: "family-a", memberId: "maya", name: "Maya", role: "caregiver", status: "active", canInvite: true };
const add = { action: "add", name: "Robin", relationship: "caregiver", requestId: "request-roster-1", confirm: true };
function fixture(record: unknown = organizer) {
  const store = createDemoStore(() => new Date("2026-09-06T12:00:00Z"));
  const members = [{ id: "theo", name: "Theo", relationship: "son" as const, canReceiveAlerts: true }];
  const find = vi.fn(async () => record);
  const familyAccess = { circleId: "family-a", directory: { find } };
  const rosterManagement = createMemoryRosterManagement({ familyAccess, members, now: () => new Date("2026-09-06T12:00:00Z") });
  const options = { familyAccess, rosterManagement, accessAuthorizer: { async authorize(header: string | undefined) {
    if (!header) throw new AccessDeniedError(401, "invalid_token");
    return { subject: "organizer-account", scopes: new Set(["mcp:tools"]), claims: { iss: "https://example.invalid" } };
  } } };
  return { app: createHttpApp(store, undefined, options), store, find, members, options };
}

describe("organizer roster HTTP boundary", () => {
  it("connects a name-only caregiver through the real client and API without changing care or access", async () => {
    const { app, members, store } = fixture();
    const before = await store.today();
    const added = await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send({ ...add, name: "Maya" }).expect(200);
    const client = createWorkspaceClient({ newRequestId: () => "connect-request-1", request: async (url: string, options: { body: string }) => {
      const response = await request(app).post(url).set("authorization", "Bearer synthetic").send(JSON.parse(options.body));
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    } });
    const result = await client.changeRoster({ action: "connect_self", memberId: added.body.person.id, name: "Maya", expectedName: "Maya", confirm: true });
    expect(result.person).toMatchObject({ id: "maya", canReceiveAlerts: true, canRename: false });
    expect(members.map(m => m.id)).toEqual(["theo", "maya"]);
    expect(await store.today()).toEqual(before);
  });
  it("round-trips real workspace receipts through the API after an acknowledged-write response is lost", async () => {
    const { app, members } = fixture();
    let loseResponse = true;
    const send = vi.fn(async (url: string, options: { body: string }) => {
      const result = await request(app).post(url).set("authorization", "Bearer synthetic").send(JSON.parse(options.body));
      if (loseResponse) { loseResponse = false; throw new Error("Synthetic lost response after commit"); }
      return { ok: result.status < 400, status: result.status, json: async () => result.body };
    });
    const client = createWorkspaceClient({ request: send, newRequestId: () => "round-trip-request" });
    await expect(client.changeRoster({ action: "add", name: "Robin", relationship: "caregiver", confirm: true })).rejects.toThrow("lost response");
    expect(members).toHaveLength(2);
    const result = await client.retry();
    expect(result.person).toMatchObject({ name: "Robin", canReceiveAlerts: false });
    expect(client.pending).toBeNull(); expect(members).toHaveLength(2);
    expect(send.mock.calls[0]![1].body).toBe(send.mock.calls[1]![1].body);
  });
  it.each([null, { ...organizer, role: "viewer" }, { ...organizer, role: "care_recipient" },
    { ...organizer, canInvite: false }, { ...organizer, status: "revoked" }, { ...organizer, circleId: "another" }])(
    "denies both roster reads and writes without organizer authority: %j", async record => {
      const { app, members } = fixture(record);
      await request(app).get("/api/circle/people").set("authorization", "Bearer synthetic").expect(403);
      await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send(add).expect(403);
      expect(members).toHaveLength(1);
    });

  it("requires authentication, advertises capability, and saves a reviewed person exactly once without changing care", async () => {
    const { app, store, members, find } = fixture();
    const before = await store.today();
    await request(app).get("/api/circle/people").expect(401);
    await request(app).post("/api/circle/people").send(add).expect(401);
    const session = await request(app).get("/api/session").set("authorization", "Bearer synthetic").expect(200);
    expect(session.body.permissions.manageRoster).toBe(true);
    const first = await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send(add).expect(200);
    expect(first.body).toMatchObject({ requestId: add.requestId, action: "add", person: { name: "Robin", canReceiveAlerts: false } });
    const retry = await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send(add).expect(200);
    expect(retry.body).toEqual(first.body); expect(members).toHaveLength(2);
    const people = await request(app).get("/api/circle/people").set("authorization", "Bearer synthetic").expect(200);
    expect(people.body.members).toHaveLength(2); expect(people.body.limit).toBe(50);
    expect(people.headers["cache-control"]).toBe("no-store");
    expect(await store.today()).toEqual(before);
    find.mockResolvedValue({ ...organizer, canInvite: false });
    const lost = await request(app).get("/api/session").set("authorization", "Bearer synthetic").expect(200);
    expect(lost.body.permissions.manageRoster).toBe(false);
    await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send(add).expect(403);
  });

  it("rejects forged identities, eligibility and missing confirmation at the boundary", async () => {
    const { app, members } = fixture();
    for (const invalid of [{ ...add, actor: "Someone" }, { ...add, canReceiveAlerts: true }, { ...add, id: "maya" },
      { ...add, circleId: "another" }, { ...add, confirm: false }, { ...add, confirm: undefined }, { ...add, name: " " },
      { ...add, name: "x".repeat(81) }, { ...add, name: "Fake\u202ename" }]) {
      await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send(invalid).expect(400);
    }
    expect(members).toHaveLength(1);
  });

  it("returns a conflict for a stale rename and never rewrites the historical duty snapshot", async () => {
    const { app, store, members } = fixture();
    const before = await store.today();
    const body = { action: "rename", memberId: "theo", expectedName: "Theo", name: "Theodore", requestId: "rename-request-1", confirm: true };
    await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send(body).expect(200);
    await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send({ ...body, name: "Other", requestId: "rename-request-2" })
      .expect(409, { error: "roster_changed_refresh_required" });
    expect(members[0]!.name).toBe("Theodore"); expect(members[0]!.canReceiveAlerts).toBe(true);
    expect(await store.today()).toEqual(before);
  });

  it.each(["/api/CIRCLE/PEOPLE", "/api/circle/people/"])("does not bypass organizer checks through Express route variants: %s", async path => {
    const { app, members } = fixture({ ...organizer, canInvite: false });
    await request(app).get(path).set("authorization", "Bearer synthetic").expect(403);
    await request(app).post(path).set("authorization", "Bearer synthetic").send(add).expect(403);
    expect(members).toHaveLength(1);
  });

  it("sanitizes storage failures and cannot start with an unprotected management service", async () => {
    const { options, store } = fixture();
    expect(() => createHttpApp(store, undefined, { ...options, accessAuthorizer: undefined })).toThrow("Roster management requires");
    expect(() => createHttpApp(store, undefined, { ...options, familyAccess: undefined })).toThrow("Roster management requires");
    const app = createHttpApp(store, undefined, { ...options, rosterManagement: {
      ...options.rosterManagement, async change() { throw new Error("PRIVATE DATABASE DETAIL"); },
    } });
    await request(app).post("/api/circle/people").set("authorization", "Bearer synthetic").send(add)
      .expect(500, { error: "Internal server error" });
  });
});
