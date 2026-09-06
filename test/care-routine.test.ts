import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { InMemoryCareStore } from "../src/domain.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { routineTasks } from "../src/care-plan.js";
import { createHttpApp } from "../src/http.js";
const now = () => new Date("2026-10-30T08:00:00Z");
const input = { id: "routine-test", title: "Call together", timeZone: "America/Denver",
  dueAts: ["2026-10-31T15:00:00.000Z", "2026-11-01T16:00:00.000Z", "2026-11-02T16:00:00.000Z"] };
describe("finite daily routines", () => {
  it("keeps local time across a daylight-saving change and creates separate task identities", () => {
    const tasks = routineTasks(input, now());
    expect(tasks.map(task => task.dueAt)).toEqual(input.dueAts);
    expect(tasks.map(task => task.id)).toEqual(["routine-test-1", "routine-test-2", "routine-test-3"]);
  });
  it.each([
    { ...input, dueAts: [input.dueAts[0]!, input.dueAts[0]!] },
    { ...input, dueAts: [input.dueAts[0]!, "2026-11-01T15:00:00.000Z"] },
    { ...input, dueAts: [input.dueAts[0]!, input.dueAts[2]!] },
    { ...input, dueAts: [input.dueAts[0]!] },
    { ...input, dueAts: Array(15).fill(input.dueAts[0]!) },
    { ...input, timeZone: "Not/AZone" },
    { ...input, dueAts: ["2026-11-30T16:00:00.000Z", "2026-12-01T16:00:00.000Z"] },
  ])("rejects malformed or out-of-window routines without partial writes: %j", async invalid => {
    const store = new InMemoryCareStore([], now);
    await expect(store.scheduleRoutine(invalid)).rejects.toThrow();
    expect((await store.activityBetween({ startDate: "2026-10-30", endDate: "2026-11-29" })).tasks).toHaveLength(0);
  });
  it("replays a saved routine after its start time and rejects changed input", async () => {
    let clock = now(); const store = new InMemoryCareStore([], () => clock);
    const first = await store.scheduleRoutine(input);
    clock = new Date("2026-11-02T17:00:00Z");
    expect(await store.scheduleRoutine(input)).toEqual(first);
    await expect(store.scheduleRoutine({ ...input, title: "Different" })).rejects.toThrow("different task");
    expect((await store.activityBetween({ startDate: "2026-10-30", endDate: "2026-11-03" })).tasks).toHaveLength(3);
  });
  it("saves all occurrences and the receipt in one conditional transaction, recovering a concurrent replay", async () => {
    let receipt: unknown;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: receipt };
      if (command instanceof TransactWriteCommand) {
        receipt = command.input.TransactItems!.at(-1)!.Put!.Item;
        throw Object.assign(new Error("concurrent"), { name: "TransactionCanceledException" });
      }
      throw new Error("Unexpected command");
    });
    const store = new DynamoCareRepository({ client: { send }, tableName: "test", circleId: "test", now });
    expect(await store.scheduleRoutine(input)).toHaveLength(3);
    const tx = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)![0] as TransactWriteCommand;
    expect(tx.input.TransactItems).toHaveLength(4);
    expect(tx.input.TransactItems!.every(item => item.Put?.ConditionExpression === "attribute_not_exists(PK)")).toBe(true);
    expect(tx.input.TransactItems!.slice(0, 3).map(item => item.Put!.Item!.dueAt)).toEqual(input.dueAts);
  });
  it("requires caregiver membership, rejects extra fields, and returns a matching replay receipt", async () => {
    const store = new InMemoryCareStore([], now);
    const find = vi.fn(async () => ({ circleId: "test", memberId: "maya", name: "Maya", role: "viewer", status: "active" }));
    const app = createHttpApp(store, undefined, { familyAccess: { circleId: "test", directory: { find } }, accessAuthorizer: {
      async authorize() { return { subject: "test", scopes: new Set(["mcp:tools"]), claims: { iss: "https://test.example" } }; },
    } });
    const { id, ...rest } = input; const body = { ...rest, requestId: id };
    await request(app).post("/api/routines").send(body).expect(403);
    find.mockResolvedValue({ circleId: "test", memberId: "maya", name: "Maya", role: "caregiver", status: "active" });
    await request(app).post("/api/routines").send({ ...body, canInvite: true }).expect(400);
    const first = await request(app).post("/api/routines").send(body).expect(200);
    const replay = await request(app).post("/api/routines").send(body).expect(200);
    expect(replay.body).toEqual(first.body); expect(first.body.tasks).toHaveLength(3);
    await request(app).post("/api/routines").send({ ...body, title: "Different" }).expect(409);
    expect((await request(app).get("/api/plan").expect(200)).body.tasks).toHaveLength(3);
  });
});
