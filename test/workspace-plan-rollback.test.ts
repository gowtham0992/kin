import request from "supertest";
import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);

const now = new Date("2026-09-26T15:00:00.000Z");
const task: CareTask = { id: "test-call", title: "Synthetic call", dueAt: "2026-09-27T15:00:00.000Z",
  state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };

// Real client, HTTP validation/authorization and memory repository. Only the
// transport loses a committed response; feature gates then change between requests.
function fixture() {
  const store = new InMemoryCareStore([task], () => now);
  const options = { rescheduleEnabled: true,
    accessAuthorizer: { async authorize() { return { subject: "synthetic", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) }; } },
    familyAccess: { circleId: "family", directory: { async find() { return { circleId: "family", memberId: "caregiver", name: "Test caregiver", role: "caregiver", status: "active" }; } } } };
  const app = createHttpApp(store, undefined, options);
  const bodies: string[] = [];
  let loseResponse = true;
  const client = createWorkspaceClient({ newRequestId: () => "rollback-review-1", request: async (url: string, init: { body?: string } = {}) => {
    const call = init.body ? request(app).post(url).send(JSON.parse(init.body)) : request(app).get(url);
    if (init.body) bodies.push(init.body);
    const response = await call.set("authorization", "Bearer synthetic");
    if (init.body && response.ok && loseResponse) { loseResponse = false; throw new Error("Committed response lost"); }
    return { ok: response.ok, status: response.status, json: async () => response.body };
  } });
  return { store, client, bodies, gate(enabled: boolean) {
    options.rescheduleEnabled = enabled;
    Object.defineProperty(store, "planPauseEnabled", { value: enabled, configurable: true });
  }, tasks: async () => (await store.activityBetween({ startDate: "2026-09-26", endDate: "2026-10-04" })).tasks };
}

describe("plan saves across a feature rollback", () => {
  it.each(["reschedule", "pause"] as const)("keeps a committed %s unresolved when rollback prevents receipt lookup, then resolves only the original receipt", async kind => {
    const f = fixture();
    const input = { taskId: task.id, action: "reschedule", dueAt: "2026-09-28T15:00:00.000Z",
      expected: { title: task.title, dueAt: task.dueAt }, confirm: true };
    const save = kind === "reschedule" ? () => f.client.changeTask(input)
      : async () => f.client.pausePlan((await f.client.proposePlanPause()).proposal);
    await expect(save()).rejects.toThrow("Committed response lost");
    const committed = await f.tasks();
    expect(committed.find(t => t.id === task.id)?.state).toBe("cancelled");
    expect(committed).toHaveLength(kind === "reschedule" ? 2 : 1);
    const pending = structuredClone(f.client.pending);
    f.gate(false);
    await expect(f.client.retry()).rejects.toMatchObject({ status: kind === "reschedule" ? 422 : 404,
      outcomeUnknown: true, definitiveRejection: false });
    expect(f.client.pending).toEqual(pending);
    await expect(f.client.changeTask(input)).rejects.toThrow(/pending/);
    expect(await f.tasks()).toEqual(committed);
    f.gate(true);
    await f.client.retry();
    expect(f.client.pending).toBeNull();
    expect(f.bodies).toHaveLength(3);
    expect(new Set(f.bodies).size).toBe(1);
    expect(await f.tasks()).toEqual(committed);
  });
});
