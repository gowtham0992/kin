import { describe, expect, it } from "vitest";
import { createDemoStore } from "../src/domain.js";
import {
  type EscalationRecord,
  planMissedTaskEscalations,
  runEscalationSweep,
} from "../src/escalation.js";

describe("missed-task escalation planning", () => {
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
