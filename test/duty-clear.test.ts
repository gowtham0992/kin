import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { createDemoStore } from "../src/domain.js";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
import { createHttpApp } from "../src/http.js";

function fixture() {
  const store = createDemoStore(() => new Date("2026-09-08T12:00:00Z"));
  const find = vi.fn(async (): Promise<unknown> => ({ circleId: "family", memberId: "maya", name: "Maya", role: "caregiver", status: "active" }));
  const app = createHttpApp(store, undefined, { accessAuthorizer: { async authorize(header) {
    if (!header) throw new AccessDeniedError(401, "invalid_token");
    return { subject: "test", scopes: new Set(["mcp:tools"]), claims: { iss: "https://kin.example" } };
  } }, familyAccess: { circleId: "family", directory: { find } } });
  return { store, find, app, save: (body: object) => request(app).put("/api/circle/duty").set("authorization", "Bearer test").send(body) };
}

describe("reviewed duty removal", () => {
  it("clears exactly the reviewed day and replays without removing a later assignment", async () => {
    const f = fixture(), before = await f.store.circle(), day = before.assignments[0]!;
    const body = { date: day.date, memberId: null, expectedMemberId: day.memberId, requestId: "clear-duty-001" };
    const saved = await f.save(body).expect(200);
    expect(saved.body.assignments).toEqual(before.assignments.filter(item => item.date !== day.date));
    await f.store.assignDuty({ date: day.date, memberId: "theo" });
    expect((await f.save(body).expect(200)).body).toEqual(saved.body);
    expect((await f.store.circle()).assignments.find(item => item.date === day.date)?.memberId).toBe("theo");
  });
  it("rejects stale removal without changing the newer assignment", async () => {
    const f = fixture(), day = (await f.store.circle()).assignments[0]!;
    await f.store.assignDuty({ date: day.date, memberId: "theo" });
    await f.save({ date: day.date, memberId: null, expectedMemberId: "maya", requestId: "clear-duty-002" }).expect(409);
    expect((await f.store.circle()).assignments.find(item => item.date === day.date)?.memberId).toBe("theo");
  });
  it("requires a reviewed existing assignment and never accepts forged attribution", async () => {
    const f = fixture(), day = (await f.store.circle()).assignments[0]!;
    for (const body of [
      { date: day.date, memberId: null },
      { date: day.date, memberId: null, expectedMemberId: null, requestId: "clear-duty-003" },
      { date: day.date, memberId: null, expectedMemberId: day.memberId, requestId: "clear-duty-003", actor: "Forged" },
    ]) await f.save(body).expect(400);
    expect((await f.store.circle()).assignments).toContainEqual(day);
  });
  it("denies anonymous, viewer and revoked removal", async () => {
    const f = fixture(), day = (await f.store.circle()).assignments[0]!;
    const body = { date: day.date, memberId: null, expectedMemberId: day.memberId, requestId: "clear-duty-004" };
    await request(f.app).put("/api/circle/duty").send(body).expect(401);
    f.find.mockResolvedValue({ circleId: "family", memberId: "theo", name: "Theo", role: "viewer", status: "active" });
    await f.save(body).expect(403);
    f.find.mockResolvedValue(null); await f.save(body).expect(403);
    expect((await f.store.circle()).assignments).toContainEqual(day);
  });
  it("keeps the exact removal for uncertain retry and validates an absent-day receipt", async () => {
    const bodies: string[] = [];
    let lost = true;
    const client = createWorkspaceClient({ newRequestId: () => "clear-duty-client", request: async (_url: string, options: { body: string }) => {
      bodies.push(options.body); if (lost) { lost = false; throw new Error("Lost response"); }
      return { ok: true, json: async () => ({ requestId: "clear-duty-client", assignments: [] }) };
    } });
    await expect(client.assignDuty({ date: "2026-09-08", memberId: null, expectedMemberId: "maya" })).rejects.toThrow("Lost response");
    await client.retry(); expect(bodies[1]).toBe(bodies[0]); expect(client.pending).toBeNull();
  });
});
