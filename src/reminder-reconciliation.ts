import type { ReminderCancellationJobs } from "./echo-reminder-sync.js";

export type ReminderLane = "receipts" | "jobs";
export interface ReminderReconciliationStore {
  cursor(lane: ReminderLane): Promise<string | undefined>;
  page(lane: ReminderLane, after: string | undefined, limit: number): Promise<{ keys: string[]; more: boolean }>;
  saveCursor(lane: ReminderLane, after: string | undefined): Promise<void>;
  /** Atomic, bounded dispatch lease; separate from the immutable cancellation identity. */
  claimDispatch(jobId: string, now: number, until: number): Promise<boolean>;
}

/** One bounded page per lane. Run with reserved concurrency one to serialize cursors.
 * A crash before cursor save replays work safely; a failed row is revisited next scan cycle.
 * Dispatch leases prevent immediate duplicate publication but are not delivery receipts.
 */
export function createReminderReconciliation(options: {
  enabled: boolean;
  store: ReminderReconciliationStore;
  queue: { enqueue(id: string): Promise<{ state: "queued" | "unchanged" }> };
  jobs: ReminderCancellationJobs;
  publisher: { publish: (job: NonNullable<Awaited<ReturnType<ReminderCancellationJobs["get"]>>>) => Promise<"accepted" | "unchanged"> };
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (remainingMs: () => number) => {
    const report = { enabled: options.enabled, examined: 0, queued: 0, accepted: 0, failed: 0, deferred: false };
    if (!options.enabled) return report;
    for (const lane of ["receipts", "jobs"] as const) {
      if (remainingMs() < 10_000) { report.deferred = true; break; }
      const after = await options.store.cursor(lane);
      const page = await options.store.page(lane, after, 25);
      if (page.keys.length > 25 || (page.more && !page.keys.length)) throw new Error("Invalid reminder scan page.");
      let last = after, finished = true;
      for (const key of page.keys) {
        if (remainingMs() < 10_000) { finished = false; report.deferred = true; break; }
        try {
          const match = (lane === "receipts" ? /^RECEIPT#([a-f0-9]{64})$/ : /^CANCEL#([a-f0-9]{64})$/).exec(key);
          // Scan pages also include claims/cursors/leases; these do not authorize work.
          if (match) {
            if (lane === "receipts") {
              if ((await options.queue.enqueue(match[1]!)).state === "queued") report.queued++;
            } else {
              const job = await options.jobs.get(match[1]!);
              if (job && job.state === "pending" && job.expiresAt > now() &&
                  await options.store.claimDispatch(job.jobId, now(), now() + 300_000)) {
                if (await options.publisher.publish(job) === "accepted") report.accepted++;
              }
            }
          }
        } catch { report.failed++; }
        report.examined++;
        last = key;
      }
      await options.store.saveCursor(lane, finished && !page.more ? undefined : last);
      if (!finished) break;
    }
    return report;
  };
}
