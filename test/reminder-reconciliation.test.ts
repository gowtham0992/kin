import { expect, it, vi } from "vitest";
import { createReminderReconciliation, type ReminderReconciliationStore } from "../src/reminder-reconciliation.js";
import { createReminderMessagePublisher } from "../src/reminder-message-publisher.js";
import type { ReminderCancellationJob } from "../src/echo-reminder-sync.js";

const id = "a".repeat(64);
const job: ReminderCancellationJob = { jobId: id, userId: "user", endpoint: "https://api.amazonalexa.com", alertToken: "alert", state: "pending", operation: "cancel", expiresAt: 999_999 };
function setup(enabled = true) {
  const store: ReminderReconciliationStore = {
    cursor: vi.fn().mockResolvedValue(undefined),
    page: vi.fn(async lane => ({ keys: [lane === "receipts" ? `RECEIPT#${id}` : `CANCEL#${id}`], more: false })),
    saveCursor: vi.fn().mockResolvedValue(undefined), claimDispatch: vi.fn().mockResolvedValue(true),
  };
  const queue = { enqueue: vi.fn().mockResolvedValue({ state: "queued" }) };
  const jobs = { get: vi.fn().mockResolvedValue(job), complete: vi.fn() };
  const publisher = { publish: vi.fn().mockResolvedValue("accepted") };
  return { store, queue, jobs, publisher, run: createReminderReconciliation({ enabled, store, queue, jobs, publisher, now: () => 100_000 }) };
}
it("does no I/O while disabled", async () => {
  const f = setup(false);
  expect(await f.run(() => 30_000)).toEqual({ enabled: false, examined: 0, queued: 0, accepted: 0, failed: 0, deferred: false });
  expect(f.store.cursor).not.toHaveBeenCalled();
});
it("reconciles and publishes without marking jobs complete", async () => {
  const f = setup();
  expect(await f.run(() => 30_000)).toMatchObject({ queued: 1, accepted: 1, failed: 0 });
  expect(f.jobs.complete).not.toHaveBeenCalled();
  expect(f.store.claimDispatch).toHaveBeenCalledWith(id, 100_000, 400_000);
  expect(f.store.saveCursor).toHaveBeenCalledWith("jobs", undefined);
});
it("does not publish when another dispatch owns the lease", async () => {
  const f = setup(); vi.mocked(f.store.claimDispatch).mockResolvedValue(false);
  expect(await f.run(() => 30_000)).toMatchObject({ accepted: 0 });
  expect(f.publisher.publish).not.toHaveBeenCalled();
});
it("keeps the five-minute dispatch cooldown after the shorter delivery window expires", async () => {
  const f = setup();
  let time = 100_000, leaseUntil = 0;
  vi.mocked(f.store.claimDispatch).mockImplementation(async (_id, now, until) => {
    if (leaseUntil > now) return false;
    leaseUntil = until;
    return true;
  });
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
  const publisher = createReminderMessagePublisher({ accessToken: async () => "skill-token", fetch: request, now: () => time });
  const run = createReminderReconciliation({ enabled: true, store: f.store, queue: f.queue, jobs: f.jobs, publisher, now: () => time });
  expect(await run(() => 30_000)).toMatchObject({ accepted: 1, failed: 0 });
  expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).expiresAfterSeconds).toBe(60);
  for (const later of [160_001, 399_999]) {
    time = later;
    expect(await run(() => 30_000)).toMatchObject({ accepted: 0, failed: 0 });
    expect(request).toHaveBeenCalledTimes(1);
  }
  time = 400_000;
  expect(await run(() => 30_000)).toMatchObject({ accepted: 1, failed: 0 });
  expect(request).toHaveBeenCalledTimes(2);
  expect(f.jobs.complete).not.toHaveBeenCalled();
  // Expiry still wins over eligibility for a new dispatch after its cooldown.
  time = job.expiresAt;
  expect(await run(() => 30_000)).toMatchObject({ accepted: 0, failed: 0 });
  expect(request).toHaveBeenCalledTimes(2);
});
it("advances past failed rows and records failure without logging private errors", async () => {
  const f = setup(); f.queue.enqueue.mockRejectedValue(new Error("private-record"));
  expect(await f.run(() => 30_000)).toMatchObject({ failed: 1, accepted: 1 });
  expect(f.store.saveCursor).toHaveBeenCalledWith("receipts", undefined);
});
it("preserves the last processed key when the runtime budget is low", async () => {
  const f = setup(); let checks = 0;
  vi.mocked(f.store.page).mockResolvedValue({ keys: [`RECEIPT#${id}`, `RECEIPT#${"b".repeat(64)}`], more: true });
  expect(await f.run(() => ++checks <= 2 ? 30_000 : 100)).toMatchObject({ examined: 1, deferred: true });
  expect(f.store.saveCursor).toHaveBeenCalledWith("receipts", `RECEIPT#${id}`);
  expect(f.store.page).toHaveBeenCalledTimes(1);
});
it.each(["completed", "expired"])("does not acquire a lease for %s work", async state => {
  const f = setup(); f.jobs.get.mockResolvedValue(state === "completed" ? { ...job, state } : { ...job, expiresAt: 1 });
  await f.run(() => 30_000);
  expect(f.store.claimDispatch).not.toHaveBeenCalled(); expect(f.publisher.publish).not.toHaveBeenCalled();
});
