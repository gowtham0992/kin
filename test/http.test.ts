import request from "supertest";
import { createLambdaHttpHandler } from "../src/lambda-http.js";
import { describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { AccessDeniedError, alexaScopes, type AccessAuthorizer } from "../src/auth.js";

const fixedNow = () => new Date("2026-09-02T08:00:00.000Z");

describe("Kin HTTP surface", () => {
  it("acknowledges a saved confirmation even when the following snapshot read fails", async () => {
    const store = createDemoStore(fixedNow);
    const readToday = store.today.bind(store);
    vi.spyOn(store, "today").mockRejectedValue(new Error("Read unavailable"));
    const response = await request(createHttpApp(store)).post("/api/tasks/morning-water/confirm")
      .send({ response: "done", actor: "Evelyn", requestId: "saved-read-failed" });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      task: { state: "done" }, confirmation: { requestId: "saved-read-failed" },
      snapshot: null, refreshRequired: true,
    });
    expect((await readToday()).summary.completed).toBe(1);
  });

  it("preserves MCP content type through the Lambda HTTP adapter", async () => {
    const handler = createLambdaHttpHandler(createHttpApp(createDemoStore(fixedNow)));
    const response = await handler({
      version: "2.0", routeKey: "$default", rawPath: "/mcp", rawQueryString: "",
      headers: { host: "api.example.com", "content-type": "application/json", accept: "application/json, text/event-stream" },
      requestContext: { http: { method: "POST", path: "/mcp", protocol: "HTTP/1.1", sourceIp: "127.0.0.1" }, stage: "$default" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }), isBase64Encoded: false,
    }, {} as never, () => {});
    expect(response.statusCode).toBe(200);
    expect(new Headers(response.headers).get("content-type")).toContain("text/event-stream");
    expect(response.body).toContain('"protocolVersion":"2025-11-25"');
  });

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

  it.each(["2025-03-26", "2025-11-25"])(
    "accepts Alexa initialization protocol %s over Streamable HTTP",
    async (protocolVersion) => {
      const response = await request(createHttpApp(createDemoStore(fixedNow)))
        .post("/mcp")
        .set("accept", "application/json, text/event-stream")
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "Alexa+ MCP Client", version: "1.0.0" },
          },
        });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.text).toContain(`\"protocolVersion\":\"${protocolVersion}\"`);
      expect(response.text).toContain(`\"name\":\"kin\"`);
    },
  );

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
    // The service clock must stay inside the fixture's activity window too.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T23:00:00.000Z"));
    try {
      const response = await request(createHttpApp(createDemoStore(fixedNow)))
        .get("/api/weekly-brief");
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toMatchObject({
        generatedBy: "deterministic",
        period: { endDate: "2026-09-02" },
        stats: { scheduled: 2, completed: 0 },
      });
      expect(response.body.safetyNotice).toContain("not medical advice");
    } finally { vi.useRealTimers(); }
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
      taskTitle: "Drink a glass of water",
      dueAt: event.dueAt,
      updatedAt: now.toISOString(),
      recipientMemberName: "Theo",
      recipientMemberId: "theo",
      sentAt: now.toISOString(),
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

  it("shows the care circle and updates one roster day", async () => {
    const app = createHttpApp(createDemoStore(fixedNow));
    const before = await request(app).get("/api/circle");
    expect(before.body.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "maya", canReceiveAlerts: true }),
      expect.objectContaining({ id: "theo", canReceiveAlerts: true }),
    ]));
    expect(before.body.assignments).toHaveLength(7);

    const updated = await request(app).put("/api/circle/duty").send({
      date: "2026-09-03",
      memberId: "maya",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: "2026-09-03", memberId: "maya" }),
    ]));
  });

  it("rejects assigning the care recipient to alert duty", async () => {
    const response = await request(createHttpApp(createDemoStore(fixedNow)))
      .put("/api/circle/duty")
      .send({ date: "2026-09-03", memberId: "evelyn" });
    expect(response.status).toBe(400);
  });

  it("publishes Alexa-compatible protected resource metadata", async () => {
    const response = await request(createHttpApp(
      createDemoStore(fixedNow),
      undefined,
      {
        canonicalMcpUri: "https://api.kin.example/mcp",
        authorizationServer: "https://auth.kin.example",
      },
    )).get("/.well-known/oauth-protected-resource");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      resource: "https://api.kin.example/mcp",
      authorization_servers: ["https://auth.kin.example"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:service", "mcp:tools", "mcp:resources"],
    });
  });

  it("requires a verified token for MCP discovery without advertising an Alexa challenge", async () => {
    const authorizer: AccessAuthorizer = {
      async authorize(header, scopes) {
        expect(header).toBeUndefined();
        expect(scopes).toEqual([]);
        throw new AccessDeniedError(401, "invalid_token");
      },
    };
    const response = await request(createHttpApp(
      createDemoStore(fixedNow),
      undefined,
      { accessAuthorizer: authorizer },
    )).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid_token" });
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("requires user tools scope before a care action reaches MCP", async () => {
    const authorizer: AccessAuthorizer = {
      async authorize(header, scopes) {
        expect(header).toBe("Bearer signed-token");
        expect(scopes).toEqual([alexaScopes.tools]);
        throw new AccessDeniedError(403, "insufficient_scope");
      },
    };
    const response = await request(createHttpApp(
      createDemoStore(fixedNow),
      undefined,
      { accessAuthorizer: authorizer },
    ))
      .post("/mcp")
      .set("authorization", "Bearer signed-token")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "show_today", arguments: {} },
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "insufficient_scope" });
  });

  it("does not serve the family simulator on the production OAuth surface", async () => {
    const app = createHttpApp(
      createDemoStore(fixedNow),
      undefined,
      { serveSimulator: false },
    );
    const page = await request(app).get("/");
    const familyData = await request(app).get("/api/today");
    expect(page.status).toBe(404);
    expect(familyData.status).toBe(404);
  });
});
