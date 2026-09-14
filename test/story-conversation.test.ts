import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStoryApp } from "../src/local-story.js";
import { createConfiguredApp } from "../src/runtime.js";
import type { IntentGenerator } from "../src/demo-conversation.js";
import { createMcpCareClient } from "../simulator/mcp-client.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function fixture(intentGenerator?: IntentGenerator) {
  const server = createLocalStoryApp({ intentGenerator }).listen(0, "127.0.0.1"); servers.push(server);
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { http: request(origin), origin, parent: createMcpCareClient(new URL("/mcp", origin)) };
}
const path = "/demo/story/conversation";
const report = { message: "I finished my glass of water", allowModel: true };
const done = { action: "confirm", taskId: "morning-water", response: "done" };

describe("isolated story interpretation", () => {
  it("reviews an ordinary first-person reply locally and saves only after a separate MCP confirmation", async () => {
    const generate = vi.fn(async () => done);
    const { http, parent } = await fixture(generate);
    const proposed = await http.post(path).send({ message: "I already had my water." }).expect(200);
    expect(proposed.body).toMatchObject({ ...done, mode: "limited", modelRequests: 0,
      task: { title: "Drink a glass of water" }, expected: { state: "scheduled", lastResponse: null } });
    expect(generate).not.toHaveBeenCalled();
    expect(await parent.today()).toMatchObject({ summary: { completed: 0 } });
    const saved = await parent.confirm({ taskId: proposed.body.taskId, response: proposed.body.response,
      expected: proposed.body.expected, actor: "Evelyn", requestId: "story-simple-reviewed-save" });
    expect(saved).toMatchObject({ task: { state: "done", confirmedBy: "Evelyn" } });
    expect(await parent.today()).toMatchObject({ summary: { completed: 1 } });
  });

  it("keeps local interpretation free of model calls unless the request opts in", async () => {
    const generate = vi.fn(async () => done);
    const { http, parent } = await fixture(generate);
    expect((await http.get("/demo/story")).body.conversation).toEqual({ mode: "bedrock", modelLimit: 20, modelRequests: 0 });
    const proposal = await http.post(path).send({ message: "Not yet: Drink a glass of water" }).expect(200);
    expect(proposal.body).toMatchObject({ action: "confirm", response: "not_yet", mode: "limited", modelRequests: 0 });
    expect(proposal.body.contextToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(generate).not.toHaveBeenCalled();
    expect((await parent.today()).tasks).toMatchObject([{ lastResponse: null, state: "scheduled" }]);
  });

  it("runs opted-in interpretation as a proposal, and saves only through a separately reviewed MCP request", async () => {
    const generate = vi.fn(async () => done);
    const { http, parent } = await fixture(generate);
    const proposed = await http.post(path).send(report).expect(200);
    expect(proposed.body).toMatchObject({ ...done, mode: "bedrock", modelRequests: 1,
      task: { title: "Drink a glass of water" }, expected: { state: "scheduled", lastResponse: null } });
    expect(generate.mock.calls).toEqual([[report.message, [{ id: "morning-water", title: "Drink a glass of water" }], undefined]]);
    expect(await parent.today()).toMatchObject({ summary: { completed: 0 } });
    const saved = await parent.confirm({ taskId: proposed.body.taskId, response: proposed.body.response,
      expected: proposed.body.expected, actor: "Evelyn", requestId: "story-model-reviewed-save" });
    expect(saved).toMatchObject({ task: { state: "done", confirmedBy: "Evelyn" } });
    expect(await parent.today()).toMatchObject({ summary: { completed: 1 } });
  });

  it("requires an explicitly configured model and leaves the default story independent of AWS", async () => {
    const { http } = await fixture();
    expect((await http.get("/demo/story")).body.conversation).toEqual({ mode: "limited", modelLimit: 20, modelRequests: 0 });
    await http.post(path).send(report).expect(409, { error: "story_model_unavailable", modelRequests: 0 });
    const response = await http.post(path).send({ message: "Show today" }).expect(200);
    expect(response.body).toMatchObject({ action: "today", mode: "limited", modelRequests: 0 });
  });

  it("keeps reviewed follow-up context bounded to the same unchanged task", async () => {
    const generate = vi.fn(async (_message, _tasks, focusedTaskId) => focusedTaskId ? done : { action: "clarify" });
    const { http, parent } = await fixture(generate);
    const first = await http.post(path).send({ message: "Not yet: Drink a glass of water" }).expect(200);
    const followUp = await http.post(path).send({ message: "I did it", contextToken: first.body.contextToken }).expect(200);
    expect(followUp.body).toMatchObject({ action: "confirm", response: "done", mode: "limited" });
    await parent.confirm({ taskId: first.body.taskId, response: "not_yet", expected: first.body.expected,
      actor: "Evelyn", requestId: "story-context-task-change" });
    const stale = await http.post(path).send({ message: "I did it", contextToken: first.body.contextToken, allowModel: true }).expect(200);
    expect(stale.body).toMatchObject({ action: "clarify", mode: "bedrock" });
    expect(generate.mock.calls[0]?.[2]).toBeUndefined();
    expect(await parent.today()).toMatchObject({ summary: { completed: 0 } });
  });

  it("limits model attempts across all clients while preserving local commands after exhaustion", async () => {
    const generate = vi.fn(async () => ({ action: "today" }));
    const { http } = await fixture(generate);
    for (let index = 1; index <= 20; index++) {
      expect((await http.post(path).send(report).expect(200)).body.modelRequests).toBe(index);
    }
    await http.post(path).send(report).expect(429, { error: "story_model_limit", modelRequests: 20 });
    expect(generate).toHaveBeenCalledTimes(20);
    expect((await http.post(path).send({ message: "Show today" }).expect(200)).body).toMatchObject({ action: "today", mode: "limited", modelRequests: 20 });
  });

  it("rejects concurrent interpretations without billing or queueing a duplicate", async () => {
    let release!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const generate = vi.fn(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const { http } = await fixture(generate);
    const first = http.post(path).send(report).then(response => response);
    await started;
    try {
      await http.post(path).send(report).expect(429, { error: "story_conversation_busy", modelRequests: 1 });
      await http.post(path).send({ message: "Show today" }).expect(200);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { release({ action: "today" }); }
    expect((await first).status).toBe(200);
    await http.post(path).send({ message: "Show today" }).expect(200);
  });

  it("ends a stalled model response without starting overlapping paid work or blocking local commands", async () => {
    let release!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const generate = vi.fn(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    const { http, parent } = await fixture(generate);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = http.post(path).send(report).then(response => response);
    await started;
    await vi.advanceTimersByTimeAsync(5001);
    const timedOut = await first;
    vi.useRealTimers();
    expect(timedOut.status).toBe(503);
    expect(timedOut.body).toEqual({ error: "story_conversation_unavailable", modelRequests: 1 });
    try {
      await http.post(path).send(report).expect(429, { error: "story_conversation_busy", modelRequests: 1 });
      expect((await http.post(path).send({ message: "Show today" }).expect(200)).body).toMatchObject({ action: "today", mode: "limited" });
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { release(done); }
    expect(await parent.today()).toMatchObject({ summary: { completed: 0 } });
    const state = (await http.get("/demo/story")).body;
    expect(state.conversation.modelRequests).toBe(1);
    expect(timedOut.body).not.toHaveProperty("contextToken");
  });

  it.each([
    { name: "provider failure", generate: async () => { throw new Error("private provider detail"); } },
    { name: "invalid model action", generate: async () => ({ action: "send_sms", phone: "private detail" }) },
  ])("counts failed attempts, returns a quiet error and unlocks after $name", async ({ generate }) => {
    const { http, parent } = await fixture(generate);
    await http.post(path).send(report).expect(503, { error: "story_conversation_unavailable", modelRequests: 1 });
    expect(await parent.today()).toMatchObject({ summary: { completed: 0 } });
    expect((await http.post(path).send({ message: "Show today" }).expect(200)).body.action).toBe("today");
  });

  it.each([
    { message: "", allowModel: true }, { message: "x".repeat(801), allowModel: true },
    { ...report, allowModel: "true" }, { ...report, role: "caregiver" },
    { ...report, contextToken: "forged" }, { ...report, modelId: "unapproved-model" },
  ])("rejects invalid input before any model invocation %j", async body => {
    const generate = vi.fn(async () => done);
    const { http } = await fixture(generate);
    await http.post(path).send(body).expect(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it("supports bounded Unicode text and rejects oversized, non-JSON and hostile-origin input before interpreting", async () => {
    const generate = vi.fn(async () => ({ action: "clarify" }));
    const { http } = await fixture(generate);
    await http.post(path).send({ message: "界".repeat(800), allowModel: true }).expect(200);
    await http.post(path).send({ message: "x".repeat(5000), allowModel: true }).expect(413);
    await http.post(path).type("form").send(report).expect(415);
    await http.post(path).set("origin", "https://attacker.example").send(report).expect(403);
    await http.post(path).set("sec-fetch-site", "cross-site").send(report).expect(403);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not make story model controls available on the configured app", async () => {
    await request(createConfiguredApp({})).post(path).send(report).expect(404);
  });
});
