import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";

const fixedNow = () => new Date("2026-09-02T08:00:00.000Z");

describe("Kin HTTP surface", () => {
  it("reports health without exposing framework details", async () => {
    const response = await request(createHttpApp(createDemoStore(fixedNow))).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", service: "kin", version: "0.1.0" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects oversized JSON at the request boundary", async () => {
    const response = await request(createHttpApp(createDemoStore(fixedNow)))
      .post("/mcp")
      .set("content-type", "application/json")
      .send({ value: "x".repeat(140_000) });
    expect(response.status).toBe(413);
  });

  it("does not advertise unsupported streaming methods", async () => {
    const app = createHttpApp(createDemoStore(fixedNow));
    const getResponse = await request(app).get("/mcp");
    const deleteResponse = await request(app).delete("/mcp");
    expect(getResponse.status).toBe(405);
    expect(deleteResponse.status).toBe(405);
  });

  it("drives the simulator through the same shared care state", async () => {
    const app = createHttpApp(createDemoStore(fixedNow));
    const before = await request(app).get("/api/today");
    expect(before.body.summary.completed).toBe(0);

    const confirmation = await request(app)
      .post("/api/tasks/morning-water/confirm")
      .send({ response: "done", actor: "Evelyn", requestId: "web-turn-0001" });
    expect(confirmation.status).toBe(201);
    expect(confirmation.body.snapshot.summary.completed).toBe(1);

    const after = await request(app).get("/api/today");
    expect(after.body.tasks[0]).toMatchObject({ id: "morning-water", state: "done" });
  });

  it("serves an evidence-linked weekly brief without caching family state", async () => {
    const response = await request(createHttpApp(createDemoStore(fixedNow)))
      .get("/api/weekly-brief");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      generatedBy: "deterministic",
      stats: { scheduled: 2, completed: 0 },
    });
    expect(response.body.safetyNotice).toContain("not medical advice");
  });

  it("does not expose escalation delivery internals in the public snapshot", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    const event = {
      id: "missed_morning-water_2026-09-02T15:00:00.000Z",
      taskId: "morning-water",
      taskTitle: "Drink a glass of water",
      dueAt: "2026-09-02T15:00:00.000Z",
      createdAt: now.toISOString(),
      recipient: (await store.today()).onDuty!,
    };
    const queued = await store.queueEscalation(event);
    const claimed = await store.claimEscalation({
      event, attemptId: "worker-private", now, leaseSeconds: 60,
    });
    await store.completeEscalation({
      record: claimed!,
      attemptId: "worker-private",
      providerMessageId: "private-provider-id",
      completedAt: now,
    });

    const response = await request(createHttpApp(store)).get("/api/today");
    expect(response.body.escalations[0]).toEqual({
      id: event.id,
      taskId: "morning-water",
      dueAt: event.dueAt,
      updatedAt: now.toISOString(),
      recipientMemberName: "Theo",
      status: "sent",
    });
    expect(JSON.stringify(response.body)).not.toContain("private-provider-id");
    expect(JSON.stringify(response.body)).not.toContain("worker-private");
  });

  it("rejects invalid simulator confirmation input", async () => {
    const response = await request(createHttpApp(createDemoStore(fixedNow)))
      .post("/api/tasks/morning-water/confirm")
      .send({ response: "maybe", actor: "", requestId: "tiny" });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid confirmation request" });
  });
});
