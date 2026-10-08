import { describe, expect, it } from "vitest";
import { createDemoStore, InMemoryCareStore } from "../src/domain.js";
import {
  type EscalationRecord,
  planMissedTaskEscalations,
  runEscalationSweep,
} from "../src/escalation.js";

describe("missed-task escalation planning", () => {
  it("retains an unresolved follow-up over three local midnights including the fall clock change", async () => {
    let now = new Date("2026-10-31T15:31:00Z");
    const task = { id: "clock-water", title: "Synthetic clock water", dueAt: "2026-10-31T15:00:00Z", state: "scheduled" as const,
      lastResponse: null, confirmedBy: null, confirmedAt: null };
    const store = new InMemoryCareStore([task], () => now, null, "America/Denver");
    const record = (await store.queueEscalation({ taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, reason: "no_active_duty_assignment" }))!.record;
    for (const instant of ["2026-10-31T15:31:00Z", "2026-11-01T16:31:00Z", "2026-11-02T16:31:00Z", "2026-11-03T16:31:00Z"]) {
      now = new Date(instant);
      expect((await store.today()).escalations).toEqual([expect.objectContaining({ id: record.id, taskTitle: task.title })]);
    }
    await store.acknowledgeEscalation({ id: record.id, memberId: "maya", name: "Maya" });
    expect((await store.today()).escalations).toEqual([]);
    expect((await store.activityBetween({ startDate: "2026-10-31", endDate: "2026-11-03" })).tasks[0]?.state).toBe("scheduled");
  });
  it.each([
    { timeZone: "America/Denver", now: "2026-09-03T06:00:00.000Z", previous: "2026-09-03T05:40:00.000Z", old: "2026-09-02T05:40:00.000Z", today: "2026-09-03T07:00:00.000Z" },
    { timeZone: "Pacific/Kiritimati", now: "2026-09-02T10:00:00.000Z", previous: "2026-09-01T10:30:00.000Z", old: "2026-08-31T10:30:00.000Z", today: "2026-09-02T11:00:00.000Z" },
  ])("keeps every unresolved follow-up alongside today's acknowledged alerts in $timeZone", async fixture => {
    const now = new Date(fixture.now);
    const store = new InMemoryCareStore([
      ["previous-open", fixture.previous], ["previous-closed", fixture.previous],
      ["older-open", fixture.old], ["today-closed", fixture.today],
    ].map(([id, dueAt]) => ({ id: id!, dueAt: dueAt!, title: "A check-in", state: "scheduled", lastResponse: null,
      confirmedBy: null, confirmedAt: null })), () => now, null, fixture.timeZone);
    const queue = async (taskId: string, dueAt: string) => (await store.queueEscalation({
      taskId, taskTitle: "A check-in", dueAt, reason: "no_active_duty_assignment",
    }))!.record;
    const previous = await queue("previous-open", fixture.previous);
    const closed = await queue("previous-closed", fixture.previous);
    await store.acknowledgeEscalation({ id: closed.id, memberId: "maya", name: "Maya" });
    const older = await queue("older-open", fixture.old);
    const today = await queue("today-closed", fixture.today);
    await store.acknowledgeEscalation({ id: today.id, memberId: "maya", name: "Maya" });
    expect((await store.today()).escalations.map(alert => alert.id).sort()).toEqual([older.id, previous.id, today.id].sort());
    expect((await store.today()).escalations.every(alert => alert.taskTitle === "A check-in")).toBe(true);
    expect((await store.today()).tasks.map(task => task.id)).toEqual(["today-closed"]);
    await store.acknowledgeEscalation({ id: previous.id, memberId: "maya", name: "Maya" });
    expect((await store.today()).escalations.map(alert => alert.id).sort()).toEqual([older.id, today.id].sort());
  });

  it("gives a recorded Not yet reply a fresh grace period without completing the task", async () => {
    let now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    await store.confirm({ taskId: "morning-water", response: "not_yet", actor: "Evelyn", requestId: "not-yet-grace" });
    const snapshot = await store.today();
    expect(snapshot.tasks[0]).toMatchObject({ state: "scheduled", lastResponse: "not_yet", confirmedAt: now.toISOString() });
    expect(planMissedTaskEscalations({ snapshot, now }).events).toEqual([]);
    now = new Date("2026-09-02T16:29:59.999Z");
    expect(planMissedTaskEscalations({ snapshot, now }).events).toEqual([]);
    now = new Date("2026-09-02T16:30:00.000Z");
    expect(planMissedTaskEscalations({ snapshot, now }).events.map(event => event.taskId)).toEqual(["morning-water"]);
  });

  it("does not queue a blocked follow-up during the Not yet grace period", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    await store.confirm({ taskId: "morning-water", response: "not_yet", actor: "Evelyn", requestId: "not-yet-no-coverage" });
    const snapshot = await store.today(); snapshot.onDuty = null;
    expect(planMissedTaskEscalations({ snapshot, now })).toEqual({ events: [], blocked: [] });
  });

  it("does not let a retry extend the grace period of the original reply", async () => {
    let now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    const input = { taskId: "morning-water", response: "not_yet" as const, actor: "Evelyn", requestId: "not-yet-replay" };
    await store.confirm(input);
    now = new Date("2026-09-02T16:20:00.000Z");
    expect((await store.confirm(input)).replayed).toBe(true);
    const snapshot = await store.today();
    expect(planMissedTaskEscalations({ snapshot, now }).events).toEqual([]);
    now = new Date("2026-09-02T16:30:00.000Z");
    expect(planMissedTaskEscalations({ snapshot, now }).events.map(event => event.taskId)).toEqual(["morning-water"]);
  });

  it("uses the later of the due time and reply time with the configured grace", async () => {
    const now = new Date("2026-09-02T15:20:00.000Z");
    const snapshot = await createDemoStore(() => now).today();
    snapshot.tasks[0]!.lastResponse = "not_yet";
    snapshot.tasks[0]!.confirmedAt = "2026-09-02T14:00:00.000Z";
    expect(planMissedTaskEscalations({ snapshot, now, graceMinutes: 30 }).events).toEqual([]);
    snapshot.tasks[0]!.confirmedAt = "2026-09-02T15:15:00.000Z";
    expect(planMissedTaskEscalations({ snapshot, now, graceMinutes: 10 }).events).toEqual([]);
    expect(planMissedTaskEscalations({ snapshot, now: new Date("2026-09-02T15:25:00.000Z"), graceMinutes: 10 }).events).toHaveLength(1);
  });

  it.each([null, "invalid", "2026-09-03T16:00:00.000Z"])("does not hide an overdue task behind an unusable reply timestamp: %s", async confirmedAt => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const snapshot = await createDemoStore(() => now).today();
    snapshot.tasks[0]!.lastResponse = "not_yet";
    snapshot.tasks[0]!.confirmedAt = confirmedAt;
    expect(planMissedTaskEscalations({ snapshot, now }).events.map(event => event.taskId)).toEqual(["morning-water"]);
  });

  it("records the first caregiver acknowledgment without completing the task or changing delivery state", async () => {
    const now = new Date("2026-09-02T16:00:00Z");
    const store = createDemoStore(() => now);
    const task = (await store.today()).tasks[0]!;
    const { record } = (await store.queueEscalation({ taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, reason: "no_active_duty_assignment" }))!;
    await store.acknowledgeEscalation({ id: record.id, memberId: "maya", name: "Maya" });
    const retry = await store.acknowledgeEscalation({ id: record.id, memberId: "theo", name: "Theo" });
    expect(retry).toMatchObject({ status: "blocked", acknowledgedBy: "Maya", acknowledgedAt: now.toISOString() });
    expect((await store.today()).tasks[0]!.state).toBe("scheduled");
    expect(retry).not.toHaveProperty("acknowledgment");
    await expect(store.acknowledgeEscalation({ id: "unknown", memberId: "maya", name: "Maya" })).rejects.toThrow("not found");
  });
  it("recovers a blocked alert when coverage is assigned and publishes only once", async () => {
    const now = new Date("2026-09-02T16:00:00Z");
    const tasks = (await createDemoStore(() => now).today()).tasks;
    const store = new InMemoryCareStore(tasks, () => now);
    const recipients: string[] = [];
    const publisher = { publish: async (record: EscalationRecord) => {
      recipients.push(record.recipientMemberId!);
      return { messageId: "recovered-alert" };
    } };
    const blocked = await runEscalationSweep({ snapshot: await store.today(), store, publisher, now, attemptId: "no-coverage" });
    expect(blocked.records[0]?.status).toBe("blocked");
    await store.assignDuty({ date: "2026-09-02", memberId: "maya" });
    const snapshot = await store.today();
    const results = await Promise.all(["recovery-1", "recovery-2"].map(attemptId =>
      runEscalationSweep({ snapshot, store, publisher, now, attemptId }),
    ));
    expect(recipients).toEqual(["maya"]);
    expect(results.flatMap(result => result.records).some(record => record.status === "sent")).toBe(true);
    expect((await store.today()).escalations[0]).toMatchObject({ status: "sent", recipientMemberName: "Maya" });
  });

  it("routes an overdue task to the active on-duty caregiver after the grace period", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const snapshot = await createDemoStore(() => now).today();

    const plan = planMissedTaskEscalations({ snapshot, now, graceMinutes: 30 });

    expect(plan.blocked).toEqual([]);
    expect(plan.events).toEqual([
      expect.objectContaining({
        taskId: "morning-water",
        recipient: expect.objectContaining({ memberId: "theo" }),
      }),
    ]);
  });

  it("does not escalate a completed task", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    await store.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Evelyn",
      requestId: "voice-turn-0009",
    });

    const plan = planMissedTaskEscalations({ snapshot: await store.today(), now });
    expect(plan.events).toEqual([]);
  });

  it("surfaces a blocked escalation when nobody is actively on duty", async () => {
    const now = new Date("2026-09-03T03:00:00.000Z");
    const snapshot = await createDemoStore(() => new Date("2026-09-02T16:00:00.000Z")).today();

    const plan = planMissedTaskEscalations({ snapshot, now });

    expect(plan.events).toEqual([]);
    expect(plan.blocked.map((item) => item.reason)).toEqual([
      "no_active_duty_assignment",
      "no_active_duty_assignment",
    ]);
  });

  it("publishes a missed task once and replays the durable sent record", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    const published: string[] = [];
    const publisher = {
      async publish(event: { id: string }) {
        published.push(event.id);
        return { messageId: "sns-message-1" };
      },
    };

    const first = await runEscalationSweep({
      snapshot: await store.today(),
      store,
      publisher,
      now,
      attemptId: "sweep-attempt-1",
    });
    const second = await runEscalationSweep({
      snapshot: await store.today(),
      store,
      publisher,
      now,
      attemptId: "sweep-attempt-2",
    });

    expect(published).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ status: "sent", attemptCount: 1 });
    expect(second.records[0]).toMatchObject({
      status: "sent",
      providerMessageId: "sns-message-1",
    });
    expect((await store.today()).escalations).toHaveLength(1);
  });

  it("allows one worker to hold an unexpired delivery lease", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    const plan = planMissedTaskEscalations({ snapshot: await store.today(), now });
    const event = plan.events[0]!;
    await store.queueEscalation(event);

    const [first, second] = await Promise.all([
      store.claimEscalation({ event, attemptId: "worker-1", now, leaseSeconds: 60 }),
      store.claimEscalation({ event, attemptId: "worker-2", now, leaseSeconds: 60 }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("records a privacy-safe failure code and retries on the next sweep", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    let shouldFail = true;
    const publisher = {
      async publish() {
        if (shouldFail) {
          shouldFail = false;
          const error = new Error("provider details must not be persisted");
          error.name = "ServiceUnavailable";
          throw error;
        }
        return { messageId: "sns-message-2" };
      },
    };

    const failed = await runEscalationSweep({
      snapshot: await store.today(), store, publisher, now, attemptId: "worker-1",
    });
    const retried = await runEscalationSweep({
      snapshot: await store.today(), store, publisher, now, attemptId: "worker-2",
    });

    expect(failed.records[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "ServiceUnavailable",
    });
    expect(retried.records[0]).toMatchObject({ status: "sent", attemptCount: 2 });
  });

  it("retries to the recipient frozen in the durable outbox record", async () => {
    const now = new Date("2026-09-02T16:00:00.000Z");
    const snapshot = await createDemoStore(() => now).today();
    snapshot.onDuty = {
      memberId: "maya",
      memberName: "Maya",
      startsAt: "2026-09-02T08:00:00.000Z",
      endsAt: "2026-09-03T02:00:00.000Z",
    };
    const prior: EscalationRecord = {
      id: "missed_morning-water_2026-09-02T15:00:00.000Z",
      taskId: "morning-water",
      taskTitle: "Drink a glass of water",
      dueAt: "2026-09-02T15:00:00.000Z",
      createdAt: "2026-09-02T15:31:00.000Z",
      updatedAt: "2026-09-02T15:31:00.000Z",
      recipientMemberId: "theo",
      recipientMemberName: "Theo",
      status: "failed",
      attemptCount: 1,
      attemptId: null,
      leaseUntil: null,
      providerMessageId: null,
      lastErrorCode: "ServiceUnavailable",
    };
    const delivered: unknown[] = [];
    const store = {
      async queueEscalation() { return { record: prior, replayed: true }; },
      async claimEscalation() {
        return { ...prior, status: "sending" as const, attemptId: "retry-2" };
      },
      async completeEscalation() { return { ...prior, status: "sent" as const }; },
      async deferEscalationReceipt() { throw new Error("Unexpected receipt persistence failure"); },
      async failEscalation() { return prior; },
    };

    await runEscalationSweep({
      snapshot,
      store,
      publisher: {
        async publish(delivery: unknown) {
          delivered.push(delivery);
          return { messageId: "sns-retry" };
        },
      },
      now,
      attemptId: "retry-2",
    });

    expect(delivered[0]).toMatchObject({ recipientMemberId: "theo" });
  });
});
