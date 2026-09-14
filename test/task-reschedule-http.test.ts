import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";

const now = new Date("2026-09-13T15:00:00.000Z");
const task: CareTask = { id: "one-off", title: "A call", dueAt: "2026-09-13T17:00:00.000Z", state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
const body = { action: "reschedule", dueAt: "2026-09-13T19:00:00.000Z", expected: { title: task.title, dueAt: task.dueAt }, requestId: "reviewed-move-1", confirm: true };
function fixture(enabled?: boolean) {
  const store = new InMemoryCareStore([task], () => now); let role = "caregiver";
  const write = vi.spyOn(store, "changeTask");
  const app = createHttpApp(store, undefined, { rescheduleEnabled: enabled,
    accessAuthorizer: { async authorize() { return { subject: "account-maya", scopes: new Set(["mcp:tools"]), claims: { iss: "https://kin.example" } }; } },
    familyAccess: { circleId: "family-a", directory: { async find() { return { circleId: "family-a", memberId: "maya", name: "Maya", role, status: "active" }; } } } });
  return { store, write, role: (value: string) => { role = value; },
    plan: () => request(app).get("/api/plan").set("authorization", "Bearer synthetic"),
    send: (input = body) => request(app).post(`/api/tasks/${task.id}/change`).set("authorization", "Bearer synthetic").send(input) };
}
describe("one-off reschedule HTTP boundary", () => {
  it("defaults off, advertises unavailable, and rejects before a write", async () => {
    const api = fixture();
    expect((await api.plan().expect(200)).body.features.reschedule).toBe(false);
    await api.send().expect(422); expect(api.write).not.toHaveBeenCalled();
    expect((await api.store.today()).tasks).toEqual([task]);
  });
  it("requires caregiver review, scopes the permanent receipt and returns the replacement without scheduling a reminder", async () => {
    const api = fixture(true);
    expect((await api.plan().expect(200)).body.features.reschedule).toBe(true);
    api.role("care_recipient"); await api.send().expect(403); api.role("caregiver");
    await api.send({ ...body, confirm: false }).expect(400);
    const first = (await api.send().expect(200)).body;
    expect(first).toMatchObject({ requestId: body.requestId, taskId: task.id, action: "reschedule", replacement: { dueAt: body.dueAt } });
    expect(api.write.mock.calls[0]![0]).toMatchObject({ actor: "Maya", requestId: expect.stringMatching(/^care-[a-f0-9]{40}$/) });
    expect((await api.send().expect(200)).body).toEqual(first);
    await api.send({ ...body, dueAt: "2026-09-13T20:00:00.000Z" }).expect(409);
    expect((await api.store.today()).tasks.map(task => task.id)).toEqual([first.replacement.taskId]);
  });
  it.each([task.dueAt, now.toISOString(), "2026-10-14T15:00:00.000Z"])("rejects new time %s with a definitive no-write response", async dueAt => {
    const api = fixture(true); await api.send({ ...body, dueAt }).expect(400);
    expect((await api.store.today()).tasks).toEqual([task]);
  });
});
