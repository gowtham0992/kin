import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";

function fixture() {
  const store = createDemoStore(() => new Date("2026-09-08T12:00:00.000Z"));
  const find = vi.fn(async (): Promise<unknown> => ({ circleId: "family", memberId: "maya", name: "Maya", role: "caregiver", status: "active" }));
  const app = createHttpApp(store, undefined, { accessAuthorizer: { async authorize(header) {
    if (!header) throw new AccessDeniedError(401, "invalid_token");
    return { subject: "test-subject", scopes: new Set(["mcp:tools"]), claims: { iss: "https://kin.example" } };
  } }, familyAccess: { circleId: "family", directory: { find } } });
  return { store, app, find, get: () => request(app).get("/api/circle/rotation").set("authorization", "Bearer test"),
    save: (body: object) => request(app).post("/api/circle/rotation").set("authorization", "Bearer test").send(body) };
}

describe("family rotation proposal and acceptance", () => {
  it("requires a current caregiver membership for both preview and save", async () => {
    const f = fixture();
    await request(f.app).get("/api/circle/rotation").expect(401);
    const proposal = await f.get().expect(200);
    const body = { startDate: proposal.body.startDate, reviewToken: proposal.body.reviewToken, requestId: "review-next-week", confirm: true };
    await request(f.app).post("/api/circle/rotation").send(body).expect(401);
    f.find.mockResolvedValue({ circleId: "family", memberId: "theo", name: "Theo", role: "viewer", status: "active" });
    await f.get().expect(403); await f.save(body).expect(403);
    for (const path of ["/api/circle/rotation/", "/api/CIRCLE/ROTATION"]) {
      await request(f.app).get(path).set("authorization", "Bearer test").expect(403);
    }
    f.find.mockResolvedValue(null); await f.get().expect(403); await f.save(body).expect(403);
  });

  it("proposes without writing, then saves reviewed server-derived assignments once", async () => {
    const f = fixture();
    const proposal = await f.get().expect(200);
    expect(proposal.headers["cache-control"]).toBe("no-store");
    expect(proposal.body).toMatchObject({ startDate: "2026-09-15", endDate: "2026-09-21", proposedDays: 7 });
    expect((await f.get()).body).toEqual(proposal.body);
    const body = { startDate: proposal.body.startDate, reviewToken: proposal.body.reviewToken, requestId: "review-next-week", confirm: true };
    for (const invalid of [{ ...body, confirm: false }, { ...body, actor: "Forged" }, { ...body, assignments: [] }]) await f.save(invalid).expect(400);
    const saved = await f.save(body).expect(200);
    expect(saved.body).toMatchObject({ requestId: body.requestId, assigned: 7, replayed: false });
    expect(saved.body.assignments.every((day: { changedBy: string }) => day.changedBy === "Maya")).toBe(true);
    expect((await f.get()).body.proposedDays).toBe(0);
    const replay = await f.save(body).expect(200);
    expect(replay.body).toEqual({ ...saved.body, replayed: true });
    await f.save({ ...body, requestId: "another-next-week" }).expect(409);
  });

  it("rejects the whole proposal after a competing handoff changes its basis", async () => {
    const f = fixture(), proposal = (await f.get().expect(200)).body;
    const circle = await f.store.circle(), day = circle.assignments[0]!;
    await f.store.assignDuty({ date: day.date, memberId: day.memberId === "maya" ? "theo" : "maya", expectedMemberId: day.memberId, requestId: "competing-handoff" });
    await f.save({ startDate: proposal.startDate, reviewToken: proposal.reviewToken, requestId: "review-next-week", confirm: true }).expect(409);
    expect((await f.get().expect(200)).body.proposedDays).toBe(7);
  });
});
