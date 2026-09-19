import { expect, it, vi } from "vitest";
import { createSingleReceiptCancellation } from "../src/reminder-single-receipt.js";
import type { ReminderCancellationJob } from "../src/echo-reminder-sync.js";

const receiptId = "a".repeat(64), jobId = "b".repeat(64);
function setup() {
  const job: ReminderCancellationJob = { jobId, userId: "test-user", endpoint: "https://api.amazonalexa.com",
    alertToken: "test-reminder", operation: "cancel", state: "pending", expiresAt: 900_000 };
  const queue = { enqueue: vi.fn(async () => ({ state: "queued" as "queued" | "unchanged", jobId: jobId as string | undefined })) };
  const jobs = { get: vi.fn(async (): Promise<ReminderCancellationJob | null> => job) };
  const dispatch = { claimDispatch: vi.fn(async () => true) };
  const publisher = { publish: vi.fn(async () => "accepted" as "accepted" | "unchanged") };
  return { job, queue, jobs, dispatch, publisher,
    run: createSingleReceiptCancellation({ queue, jobs, dispatch, publisher, now: () => 100_000 }) };
}
it("dispatches only the job bound by the one consent-checked receipt", async () => {
  const f = setup();
  expect(await f.run(receiptId)).toEqual({ state: "accepted" });
  expect(f.queue.enqueue.mock.calls).toEqual([[receiptId]]);
  expect(f.jobs.get.mock.calls).toEqual([[jobId]]);
  expect(f.dispatch.claimDispatch.mock.calls).toEqual([[jobId, 100_000, 400_000]]);
  expect(f.publisher.publish.mock.calls).toEqual([[f.job]]);
});
it.each(["", "A".repeat(64), "a".repeat(63), `RECEIPT#${receiptId}`])("rejects invalid receipt before I/O: %s", async id => {
  const f = setup(); await expect(f.run(id)).rejects.toThrow("Invalid reminder receipt.");
  expect(f.queue.enqueue).not.toHaveBeenCalled();
});
it("does not resolve or publish when consent queue declines work", async () => {
  const f = setup(); f.queue.enqueue.mockResolvedValue({ state: "unchanged", jobId: undefined });
  expect(await f.run(receiptId)).toEqual({ state: "unchanged" }); expect(f.jobs.get).not.toHaveBeenCalled();
});
it.each([undefined, "wrong"])("rejects malformed queued identity %s", async id => {
  const f = setup(); f.queue.enqueue.mockResolvedValue({ state: "queued", jobId: id });
  await expect(f.run(receiptId)).rejects.toThrow("Single reminder cancellation unavailable.");
  expect(f.jobs.get).not.toHaveBeenCalled();
});
it.each(["missing", "foreign"])("rejects a %s job without leasing or publishing", async state => {
  const f = setup(); f.jobs.get.mockResolvedValue(state === "missing" ? null : { ...f.job, jobId: "c".repeat(64) });
  await expect(f.run(receiptId)).rejects.toThrow("Single reminder cancellation unavailable.");
  expect(f.dispatch.claimDispatch).not.toHaveBeenCalled(); expect(f.publisher.publish).not.toHaveBeenCalled();
});
it.each(["completed", "expired"] as const)("does not dispatch %s work", async state => {
  const f = setup(); f.jobs.get.mockResolvedValue(state === "completed" ? { ...f.job, state } : { ...f.job, expiresAt: 100_000 });
  expect(await f.run(receiptId)).toEqual({ state }); expect(f.dispatch.claimDispatch).not.toHaveBeenCalled();
});
it("serializes repeated attempts with the shared dispatch lease", async () => {
  const f = setup(); let held = false;
  f.dispatch.claimDispatch.mockImplementation(async () => { if (held) return false; held = true; return true; });
  expect(await Promise.all([f.run(receiptId), f.run(receiptId)])).toEqual([{ state: "accepted" }, { state: "leased" }]);
  expect(f.publisher.publish).toHaveBeenCalledTimes(1);
});
it("does not mistake publisher unchanged for delivery", async () => {
  const f = setup(); f.publisher.publish.mockResolvedValue("unchanged");
  expect(await f.run(receiptId)).toEqual({ state: "unchanged" });
});
it("sanitizes provider failures without retrying publication", async () => {
  const f = setup(); f.publisher.publish.mockRejectedValue(new Error("private-token-and-user"));
  await expect(f.run(receiptId)).rejects.toThrow(/^Single reminder cancellation unavailable\.$/);
  expect(f.publisher.publish).toHaveBeenCalledTimes(1);
});
