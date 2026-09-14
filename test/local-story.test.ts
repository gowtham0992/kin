import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createLocalStoryApp, localStoryStart, localStoryAfterGrace } from "../src/local-story.js";
import { createMcpCareClient } from "../simulator/mcp-client.js";
import { createConfiguredApp } from "../src/runtime.js";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function fixture() {
  const server = createLocalStoryApp().listen(0, "127.0.0.1"); servers.push(server);
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin, http: request(origin), parent: createMcpCareClient(new URL("/mcp", origin)), caregiver: createMcpCareClient(new URL("/mcp", origin)) };
}
const advance = { step: "after_grace", confirm: true };

describe("isolated local care story", () => {
  it("runs conversation review, MCP shared state, simulated follow-up, caregiver acknowledgment and the grounded brief", async () => {
    const { http, parent, caregiver } = await fixture();
    const initial = await http.get("/demo/story").expect(200);
    expect(initial.body).toMatchObject({ mode: "local-story", now: localStoryStart, timeZone: "America/Denver", step: "check_in", notifications: [] });
    expect(initial.headers["cache-control"]).toBe("no-store");
    expect(initial.headers["x-content-type-options"]).toBe("nosniff");
    expect((await parent.today()).summary).toMatchObject({ total: 1, completed: 0 });

    const proposal = await http.post("/demo/conversation").send({ message: "Not yet: Drink a glass of water" }).expect(200);
    expect(proposal.body).toMatchObject({ action: "confirm", mode: "limited", response: "not_yet", taskId: "morning-water" });
    expect(((await caregiver.today()).tasks as { lastResponse: string | null }[])[0]?.lastResponse).toBeNull();
    const confirmation = { taskId: proposal.body.taskId, response: proposal.body.response, actor: "Evelyn", expected: proposal.body.expected, requestId: "story-parent-not-yet" };
    await parent.confirm(confirmation);
    expect((await caregiver.today()).tasks).toMatchObject([{ lastResponse: "not_yet", state: "scheduled", confirmedAt: localStoryStart }]);
    expect((await http.get("/demo/story")).body.notifications).toEqual([]);

    const advanced = await http.post("/demo/story/advance").send(advance).expect(200);
    expect(advanced.body).toMatchObject({ now: localStoryAfterGrace, step: "after_grace", notifications: [{ recipientMemberName: "Theo", status: "simulated" }] });
    expect(advanced.body.notifications).toHaveLength(1);
    const id = advanced.body.notifications[0].id;
    expect(advanced.body.notifications[0]).not.toHaveProperty("taskTitle");
    expect(advanced.body.notifications[0]).not.toHaveProperty("providerMessageId");
    await parent.confirm(confirmation);
    expect((await http.post("/demo/story/advance").send(advance).expect(200)).body.notifications).toHaveLength(1);
    expect((await caregiver.today()).tasks).toMatchObject([{ confirmedAt: localStoryStart }]);

    const beforeAcknowledgment = await caregiver.brief();
    expect(beforeAcknowledgment).toMatchObject({ period: { startDate: "2026-09-02", endDate: "2026-09-08" }, generatedBy: "deterministic" });
    expect(JSON.stringify(beforeAcknowledgment.evidence).toLowerCase()).toContain("not yet");
    const path = `/api/escalations/${encodeURIComponent(id)}/acknowledge`;
    const first = await http.post(path).send({ confirm: true }).expect(200);
    expect(first.body).toMatchObject({ id, status: "sent", acknowledgedBy: "Theo", acknowledgedAt: localStoryAfterGrace });
    expect((await http.post(path).send({ confirm: true }).expect(200)).body).toEqual(first.body);
    expect((await http.get("/demo/story")).body.notifications[0]).toMatchObject({ status: "simulated", acknowledgedBy: "Theo", acknowledgedAt: localStoryAfterGrace });

    const done = await http.post("/demo/conversation").send({ message: "Done: Drink a glass of water" }).expect(200);
    await parent.confirm({ taskId: done.body.taskId, response: "done", actor: "Evelyn", expected: done.body.expected, requestId: "story-parent-done" });
    expect((await caregiver.today()).summary).toMatchObject({ total: 1, completed: 1 });
    const final = await caregiver.brief();
    expect(final).toMatchObject({ generatedBy: "deterministic", stats: { scheduled: 7, completed: 7, stillOpen: 0, escalations: 1 } });
    expect(final.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
      id: `escalation:${id}`, acknowledged: true, fact: expect.stringContaining("A caregiver acknowledged it at"),
    })]));
    // The circle's routing ledger names its frozen recipient, never the person who acknowledged.
    expect(final.responsibility).toMatchObject({ routed: [{ memberId: "theo", memberName: "Theo", count: 1 }] });
    expect(JSON.stringify(final)).not.toContain("Theo acknowledged");
    expect(JSON.stringify(final)).not.toContain("acknowledgedBy");
    expect(JSON.stringify(final.followUps).toLowerCase()).not.toContain("acknowledge");
  });

  it("keeps simultaneous and repeated advance requests at one absolute time and one simulated publish", async () => {
    const { http } = await fixture();
    const results = await Promise.all([http.post("/demo/story/advance").send(advance), http.post("/demo/story/advance").send(advance)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    for (const result of results) expect(result.body).toMatchObject({ now: localStoryAfterGrace, notifications: [{ status: "simulated" }] });
    const repeated = await http.post("/demo/story/advance").send(advance).expect(200);
    expect(repeated.body.notifications).toHaveLength(1);
    expect(repeated.body.now).toBe(localStoryAfterGrace);
  });

  it.each([{ step: "after_grace" }, { step: "reset", confirm: true }, { step: "after_grace", confirm: false },
    { ...advance, now: "2099-01-01T00:00:00Z" }, { ...advance, role: "organizer" }, { ...advance, minutes: 30 }])("rejects unsupported story control input %j without advancing", async body => {
    const { http } = await fixture();
    await http.post("/demo/story/advance").send(body).expect(400);
    expect((await http.get("/demo/story")).body).toMatchObject({ now: localStoryStart, notifications: [] });
  });

  it("rejects malformed, non-JSON and oversized controls and offers no reset endpoint", async () => {
    const { http } = await fixture();
    await http.post("/demo/story/advance").set("content-type", "application/json").send("{broken").expect(400);
    await http.post("/demo/story/advance").type("form").send(advance).expect(415);
    await http.post("/demo/story/advance").send({ ...advance, excess: "x".repeat(2000) }).expect(413);
    await http.post("/demo/story/reset").send({ confirm: true }).expect(404);
    expect((await http.get("/demo/story")).body.now).toBe(localStoryStart);
  });

  it.each(["name", "memberId", "role"])("refuses caller-supplied %s on caregiver acknowledgment", async field => {
    const { http } = await fixture();
    const advanced = await http.post("/demo/story/advance").send(advance).expect(200);
    await http.post(`/api/escalations/${encodeURIComponent(advanced.body.notifications[0].id)}/acknowledge`)
      .send({ confirm: true, [field]: "Forged" }).expect(400);
    expect((await http.get("/demo/story")).body.notifications[0]).not.toHaveProperty("acknowledgedBy");
    await http.post("/api/escalations/unknown/acknowledge").send({ confirm: true }).expect(404);
  });

  it.each(["https://attacker.example", "null", "http://127.0.0.1:1"])("blocks an untrusted Origin %s before reading or changing the story", async origin => {
    const { http } = await fixture();
    await http.get("/demo/story").set("origin", origin).expect(403);
    await http.post("/demo/story/advance").set("origin", origin).send(advance).expect(403);
    expect((await http.get("/demo/story")).body.now).toBe(localStoryStart);
  });

  it("blocks forged hosts and cross-site requests without trusting forwarded headers", async () => {
    const { http, origin } = await fixture();
    const host = new URL(origin).host;
    await http.get("/demo/story").set("host", "attacker.example").set("x-forwarded-host", host).expect(403);
    await http.get("/demo/story").set("host", "127.0.0.1:1").expect(403);
    await http.get("/demo/story").set("sec-fetch-site", "cross-site").expect(403);
    await http.post("/demo/story/advance").set("sec-fetch-site", "cross-site").send(advance).expect(403);
    const trusted = await http.get("/demo/story").set("origin", origin).set("sec-fetch-site", "same-origin").expect(200);
    expect(trusted.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it("keeps the story factory state separate between launches", async () => {
    const first = await fixture(), second = await fixture();
    await first.http.post("/demo/story/advance").send(advance).expect(200);
    expect((await second.http.get("/demo/story")).body).toMatchObject({ now: localStoryStart, notifications: [] });
  });

  it("does not register story controls in ordinary or authenticated family runtimes", async () => {
    const ordinary = createConfiguredApp({});
    const family = createHttpApp(createDemoStore(), undefined, { serveSimulator: false, serveFamilyWorkspace: true,
      accessAuthorizer: { async authorize() { throw new Error("Should not authorize a nonexistent story route"); } },
      familyAccess: { circleId: "synthetic", directory: { async find() { return null; } } },
      browserAuth: { clientId: "synthetic", issuer: "https://example.invalid", redirectUri: "https://example.invalid/invite.html", resource: "https://example.invalid/mcp" },
    });
    for (const app of [ordinary, family]) {
      await request(app).get("/demo/story").expect(404);
      await request(app).post("/demo/story/advance").send(advance).expect(404);
    }
  });
});
