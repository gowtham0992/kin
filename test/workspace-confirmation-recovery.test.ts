import request from "supertest";
import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { AccessDeniedError } from "../src/auth.js";
import { taskReview } from "../src/task-review.js";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);

const now = new Date("2026-09-26T15:00:00.000Z");
const task: CareTask = { id: "water", title: "Synthetic water", dueAt: now.toISOString(), state: "scheduled",
  lastResponse: null, confirmedAt: null, confirmedBy: null };

describe("committed confirmation recovery through real HTTP authorization", () => {
  it.each([401, 403])("retains the committed request through a later %s, then resolves its original receipt", async status => {
    const store = new InMemoryCareStore([task], () => now);
    let denied = false, loseResponse = true;
    const app = createHttpApp(store, undefined, {
      accessAuthorizer: { async authorize() {
        if (denied && status === 401) throw new AccessDeniedError(401, "invalid_token");
        return { subject: "synthetic", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) };
      } },
      familyAccess: { circleId: "family", directory: { async find() {
        return { circleId: "family", memberId: "maya", name: "Maya", role: "caregiver", status: denied && status === 403 ? "revoked" : "active" };
      } } },
    });
    const bodies: string[] = [];
    const client = createWorkspaceClient({ newRequestId: () => "committed-reply-001", request: async (url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      const response = await request(app).post(url).set("authorization", "Bearer synthetic").send(JSON.parse(init.body as string));
      if (response.ok && loseResponse) { loseResponse = false; throw new Error("Committed response lost"); }
      return { ok: response.ok, status: response.status, json: async () => response.body };
    } });
    await expect(client.confirm({ taskId: task.id, response: "done", actor: "Maya", expected: taskReview(task) })).rejects.toThrow("Committed response lost");
    const committed = await store.today();
    expect(committed.tasks[0]?.state).toBe("done");
    const pending = client.pending;
    denied = true;
    await expect(client.retry()).rejects.toMatchObject({ status, outcomeUnknown: true, definitiveRejection: false });
    expect(client.pending).toEqual(pending);
    denied = false;
    await expect(client.retry()).resolves.toMatchObject({ replayed: true, confirmation: { requestId: "committed-reply-001" } });
    expect(client.pending).toBeNull();
    expect(await store.today()).toEqual(committed);
    expect(bodies).toHaveLength(3); expect(new Set(bodies).size).toBe(1);
    client.reset(); expect(client.pending).toBeNull();
  });
});
