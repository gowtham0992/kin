import { describe, expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import type { EscalationRecord, EscalationStatus } from "../src/escalation.js";

const instant = "2026-09-02T16:00:00.000Z";
const statuses: EscalationStatus[] = ["blocked", "failed", "queued", "sending", "receipt_pending", "sent"];
const record = (id = "old-failure", status: EscalationStatus = "failed") => ({
  PK: "CIRCLE#family-1", SK: `ESCALATION#2026-09-02T15:00:00.000Z#${id}`, entityType: "Escalation",
  id, taskId: id, taskTitle: "Synthetic check-in", dueAt: "2026-09-02T15:00:00.000Z", createdAt: instant, updatedAt: instant,
  recipientMemberId: "theo", recipientMemberName: "Theo", status, attemptCount: 1,
  attemptId: null, leaseUntil: null, providerMessageId: null, lastErrorCode: "SyntheticFailure",
} satisfies EscalationRecord & { PK: string; SK: string; entityType: string });

describe("delivery health independent of the care calendar", () => {
  it("keeps all delivery problems after date rollover, including acknowledged failures, but excludes sent receipts", async () => {
    let now = new Date(instant);
    const tasks: CareTask[] = statuses.map(status => ({ id: status, title: status, dueAt: "2026-09-02T15:00:00.000Z",
      state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null }));
    const recipient = { memberId: "theo", memberName: "Theo", startsAt: "2026-09-02T00:00:00.000Z", endsAt: "2026-09-03T00:00:00.000Z" };
    const store = new InMemoryCareStore(tasks, () => now, recipient);
    for (const task of tasks) {
      const event = { id: `missed_${task.id}_${task.dueAt}`, taskId: task.id, taskTitle: task.title, dueAt: task.dueAt,
        createdAt: instant, recipient };
      const queued = await store.queueEscalation(task.id === "blocked"
        ? { taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, reason: "no_active_duty_assignment" } : event);
      if (!queued) throw new Error("Synthetic task should be current");
      if (["blocked", "queued"].includes(task.id)) continue;
      const claimed = await store.claimEscalation({ event, attemptId: task.id, now, leaseSeconds: 60 });
      if (!claimed) throw new Error("Synthetic delivery should be claimed");
      if (task.id === "failed") {
        await store.failEscalation({ record: claimed, attemptId: task.id, errorCode: "SyntheticFailure", failedAt: now });
        await store.acknowledgeEscalation({ id: claimed.id, memberId: "maya", name: "Maya" });
      } else if (task.id === "sent") await store.completeEscalation({ record: claimed, attemptId: task.id, providerMessageId: "accepted", completedAt: now });
      else if (task.id === "receipt_pending") await store.deferEscalationReceipt({ record: claimed, attemptId: task.id, providerMessageId: "accepted", completedAt: now });
    }
    now = new Date("2026-09-06T16:00:00.000Z");
    expect((await store.escalationSnapshot(now)).escalations).toEqual([]);
    const health = await store.deliveryHealthSnapshot();
    expect(health.map(item => item.status).sort()).toEqual(statuses.filter(status => status !== "sent").sort());
    expect(health.find(item => item.status === "failed")?.acknowledgedBy).toBe("Maya");
    expect(health.every(item => !("providerMessageId" in item) && !("taskTitle" in item))).toBe(true);
  });

  it("continues after an empty filtered page and uses a circle-scoped no-date query", async () => {
    const cursor = { PK: "CIRCLE#family-1", SK: "ESCALATION#2026-09-02T14:00:00.000Z#sent" };
    const commands: QueryCommand[] = [];
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", now: () => new Date("2026-09-06T16:00:00.000Z"), client: {
      send: async command => {
        expect(command).toBeInstanceOf(QueryCommand); commands.push(command as QueryCommand);
        return commands.length === 1 ? { Items: [], LastEvaluatedKey: cursor } : {
          Items: [{ ...record(), acknowledgment: { memberId: "maya", name: "Maya", at: instant } }],
        };
      },
    } });
    const health = await repository.deliveryHealthSnapshot();
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ id: "old-failure", status: "failed", acknowledgedBy: "Maya" });
    expect(commands).toHaveLength(2);
    expect(commands[0]!.input).toMatchObject({ KeyConditionExpression: "PK = :pk AND begins_with(SK, :escalation)",
      ExpressionAttributeValues: { ":pk": "CIRCLE#family-1", ":escalation": "ESCALATION#", ":pending": "receipt_pending" },
      Limit: 100, ConsistentRead: true });
    expect(commands[0]!.input).not.toHaveProperty("ExclusiveStartKey");
    expect(commands[0]!.input.FilterExpression).toContain("#status IN");
    expect(commands[0]!.input.FilterExpression).not.toContain("acknowledg");
    expect(commands[1]!.input.ExclusiveStartKey).toEqual(cursor);
    expect(JSON.stringify(health)).not.toContain("providerMessageId");
  });

  it.each([500, 501])("bounds the in-memory delivery health view at %s problems", async count => {
    const tasks: CareTask[] = Array.from({ length: count }, (_, index) => ({ id: `task-${index}`, title: "Synthetic check-in",
      dueAt: "2026-09-02T15:00:00.000Z", state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null }));
    const store = new InMemoryCareStore(tasks, () => new Date(instant));
    for (const task of tasks) await store.queueEscalation({ taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, reason: "no_active_duty_assignment" });
    if (count > 500) await expect(store.deliveryHealthSnapshot().then(items => items.length)).rejects.toThrow("too large");
    else expect(await store.deliveryHealthSnapshot()).toHaveLength(500);
  });

  it("fails closed after ten pages even if every filtered page was empty", async () => {
    let calls = 0;
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", client: {
      send: async () => ({ Items: [], LastEvaluatedKey: { PK: "CIRCLE#family-1", SK: `ESCALATION#cursor-${++calls}` } }),
    } });
    await expect(repository.deliveryHealthSnapshot().then(items => items.length)).rejects.toThrow(/incomplete|too large/);
    expect(calls).toBe(10);
  });

  it("accepts a complete tenth page instead of rejecting only because it reached the page count", async () => {
    let calls = 0;
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", client: {
      send: async () => ++calls < 10 ? { Items: [], LastEvaluatedKey: { PK: "CIRCLE#family-1", SK: `ESCALATION#cursor-${calls}` } } : { Items: [record()] },
    } });
    expect(await repository.deliveryHealthSnapshot()).toHaveLength(1);
    expect(calls).toBe(10);
  });

  it("fails closed above 500 returned problems without returning a partial healthy view", async () => {
    let calls = 0;
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", client: {
      send: async () => { calls++; return { Items: Array.from({ length: calls === 6 ? 1 : 100 }, (_, index) => record(`failure-${calls}-${index}`)),
        ...(calls < 6 ? { LastEvaluatedKey: { PK: "CIRCLE#family-1", SK: `ESCALATION#cursor-${calls}` } } : {}) }; },
    } });
    await expect(repository.deliveryHealthSnapshot().then(items => items.length)).rejects.toThrow(/incomplete|too large/);
    expect(calls).toBe(6);
  });
});
