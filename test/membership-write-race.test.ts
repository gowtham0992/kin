import { describe, expect, it } from "vitest";
import request from "supertest";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { taskReview } from "../src/task-review.js";
import { authorizeCareWrite } from "../src/care-write-authorization.js";
import { confirmWithReceipt } from "../src/confirmation.js";
import { FamilyAccessDeniedError, type Membership } from "../src/membership.js";

describe("membership at the care-write boundary", () => {
  it.each(["receipt", "snapshot"])("does not return protected data after revocation during %s loading", async phase => {
    const store = createDemoStore(() => new Date("2026-09-11T08:00:00Z"));
    const task = (await store.today()).tasks[0]!;
    const member: Membership = { circleId: "synthetic", memberId: "parent", name: "Parent", role: "care_recipient", status: "active" };
    let active = true;
    const authorization = authorizeCareWrite({ circleId: member.circleId, directory: { async find() { return active ? member : null; } } },
      { subject: "parent", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) }, member, "confirm");
    const input = { taskId: task.id, response: "done" as const, actor: member.name, requestId: "saved-earlier", expected: taskReview(task) };
    await confirmWithReceipt(store, input, member, authorization);
    if (phase === "receipt") {
      const confirm = store.confirm.bind(store);
      store.confirm = async (...args: Parameters<typeof confirm>) => { const receipt = await confirm(...args); active = false; return receipt; };
    } else {
      const today = store.today.bind(store);
      store.today = async () => { const snapshot = await today(); active = false; return snapshot; };
    }
    await expect(confirmWithReceipt(store, input, member, authorization)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    // The earlier authorized save remains a fact; response denial is not a rollback.
  });
  it.each(["REST", "MCP"])("rejects an admitted %s confirmation after membership is revoked", async surface => {
    const store = createDemoStore(() => new Date("2026-09-11T08:00:00Z"));
    const task = (await store.today()).tasks[0]!;
    const member = { circleId: "synthetic-circle", memberId: "synthetic-member", name: "Synthetic parent", role: "care_recipient", status: "active" };
    let active = true;
    let arrive!: () => void, resume!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const confirm = store.confirm.bind(store);
    // Forward the complete repository contract; this barrier is before its mutation.
    store.confirm = async (...args: Parameters<typeof confirm>) => { arrive(); await paused; return confirm(...args); };
    const app = createHttpApp(store, undefined, {
      accessAuthorizer: { async authorize() { return { subject: "synthetic-subject", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools", "mcp:resources"]) }; } },
      familyAccess: { circleId: member.circleId, directory: { async find() { return active ? { ...member } : null; } } },
    });
    const input = { response: "done", actor: "Untrusted name", requestId: "revocation-request", expected: taskReview(task) };
    const pending = request(app).post(surface === "REST" ? `/api/tasks/${task.id}/confirm` : "/mcp")
      .set("authorization", "Bearer synthetic").set("accept", "application/json, text/event-stream")
      .send(surface === "REST" ? input : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "confirm_care_task", arguments: { ...input, taskId: task.id } } })
      .then(response => response);
    await arrived;
    active = false;
    await request(app).get("/api/today").set("authorization", "Bearer synthetic").expect(403);
    resume();
    const response = await pending;
    if (surface === "REST") expect(response.status).toBe(403);
    else {
      const message = response.text.split("\n").find(line => line.startsWith("data: "));
      const body = message ? JSON.parse(message.slice(6)) : response.body;
      expect(body.result).toMatchObject({ isError: true });
    }
    expect((await store.today()).tasks.find(value => value.id === task.id)?.state).toBe("scheduled");
  });
});
