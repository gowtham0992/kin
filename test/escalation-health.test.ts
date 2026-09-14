import { describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createEscalationWorker } from "../src/escalation-worker.js";

const now = new Date("2026-09-02T16:00:00.000Z");

describe("escalation delivery health", () => {
  it("aborts before any publication when the unresolved-delivery inventory is incomplete", async () => {
    const repository = createDemoStore(() => now), log = vi.fn(), publish = vi.fn();
    vi.spyOn(repository, "deliveryHealthSnapshot").mockRejectedValue(new Error("Delivery health window is incomplete"));
    const worker = createEscalationWorker({ repository, graceMinutes: 30, now: () => now, log, publisher: { publish } });
    await expect(worker({ source: "kin.scheduler" }, "incomplete-inventory")).rejects.toThrow("incomplete");
    expect(publish).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it("does not clear an unresolved failure merely because its task is older than two days", async () => {
    let clock = now;
    const repository = createDemoStore(() => clock), log = vi.fn();
    const worker = createEscalationWorker({ repository, graceMinutes: 30, now: () => clock, log,
      publisher: { publish: async () => { throw new Error("synthetic failure"); } } });
    await worker({ source: "kin.scheduler" }, "first-failure");
    clock = new Date("2026-09-04T16:00:00.000Z");
    log.mockClear();
    await worker({ source: "kin.scheduler" }, "after-day-rollover");
    expect(log).toHaveBeenCalledWith({ event: "kin.escalation_delivery.health", evaluatedAt: clock.toISOString(),
      failed: 1, blocked: 0, receiptPending: 0, stuck: 0 });
  });
  it("emits an actionable aggregate when provider rejection does not throw the invocation", async () => {
    const log = vi.fn();
    const repository = createDemoStore(() => now);
    const worker = createEscalationWorker({ repository, graceMinutes: 30, now: () => now, log,
      publisher: { publish: async () => { throw Object.assign(new Error("private provider detail"), { name: "AuthorizationError" }); } } });
    await expect(worker({ source: "kin.scheduler" }, "rejected-delivery")).resolves.toMatchObject({ counts: { failed: 1 } });
    expect(log).toHaveBeenCalledWith({ event: "kin.escalation_delivery.health", evaluatedAt: now.toISOString(),
      failed: 1, blocked: 0, receiptPending: 0, stuck: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private provider detail|Drink a glass|Theo|AuthorizationError/);
  });

  it("includes persisted failures no longer selected by the current task plan", async () => {
    const repository = createDemoStore(() => now);
    const read = repository.escalationSnapshot.bind(repository);
    vi.spyOn(repository, "escalationSnapshot").mockImplementation(async date => ({ ...await read(date), tasks: [], escalations: [
      { id: "old-failure", taskId: "finished", status: "failed", recipientMemberName: "Private name", dueAt: now.toISOString(), updatedAt: now.toISOString() },
      { id: "unrouted", taskId: "finished", status: "blocked", recipientMemberName: null, dueAt: now.toISOString(), updatedAt: now.toISOString() },
      { id: "stuck", taskId: "finished", status: "sending", recipientMemberName: "Private name", dueAt: now.toISOString(), updatedAt: "2026-09-02T15:45:00.000Z" },
      { id: "recent", taskId: "finished", status: "sending", recipientMemberName: "Private name", dueAt: now.toISOString(), updatedAt: "2026-09-02T15:45:00.001Z" },
    ] }));
    const log = vi.fn(), publish = vi.fn();
    await createEscalationWorker({ repository, publisher: { publish }, graceMinutes: 30, now: () => now, log })({ source: "kin.scheduler" }, "persisted-health");
    expect(log).toHaveBeenCalledWith({ event: "kin.escalation_delivery.health", evaluatedAt: now.toISOString(),
      failed: 1, blocked: 1, receiptPending: 0, stuck: 1 });
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("Private name");
  });

  it("replaces old failure status with the current successful retry rather than double-counting", async () => {
    const repository = createDemoStore(() => now);
    const log = vi.fn();
    const publish = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue({ messageId: "synthetic-receipt" });
    const worker = createEscalationWorker({ repository, publisher: { publish }, graceMinutes: 30, now: () => now, log });
    await worker({ source: "kin.scheduler" }, "first");
    log.mockClear();
    await worker({ source: "kin.scheduler" }, "retry");
    expect(log).toHaveBeenCalledWith({ event: "kin.escalation_delivery.health", evaluatedAt: now.toISOString(),
      failed: 0, blocked: 0, receiptPending: 0, stuck: 0 });
  });

  it("passes one object to the default logger so Lambda JSON preserves metric fields", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await createEscalationWorker({ repository: createDemoStore(() => now), graceMinutes: 30, now: () => now,
        publisher: { publish: async () => ({ messageId: "synthetic" }) } })({ source: "kin.scheduler" }, "structured-log");
      expect(output).toHaveBeenCalledWith(expect.objectContaining({ event: "kin.escalation_delivery.health", failed: 0 }));
    } finally { output.mockRestore(); }
  });
});
