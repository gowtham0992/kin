import { afterEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ enqueue: vi.fn(), get: vi.fn(), lease: vi.fn(), publish: vi.fn(), scan: vi.fn(), complete: vi.fn() }));
vi.mock("../src/reminder-cancellation-queue.js", () => ({ createReminderCancellationQueue: () => ({ enqueue: io.enqueue }) }));
vi.mock("../src/reminder-reconciliation-store.js", () => ({ createReminderReconciliationStore: () => ({ claimDispatch: io.lease, page: io.scan }) }));
vi.mock("../src/echo-reminder-sync.js", async original => ({ ...await original<object>(), createDynamoReminderCancellationJobs: () => ({ get: io.get, complete: io.complete }) }));
vi.mock("../src/reminder-message-publisher.js", () => ({ createReminderMessagePublisher: () => ({ publish: io.publish }) }));
const receiptId = "a".repeat(64), jobId = "b".repeat(64);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.resetModules(); });
function setup() {
  for (const [k,v] of Object.entries({ KIN_REMINDER_SYNC_WORKER_ENABLED: "false", KIN_REMINDER_SINGLE_TEST_ENABLED: "true",
    KIN_REMINDER_SINGLE_RECEIPT_ID: receiptId, KIN_ECHO_REMINDER_CLAIMS_TABLE: "kin-echo-reminder-claims",
    KIN_ECHO_REMINDER_SYNC_TABLE: "kin-echo-reminder-sync", KIN_DYNAMODB_TABLE: "care", KIN_CIRCLE_ID: "test-circle",
    KIN_SKILL_MESSAGING_SECRET_ID: "kin/alexa-skill-messaging" })) vi.stubEnv(k,v);
  io.enqueue.mockResolvedValue({ state: "queued", jobId });
  io.get.mockResolvedValue({ jobId, userId: "synthetic-user", endpoint: "https://api.amazonalexa.com", alertToken: "synthetic-reminder",
    state: "pending", operation: "cancel", expiresAt: 2_000_000_000_000 });
  io.lease.mockResolvedValue(true); io.publish.mockResolvedValue("accepted");
  vi.spyOn(Date,"now").mockReturnValue(1_800_000_000_000);
  return vi.spyOn(console,"info").mockImplementation(() => {});
}
it("routes the exact operator event without scanning, completing, or logging identities", async () => {
  const log=setup(); const { handler }=await import("../src/reminder-sync-worker.js");
  expect(await handler({ kind: "kin.reminder.single-receipt-test.v1", receiptId }, { getRemainingTimeInMillis: () => 60_000 }))
    .toEqual({ state: "accepted" });
  expect(io.enqueue).toHaveBeenCalledExactlyOnceWith(receiptId);
  expect(io.publish).toHaveBeenCalledTimes(1); expect(io.scan).not.toHaveBeenCalled(); expect(io.complete).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "kin_reminder_single_test", state: "accepted" }));
});
it("leaves scheduled invocations paused during the operator test", async () => {
  setup(); const { handler }=await import("../src/reminder-sync-worker.js");
  expect(await handler({ source: "aws.events" }, { getRemainingTimeInMillis: () => 60_000 })).toEqual({ enabled: false });
  expect(io.enqueue).not.toHaveBeenCalled(); expect(io.publish).not.toHaveBeenCalled(); expect(io.scan).not.toHaveBeenCalled();
});
it("rejects another receipt through the handler without I/O", async () => {
  setup(); const { handler }=await import("../src/reminder-sync-worker.js");
  await expect(handler({ kind: "kin.reminder.single-receipt-test.v1", receiptId: "c".repeat(64) }, { getRemainingTimeInMillis: () => 60_000 }))
    .rejects.toThrow("Kin reminder synchronization sweep incomplete.");
  expect(io.enqueue).not.toHaveBeenCalled(); expect(io.publish).not.toHaveBeenCalled();
});
