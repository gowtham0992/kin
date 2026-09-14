import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { InMemoryCareStore, type DutyAssignment } from "../src/domain.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { planMissedTaskEscalations, runEscalationSweep } from "../src/escalation.js";

const instant = "2026-09-10T10:00:00.000Z", now = new Date(instant), PK = "CIRCLE#synthetic";
const task = { id: "water", title: "Water check-in", dueAt: "2026-09-10T09:00:00.000Z", state: "scheduled" as const,
  lastResponse: null, confirmedAt: null, confirmedBy: null };
const duty: DutyAssignment = { memberId: "maya", memberName: "Maya", startsAt: "2026-09-10T00:00:00.000Z", endsAt: "2026-09-11T00:00:00.000Z" };
const members = [{ id: "maya", name: "Maya", relationship: "caregiver" as const, canReceiveAlerts: true },
  { id: "theo", name: "Theo", relationship: "caregiver" as const, canReceiveAlerts: true }];
const snapshot = () => new InMemoryCareStore([task], () => now, duty, "UTC", [], members).today();
const storedDuty = (assignment = duty, date = "2026-09-10") => ({ PK, SK: `DUTY#${date}`, entityType: "DutyAssignment", ...assignment });

describe("initial routing uses the duty that still owns the handoff", () => {
  it.each([false, true])("rejects a completed handoff before %s blocked recovery / initial insertion", async blocked => {
    const store = new InMemoryCareStore([task], () => now, null, "UTC", [], members);
    const publisher = { publish: vi.fn(async () => ({ messageId: "synthetic" })) };
    if (blocked) await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "blocked" });
    await store.assignDuty({ date: "2026-09-10", memberId: "maya" });
    const stale = await store.today();
    await store.assignDuty({ date: "2026-09-10", memberId: "theo", expectedMemberId: "maya", requestId: "handoff-001" });
    await runEscalationSweep({ snapshot: stale, store, publisher, now, attemptId: "stale" });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect((await store.today()).escalations.map(row => row.status)).toEqual(blocked ? ["blocked"] : []);
    await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "fresh" });
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recipientMemberId: "theo" }));
  });

  it("retains a recipient already frozen before the handoff", async () => {
    const store = new InMemoryCareStore([task], () => now, duty, "UTC", [], members);
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now }).events[0]!;
    await store.queueEscalation(event);
    await store.assignDuty({ date: "2026-09-10", memberId: "theo" });
    const publisher = { publish: vi.fn(async () => ({ messageId: "synthetic" })) };
    await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "already-queued" });
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recipientMemberId: "maya" }));
  });

  it("does not queue a stale memory review after its duty interval expires", async () => {
    let clock = now;
    const store = new InMemoryCareStore([task], () => clock, duty, "UTC", [], members);
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now }).events[0]!;
    clock = new Date(duty.endsAt);
    expect(await store.queueEscalation(event)).toBeNull();
    expect(await store.deliveryHealthSnapshot()).toEqual([]);
  });

  it("advances memory Today and worker coverage at local midnight", async () => {
    let clock = new Date("2026-11-01T05:30:00.000Z"); // October 31 in Denver, before the fall-back day.
    const today = { ...duty, startsAt: "2026-10-31T06:00:00.000Z", endsAt: "2026-11-01T06:00:00.000Z" };
    const tomorrow = { date: "2026-11-01", memberId: "theo", memberName: "Theo", startsAt: "2026-11-01T06:00:00.000Z", endsAt: "2026-11-02T07:00:00.000Z" };
    const store = new InMemoryCareStore([{ ...task, dueAt: "2026-11-01T07:00:00.000Z" }], () => clock, today, "America/Denver", [tomorrow], members);
    expect((await store.today()).onDuty?.memberId).toBe("maya");
    clock = new Date("2026-11-01T08:00:00.000Z");
    expect((await store.today()).onDuty?.memberId).toBe("theo");
    const workerSnapshot = await store.escalationSnapshot(clock);
    expect(workerSnapshot.onDuty).toMatchObject({ memberId: "theo", endsAt: tomorrow.endsAt });
    const publisher = { publish: vi.fn(async () => ({ messageId: "synthetic" })) };
    await runEscalationSweep({ snapshot: workerSnapshot, store, publisher, now: clock, attemptId: "after-midnight" });
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recipientMemberId: "theo" }));
    clock = new Date(tomorrow.endsAt);
    expect((await store.today()).onDuty).toBeNull();
  });
});

// Only the network boundary is fake. Evaluate every emitted condition against
// mutable rows, then apply atomically: removing the duty fence makes races commit.
class ConditionalRoutingTable {
  rows = new Map<string, Record<string, any>>();
  beforeTransaction?: (transaction: number) => void;
  transactions = 0;
  constructor() { this.rows.set(`TASK#${task.dueAt}#${task.id}`, { PK, SK: `TASK#${task.dueAt}#${task.id}`, entityType: "CareTask", ...task }); this.rows.set("DUTY#2026-09-10", storedDuty()); }
  send = async (command: unknown): Promise<unknown> => {
    if (command instanceof GetCommand) return { Item: structuredClone(this.rows.get(command.input.Key!.SK)) };
    if (!(command instanceof TransactWriteCommand)) throw new Error("Unexpected command");
    this.transactions += 1;
    this.beforeTransaction?.(this.transactions);
    const actions = command.input.TransactItems!;
    const keys = actions.map(action => action.Put?.Item?.SK ?? action.ConditionCheck?.Key?.SK ?? action.Update?.Key?.SK);
    expect(new Set(keys).size).toBe(keys.length);
    const reasons = actions.map(action => {
      const op = action.ConditionCheck ?? action.Put ?? action.Update!;
      const key = "Item" in op ? op.Item! : op.Key!;
      const row = this.rows.get(key.SK), names = op.ExpressionAttributeNames ?? {}, values = op.ExpressionAttributeValues ?? {};
      const expression = op.ConditionExpression!;
      let allowed: boolean;
      if (action.ConditionCheck && String(key.SK).startsWith("DUTY#")) {
        if (expression.includes(" OR ")) {
          allowed = row === undefined || row.startsAt > values[":now"] || row.endsAt <= values[":now"];
        } else {
          allowed = expression.split(" AND ").every(part => {
            const absent = /^attribute_not_exists\(([^)]+)\)$/.exec(part);
            if (absent) return row?.[names[absent[1]!] ?? absent[1]!] === undefined;
            const equality = /^(\S+) = (:\S+)$/.exec(part);
            if (!equality) throw new Error(`Unsupported duty expression ${part}`);
            return row?.[names[equality[1]!] ?? equality[1]!] === values[equality[2]!];
          });
        }
      } else if (action.ConditionCheck) {
        allowed = row?.entityType === "CareTask" && row.state === values[":scheduled"] && row.title === values[":title"] && row.lastResponse === values[":response"] && row.confirmedAt === values[":responseAt"];
      } else if (action.Put) allowed = row === undefined;
      else allowed = row?.status === "blocked" && row.attemptCount === 0;
      return { Code: allowed ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some(reason => reason.Code !== "None")) throw Object.assign(new Error("Conditional transaction rejected"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    for (const action of actions) {
      if (action.Put) this.rows.set(action.Put.Item!.SK, structuredClone(action.Put.Item!));
      if (action.Update) {
        const values = action.Update.ExpressionAttributeValues!;
        Object.assign(this.rows.get(action.Update.Key!.SK)!, { status: "queued", recipientMemberId: values[":memberId"], recipientMemberName: values[":memberName"] });
      }
    }
    return {};
  };
  repository(clock = () => now) { return new DynamoCareRepository({ client: this, tableName: "synthetic", circleId: "synthetic", now: clock }); }
}

describe("Dynamo duty fence at the atomic outbox boundary", () => {
  it.each(["memberId", "memberName", "startsAt", "endsAt", "changedAt", "changedBy"])("rejects a concurrent %s change before initial insertion", async field => {
    const table = new ConditionalRoutingTable(), event = planMissedTaskEscalations({ snapshot: await snapshot(), now }).events[0]!;
    table.beforeTransaction = () => { table.rows.get("DUTY#2026-09-10")![field] = field === "memberId" ? "theo" : "changed"; };
    expect(await table.repository().queueEscalation(event)).toBeNull();
    expect([...table.rows.values()].filter(row => row.entityType === "Escalation")).toEqual([]);
  });

  it("rejects a handoff that commits only at blocked recovery", async () => {
    const table = new ConditionalRoutingTable(), repository = table.repository();
    const event = planMissedTaskEscalations({ snapshot: await snapshot(), now }).events[0]!;
    await repository.queueEscalation({ taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, reason: "no_active_duty_assignment" });
    table.beforeTransaction = transaction => { if (transaction === 3) table.rows.set("DUTY#2026-09-10", storedDuty({ ...duty, memberId: "theo", memberName: "Theo" })); };
    expect(await repository.queueEscalation(event)).toBeNull();
    expect(table.rows.get(`ESCALATION#${task.dueAt}#${task.id}`)?.status).toBe("blocked");
  });

  it("rejects a prior-day active assignment introduced before today's first routing", async () => {
    const table = new ConditionalRoutingTable(), event = planMissedTaskEscalations({ snapshot: await snapshot(), now }).events[0]!;
    table.beforeTransaction = () => table.rows.set("DUTY#2026-09-09", storedDuty({ ...duty, memberId: "theo", startsAt: "2026-09-09T22:00:00.000Z" }, "2026-09-09"));
    expect(await table.repository().queueEscalation(event)).toBeNull();
  });

  it("preserves frozen receipts despite a later duty change or expired planning interval", async () => {
    const table = new ConditionalRoutingTable(), event = planMissedTaskEscalations({ snapshot: await snapshot(), now }).events[0]!;
    const original = await table.repository().queueEscalation(event);
    table.rows.set("DUTY#2026-09-10", storedDuty({ ...duty, memberId: "theo", memberName: "Theo" }));
    expect(await table.repository().queueEscalation(event)).toEqual({ record: original!.record, replayed: true });
    expect(await table.repository(() => new Date("2026-09-11T01:00:00.000Z")).queueEscalation(event)).toEqual({ record: original!.record, replayed: true });
  });

  it("accepts a still-active prior-day shift and exact same-request replay", async () => {
    const table = new ConditionalRoutingTable();
    const prior = { ...duty, startsAt: "2026-09-09T22:00:00.000Z" };
    table.rows.set("DUTY#2026-09-09", storedDuty(prior, "2026-09-09"));
    const event = planMissedTaskEscalations({ snapshot: { ...await snapshot(), onDuty: prior }, now }).events[0]!;
    const first = await table.repository().queueEscalation(event);
    expect(first?.record).toMatchObject({ status: "queued", recipientMemberId: "maya" });
    expect(await table.repository().queueEscalation(event)).toEqual({ record: first!.record, replayed: true });
  });

  it.each(["TransactionConflict", "ThrottlingError"])("does not disguise a duty-check %s as a stale handoff", async code => {
    const table = new ConditionalRoutingTable(), event = planMissedTaskEscalations({ snapshot: await snapshot(), now }).events[0]!;
    const failure = Object.assign(new Error("Storage uncertainty"), { name: "TransactionCanceledException", CancellationReasons: [
      { Code: "None" }, { Code: "None" }, { Code: code }, { Code: "None" },
    ] });
    table.beforeTransaction = () => { throw failure; };
    await expect(table.repository().queueEscalation(event)).rejects.toBe(failure);
  });

  it("rejects a first routing whose reviewed interval expired before queuing", async () => {
    const table = new ConditionalRoutingTable(), event = planMissedTaskEscalations({ snapshot: await snapshot(), now }).events[0]!;
    expect(await table.repository(() => new Date(duty.endsAt)).queueEscalation(event)).toBeNull();
    expect(table.transactions).toBe(0);
  });
});
