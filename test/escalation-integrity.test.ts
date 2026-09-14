import { describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createDemoStore, InMemoryCareStore } from "../src/domain.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { planMissedTaskEscalations, runEscalationSweep } from "../src/escalation.js";

const instant = "2026-09-02T16:00:00.000Z";

describe("escalation integrity across stale plans and partial failures", () => {
  it.each(["done", "not_yet"] as const)("does not insert an alert after %s invalidates the captured plan", async response => {
    const now = new Date(instant);
    const store = createDemoStore(() => now);
    const snapshot = await store.today();
    await store.confirm({ taskId: "morning-water", response, actor: "Evelyn", requestId: `fresh-${response}` });
    const publisher = { publish: vi.fn(async () => ({ messageId: "must-not-send" })) };

    expect(await runEscalationSweep({ snapshot, store, publisher, now, attemptId: "stale-plan" })).toEqual({ records: [] });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect((await store.today()).escalations).toEqual([]);
  });

  it.each(["done", "not_yet"] as const)("does not recover a blocked alert after %s invalidates the captured plan", async response => {
    const now = new Date(instant);
    const tasks = (await createDemoStore(() => now).today()).tasks;
    const store = new InMemoryCareStore(tasks, () => now);
    const publisher = { publish: vi.fn(async () => ({ messageId: "must-not-send" })) };
    await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "blocked" });
    await store.assignDuty({ date: "2026-09-02", memberId: "maya" });
    const snapshot = await store.today();
    await store.confirm({ taskId: "morning-water", response, actor: "Evelyn", requestId: `fresh-${response}` });

    expect(await runEscalationSweep({ snapshot, store, publisher, now, attemptId: "stale-recovery" })).toEqual({ records: [] });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect((await store.today()).escalations[0]?.status).toBe("blocked");
  });

  it("retains known provider acceptance after receipt persistence fails and never republishes it", async () => {
    let now = new Date(instant);
    const store = createDemoStore(() => now);
    vi.spyOn(store, "completeEscalation").mockRejectedValueOnce(new Error("receipt unavailable"));
    const failed = vi.spyOn(store, "failEscalation");
    const publisher = { publish: vi.fn(async () => ({ messageId: "accepted-once" })) };

    const first = await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "first" });
    now = new Date("2026-09-02T16:02:00.000Z");
    const second = await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "second" });

    expect(first.records[0]).toMatchObject({ status: "receipt_pending", providerMessageId: "accepted-once", sentAt: instant });
    expect(second.records[0]).toMatchObject({ status: "receipt_pending", providerMessageId: "accepted-once", attemptCount: 1 });
    expect(failed).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it("does not reclaim an expired sending lease when provider acceptance is unknown", async () => {
    const now = new Date(instant);
    const store = createDemoStore(() => now);
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now }).events[0]!;
    await store.queueEscalation(event);
    await store.claimEscalation({ event, now, attemptId: "lost-worker", leaseSeconds: 60 });
    expect(await store.claimEscalation({ event, now: new Date("2026-09-02T16:02:00.000Z"), attemptId: "retry", leaseSeconds: 60 })).toBeNull();
  });

  it("surfaces failure of both receipt writes and still refuses a later blind retry", async () => {
    let now = new Date(instant);
    const store = createDemoStore(() => now);
    vi.spyOn(store, "completeEscalation").mockRejectedValueOnce(new Error("receipt unavailable"));
    vi.spyOn(store, "deferEscalationReceipt").mockRejectedValueOnce(new Error("fallback unavailable"));
    const publisher = { publish: vi.fn(async () => ({ messageId: "accepted-but-unsaved" })) };
    await expect(runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "first" })).rejects.toThrow("fallback unavailable");
    now = new Date("2026-09-02T16:02:00.000Z");
    await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "retry" });
    expect((await store.today()).escalations[0]?.status).toBe("sending");
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it("recovers a receipt that committed before its response was lost without downgrading it", async () => {
    const now = new Date(instant);
    const store = createDemoStore(() => now);
    const complete = store.completeEscalation.bind(store);
    vi.spyOn(store, "completeEscalation").mockImplementationOnce(async input => { await complete(input); throw new Error("response lost"); });
    const publisher = { publish: vi.fn(async () => ({ messageId: "already-durable" })) };
    const result = await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "first" });
    expect(result.records[0]).toMatchObject({ status: "sent", providerMessageId: "already-durable", sentAt: instant });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });
});

describe("Dynamo complete care windows", () => {
  it.each((["today", "escalationSnapshot"] as const).flatMap(method => ["TASK#", "DUTY#", "ESCALATION#"].map(prefix => ({ method, prefix }))))(
    "$method rejects a partial $prefix result instead of claiming completeness", async ({ method, prefix }) => {
      const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", now: () => new Date(instant), client: {
        send: async command => {
          expect(command).toBeInstanceOf(QueryCommand);
          const start = (command as QueryCommand).input.ExpressionAttributeValues?.[":start"] as string;
          return start.startsWith(prefix) ? { Items: [], LastEvaluatedKey: { PK: "CIRCLE#family-1", SK: `${prefix}cursor` } } : { Items: [] };
        },
      } });
      await expect(method === "today" ? repository.today() : repository.escalationSnapshot(new Date(instant))).rejects.toThrow(/too large|incomplete/);
  });

  it.each(["today", "escalationSnapshot"] as const)("%s bounds all reads and rejects more than 500 returned items", async method => {
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", now: () => new Date(instant), client: {
      send: async command => {
        expect(command).toBeInstanceOf(QueryCommand);
        expect((command as QueryCommand).input.Limit).toBe(501);
        return { Items: Array.from({ length: 501 }, () => ({})) };
      },
    } });
    await expect(method === "today" ? repository.today() : repository.escalationSnapshot(new Date(instant))).rejects.toThrow("too large");
  });

  it.each(["TransactionConflict", "ThrottlingError", "ValidationError"])("does not hide %s as a stale plan", async code => {
    const store = createDemoStore(() => new Date(instant));
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now: new Date(instant) }).events[0]!;
    const error = Object.assign(new Error(code), { name: "TransactionCanceledException", CancellationReasons: [{ Code: code }, { Code: "None" }] });
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", now: () => new Date(instant), client: {
      send: async () => { throw error; },
    } });
    await expect(repository.queueEscalation(event)).rejects.toBe(error);
  });
});

describe("Dynamo task-bound outbox insertion", () => {
  it.each(["done", "not_yet"] as const)("refuses a %s change at the transaction boundary, even after a fresh read", async response => {
    const now = new Date(instant);
    const snapshot = await createDemoStore(() => now).today();
    const event = planMissedTaskEscalations({ snapshot, now }).events[0]!;
    let alertInserted = false;
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", now: () => now, client: {
      send: async command => {
        if (command instanceof GetCommand) return {};
        if (command instanceof TransactWriteCommand) {
          const check = command.input.TransactItems?.[0]?.ConditionCheck;
          expect(check?.Key).toEqual({ PK: "CIRCLE#family-1", SK: `TASK#${event.dueAt}#${event.taskId}` });
          expect(check?.ConditionExpression).toContain("#state = :scheduled");
          expect(check?.ConditionExpression).toContain("lastResponse");
          expect(check?.ConditionExpression).toContain("confirmedAt");
          expect(check?.ExpressionAttributeValues).toMatchObject({ ":scheduled": "scheduled", ":title": event.taskTitle, ":response": null, ":responseAt": null });
          // A response wins after the worker's snapshot but before the atomic write.
          throw Object.assign(new Error(`Task changed to ${response}`), { name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] });
        }
        if (command instanceof PutCommand) alertInserted = true;
        return {};
      },
    } });
    expect(await repository.queueEscalation(event)).toBeNull();
    expect(alertInserted).toBe(false);
  });

  it("binds a Not yet plan to the exact persisted response timestamp", async () => {
    let now = new Date(instant);
    const store = createDemoStore(() => now);
    await store.confirm({ taskId: "morning-water", response: "not_yet", actor: "Evelyn", requestId: "reply" });
    now = new Date("2026-09-02T16:30:00.000Z");
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now }).events[0]!;
    const commands: unknown[] = [];
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", now: () => now, client: {
      send: async command => { commands.push(command); return {}; },
    } });
    await repository.queueEscalation(event);
    const transaction = commands[0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems?.[0]?.ConditionCheck?.ExpressionAttributeValues).toMatchObject({ ":response": "not_yet", ":responseAt": instant });
  });

  it("does not recover a blocked alert when the response changes during the recovery transaction", async () => {
    const now = new Date(instant);
    const store = createDemoStore(() => now);
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now }).events[0]!;
    const queued = await store.queueEscalation({ ...event, reason: "no_active_duty_assignment" });
    if (!queued) throw new Error("Test task must be current");
    const blocked = { ...queued.record, status: "blocked", recipientMemberId: null, recipientMemberName: null,
      PK: "CIRCLE#family-1", SK: `ESCALATION#${event.dueAt}#${event.taskId}`, entityType: "Escalation" };
    let writes = 0;
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", now: () => now, client: {
      send: async command => {
        if (command instanceof GetCommand) return { Item: blocked };
        expect(command).toBeInstanceOf(TransactWriteCommand);
        writes += 1;
        if (writes === 1) throw Object.assign(new Error("Outbox exists"), { name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] });
        const transaction = command as TransactWriteCommand;
        expect(transaction.input.TransactItems?.[0]?.ConditionCheck?.Key?.SK).toBe(`TASK#${event.dueAt}#${event.taskId}`);
        expect(transaction.input.TransactItems?.[1]?.Update).toBeDefined();
        throw Object.assign(new Error("New reply wins recovery"), { name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] });
      },
    } });
    expect(await repository.queueEscalation(event)).toBeNull();
    expect(writes).toBe(2);
  });

  it("persists a known accepted receipt as non-retryable and recovers a lost successful write", async () => {
    const store = createDemoStore(() => new Date(instant));
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now: new Date(instant) }).events[0]!;
    await store.queueEscalation(event);
    const claimed = await store.claimEscalation({ event, attemptId: "attempt", now: new Date(instant), leaseSeconds: 60 });
    if (!claimed) throw new Error("Test delivery must be claimed");
    for (const lostResponse of [false, true]) {
      const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", client: {
        send: async command => {
          if (command instanceof UpdateCommand) {
            expect(command.input.ExpressionAttributeValues).toMatchObject({ ":status": "receipt_pending", ":providerMessageId": "accepted",
              ":lastErrorCode": "ReceiptPersistenceError", ":attemptId": "attempt" });
            expect(command.input.UpdateExpression).toContain("sentAt = :updatedAt");
            if (lostResponse) throw Object.assign(new Error("already sent"), { name: "ConditionalCheckFailedException" });
            return { Attributes: { ...claimed, status: "receipt_pending", providerMessageId: "accepted", sentAt: instant } };
          }
          expect(command).toBeInstanceOf(GetCommand);
          return { Item: { ...claimed, status: "sent", providerMessageId: "accepted", sentAt: instant } };
        },
      } });
      const receipt = await repository.deferEscalationReceipt({ record: claimed, attemptId: "attempt", providerMessageId: "accepted", completedAt: new Date(instant) });
      expect(receipt).toMatchObject({ status: lostResponse ? "sent" : "receipt_pending", providerMessageId: "accepted", sentAt: instant });
    }
  });
});
