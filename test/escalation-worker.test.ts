import { describe, expect, it, vi } from "vitest";
import { createDemoStore, InMemoryCareStore } from "../src/domain.js";
import { createEscalationWorker } from "../src/escalation-worker.js";

const now = new Date("2026-09-02T16:00:00.000Z");

describe("scheduled escalation worker", () => {
  it("honors a reply recorded while the worker is reading the snapshot", async () => {
    let clock = new Date("2026-09-02T16:00:00.000Z");
    const repository = createDemoStore(() => clock);
    const readSnapshot = repository.escalationSnapshot.bind(repository);
    vi.spyOn(repository, "escalationSnapshot").mockImplementation(async asOf => {
      clock = new Date("2026-09-02T16:00:00.100Z");
      await repository.confirm({ taskId: "morning-water", response: "not_yet", actor: "Evelyn", requestId: "reply-during-read" });
      return readSnapshot(asOf);
    });
    const publish = vi.fn(async () => ({ messageId: "must-not-send" }));
    const worker = createEscalationWorker({ repository, publisher: { publish }, graceMinutes: 30,
      now: () => clock, log: () => undefined });
    const result = await worker({ source: "kin.scheduler" }, "snapshot-race");
    expect(result.counts).toEqual({});
    expect(publish).not.toHaveBeenCalled();
    expect(result.evaluatedAt).toBe("2026-09-02T16:00:00.100Z");
  });

  it("runs the durable missed-task path and logs only aggregate outcomes", async () => {
    const repository = createDemoStore(() => now);
    const deliveries: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const worker = createEscalationWorker({
      repository,
      publisher: {
        async publish(record) {
          deliveries.push(record.id);
          return { messageId: "sns-worker-1" };
        },
      },
      graceMinutes: 30,
      now: () => now,
      log: (entry) => logs.push(entry),
    });

    const result = await worker({ source: "kin.scheduler" }, "lambda-request-1");

    expect(result).toEqual({
      evaluatedAt: now.toISOString(),
      evaluatedTasks: 2,
      counts: { sent: 1 },
    });
    expect(deliveries).toHaveLength(1);
    expect(logs).toEqual([{ event: "kin.escalation_sweep.completed", ...result },
      { event: "kin.escalation_delivery.health", evaluatedAt: now.toISOString(), failed: 0, blocked: 0, receiptPending: 0, stuck: 0 }]);
    expect(JSON.stringify(logs)).not.toContain("Drink a glass of water");
    expect(JSON.stringify(logs)).not.toContain("Theo");
  });

  it("replays a scheduled invocation without publishing twice", async () => {
    const repository = createDemoStore(() => now);
    const publish = vi.fn(async () => ({ messageId: "sns-worker-1" }));
    const worker = createEscalationWorker({
      repository,
      publisher: { publish },
      graceMinutes: 30,
      now: () => now,
      log: () => undefined,
    });

    await worker({ source: "kin.scheduler" }, "lambda-request-1");
    await worker({ source: "kin.scheduler" }, "lambda-request-2");

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("rejects untrusted scheduler payloads before reading family data", async () => {
    const repository = createDemoStore(() => now);
    const snapshot = vi.spyOn(repository, "escalationSnapshot");
    const worker = createEscalationWorker({
      repository,
      publisher: { publish: vi.fn() },
      graceMinutes: 30,
      now: () => now,
      log: () => undefined,
    });

    await expect(worker({ source: "someone.else", circleId: "other-family" }, "request-1"))
      .rejects.toThrow();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("propagates infrastructure failures for Scheduler retry and DLQ handling", async () => {
    const repository = createDemoStore(() => now);
    vi.spyOn(repository, "escalationSnapshot").mockRejectedValue(new Error("DynamoDB unavailable"));
    const worker = createEscalationWorker({
      repository,
      publisher: { publish: vi.fn() },
      graceMinutes: 30,
      now: () => now,
      log: () => undefined,
    });

    await expect(worker({ source: "kin.scheduler" }, "request-1"))
      .rejects.toThrow("DynamoDB unavailable");
  });

  it("still evaluates the previous local day's task just after midnight", async () => {
    const afterMidnight = new Date("2026-09-03T06:30:00.000Z");
    const repository = new InMemoryCareStore(
      [{
        id: "late-check-in",
        title: "Late check-in",
        dueAt: "2026-09-03T05:30:00.000Z",
        state: "scheduled",
        lastResponse: null,
        confirmedBy: null,
        confirmedAt: null,
      }],
      () => afterMidnight,
      {
        memberId: "theo",
        memberName: "Theo",
        startsAt: "2026-09-02T14:00:00.000Z",
        endsAt: "2026-09-03T08:00:00.000Z",
      },
      "America/Denver",
    );
    const publish = vi.fn(async () => ({ messageId: "sns-late-task" }));
    const worker = createEscalationWorker({
      repository,
      publisher: { publish },
      graceMinutes: 30,
      now: () => afterMidnight,
      log: () => undefined,
    });

    const result = await worker({ source: "kin.scheduler" }, "request-after-midnight");

    expect(result).toMatchObject({ evaluatedTasks: 1, counts: { sent: 1 } });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("honors a persisted Not yet reply across midnight before publishing one follow-up", async () => {
    let clock = new Date("2026-09-03T05:45:00.000Z");
    const repository = new InMemoryCareStore([{
      id: "late-reply", title: "A glass of water", dueAt: "2026-09-03T05:30:00.000Z",
      state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null,
    }], () => clock, { memberId: "theo", memberName: "Theo",
      startsAt: "2026-09-03T05:00:00.000Z", endsAt: "2026-09-03T08:00:00.000Z" }, "America/Denver");
    await repository.confirm({ taskId: "late-reply", response: "not_yet", actor: "Evelyn", requestId: "late-reply-request" });
    const publish = vi.fn(async () => ({ messageId: "late-reply-message" }));
    const worker = createEscalationWorker({ repository, publisher: { publish }, graceMinutes: 30,
      now: () => clock, log: () => undefined });
    clock = new Date("2026-09-03T06:14:59.999Z");
    expect((await worker({ source: "kin.scheduler" }, "before-reply-grace")).counts).toEqual({});
    expect(publish).not.toHaveBeenCalled();
    clock = new Date("2026-09-03T06:15:00.000Z");
    expect((await worker({ source: "kin.scheduler" }, "at-reply-grace")).counts).toEqual({ sent: 1 });
    await worker({ source: "kin.scheduler" }, "replayed-sweep");
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await repository.today()).escalations[0]).toMatchObject({ taskId: "late-reply", status: "sent" });
    const task = (await repository.escalationSnapshot(clock)).tasks[0];
    expect(task).toMatchObject({ state: "scheduled", lastResponse: "not_yet", confirmedAt: "2026-09-03T05:45:00.000Z" });
  });
});
