import type { Context } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createConfiguredEscalationWorker, createEscalationWorker, handler } from "../src/escalation-worker.js";

const now = new Date("2026-09-02T16:00:00.000Z");

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fixture(environment: NodeJS.ProcessEnv) {
  const repository = createDemoStore(() => now);
  const snapshot = vi.spyOn(repository, "escalationSnapshot");
  const queue = vi.spyOn(repository, "queueEscalation");
  const publish = vi.fn(async () => ({ messageId: "synthetic-worker-delivery" }));
  const log = vi.fn();
  const createWorker = vi.fn(() => createEscalationWorker({ repository, publisher: { publish }, graceMinutes: 30, now: () => now, log }));
  return {
    worker: createConfiguredEscalationWorker(environment, { createWorker, now: () => now, log }),
    createWorker, snapshot, queue, publish, log,
  };
}

describe("worker release controls", () => {
  it.each([{ flag: undefined }, { flag: "false" }])("does no family work with worker flag $flag", async ({ flag }) => {
    const state = fixture({ KIN_ESCALATION_WORKER_ENABLED: flag });
    const result = await state.worker({ source: "kin.scheduler" }, "paused-invocation");
    expect(result).toEqual({ status: "paused", evaluatedAt: now.toISOString(), evaluatedTasks: 0, counts: {} });
    expect(state.log).toHaveBeenCalledExactlyOnceWith({ event: "kin.escalation_sweep.paused", ...result });
    expect(state.createWorker).not.toHaveBeenCalled();
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.queue).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it("needs no AWS configuration when paused", async () => {
    const worker = createConfiguredEscalationWorker({}, { now: () => now, log: () => undefined });
    await expect(worker({ source: "kin.scheduler" }, "unconfigured-paused")).resolves.toMatchObject({ status: "paused", evaluatedTasks: 0 });
  });

  it("keeps the deployed Lambda entry point behind the pause boundary", async () => {
    vi.stubEnv("KIN_ESCALATION_WORKER_ENABLED", "false");
    vi.stubEnv("KIN_DYNAMODB_TABLE", undefined);
    vi.stubEnv("KIN_ALERT_TOPIC_ARN", undefined);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await handler({ source: "kin.scheduler" }, { awsRequestId: "paused-handler" } as Context, () => undefined);
    expect(result).toMatchObject({ status: "paused", evaluatedTasks: 0, counts: {} });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ event: "kin.escalation_sweep.paused", status: "paused" });
  });

  it.each(["", "TRUE", "False", "1", " true ", "enabled"])(
    "rejects invalid worker flag %j before constructing a worker", async flag => {
      const state = fixture({ KIN_ESCALATION_WORKER_ENABLED: flag });
      await expect(state.worker({ source: "kin.scheduler" }, "invalid-config"))
        .rejects.toThrow("KIN_ESCALATION_WORKER_ENABLED must be true or false");
      expect(state.createWorker).not.toHaveBeenCalled();
      expect(state.snapshot).not.toHaveBeenCalled();
      expect(state.publish).not.toHaveBeenCalled();
    },
  );

  it("runs the normal durable worker only when explicitly enabled", async () => {
    const state = fixture({ KIN_ESCALATION_WORKER_ENABLED: "true" });
    const result = await state.worker({ source: "kin.scheduler" }, "enabled-invocation");
    expect(result).toEqual({ evaluatedAt: now.toISOString(), evaluatedTasks: 2, counts: { sent: 1 } });
    await state.worker({ source: "kin.scheduler" }, "enabled-retry");
    expect(state.createWorker).toHaveBeenCalledTimes(1);
    expect(state.publish).toHaveBeenCalledTimes(1);
  });

  it("checks the gate before reusing an already constructed worker", async () => {
    const environment = { KIN_ESCALATION_WORKER_ENABLED: "true" };
    const state = fixture(environment);
    await state.worker({ source: "kin.scheduler" }, "before-pause");
    state.snapshot.mockClear(); state.queue.mockClear(); state.publish.mockClear();
    environment.KIN_ESCALATION_WORKER_ENABLED = "false";
    await expect(state.worker({ source: "kin.scheduler" }, "after-pause")).resolves.toMatchObject({ status: "paused" });
    expect(state.createWorker).toHaveBeenCalledTimes(1);
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.queue).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
    // Lambda environment updates are not instantaneous remote switches; this tests the wrapper boundary only.
  });

  it.each([
    { event: { source: "kin.scheduler", force: true }, requestId: "manual-override" },
    { event: { source: "kin.scheduler", enabled: true }, requestId: "manual-enable" },
    { event: { source: "someone.else" }, requestId: "foreign-source" },
    { event: { source: "kin.scheduler" }, requestId: "" },
    { event: { source: "kin.scheduler" }, requestId: "x".repeat(129) },
  ])("rejects altered invocation $requestId even while paused", async ({ event, requestId }) => {
    const state = fixture({ KIN_ESCALATION_WORKER_ENABLED: "false" });
    await expect(state.worker(event, requestId)).rejects.toThrow();
    expect(state.createWorker).not.toHaveBeenCalled();
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });
});
