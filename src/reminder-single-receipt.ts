import { reminderCancellationJobSchema, type ReminderCancellationJobs } from "./echo-reminder-sync.js";
import type { ReminderReconciliationStore } from "./reminder-reconciliation.js";
import { z } from "zod";

export const singleReminderTestKind = "kin.reminder.single-receipt-test.v1";
const singleTestSchema = z.object({ kind: z.literal(singleReminderTestKind), receiptId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** A separate, default-off operator gate. Authorization is pinned in deployment
 * configuration, never inferred from an event-supplied receipt or enabled sweep.
 */
export async function runSingleReminderTest(event: unknown, environment: NodeJS.ProcessEnv,
  construct: () => ReturnType<typeof createSingleReceiptCancellation>) {
  const parsed = singleTestSchema.safeParse(event);
  if (environment.KIN_REMINDER_SINGLE_TEST_ENABLED !== "true" || environment.KIN_REMINDER_SYNC_WORKER_ENABLED === "true" ||
      !parsed.success || parsed.data.receiptId !== environment.KIN_REMINDER_SINGLE_RECEIPT_ID) {
    throw new Error("Single reminder test is not authorized.");
  }
  return construct()(parsed.data.receiptId);
}

/** Operator-only acceptance primitive. Not exposed as an MCP tool or public route.
 * No scans, cursor changes, care writes or completion writes are available here.
 * The trusted queue still verifies the original consent, receipt and terminal task.
 */
export function createSingleReceiptCancellation(options: {
  queue: { enqueue(receiptId: string): Promise<{ state: "queued" | "unchanged"; jobId?: string }> };
  jobs: Pick<ReminderCancellationJobs, "get">;
  dispatch: Pick<ReminderReconciliationStore, "claimDispatch">;
  publisher: { publish(job: NonNullable<Awaited<ReturnType<ReminderCancellationJobs["get"]>>>): Promise<"accepted" | "unchanged"> };
  now?: () => number;
}) {
  return async (receiptId: string): Promise<{ state: "unchanged" | "completed" | "expired" | "leased" | "accepted" }> => {
    if (typeof receiptId !== "string" || !/^[a-f0-9]{64}$/.test(receiptId)) throw new Error("Invalid reminder receipt.");
    try {
      const queued = await options.queue.enqueue(receiptId);
      if (queued.state === "unchanged") return { state: "unchanged" };
      if (!queued.jobId || !/^[a-f0-9]{64}$/.test(queued.jobId)) throw new Error("Invalid queued job.");
      const job = reminderCancellationJobSchema.parse(await options.jobs.get(queued.jobId));
      if (job.jobId !== queued.jobId) throw new Error("Job binding mismatch.");
      if (job.state === "completed") return { state: "completed" };
      const now = options.now?.() ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 300_000)) throw new Error("Invalid clock.");
      if (job.expiresAt <= now) return { state: "expired" };
      if (!await options.dispatch.claimDispatch(job.jobId, now, now + 300_000)) return { state: "leased" };
      // Provider acceptance is not deletion. Only the authenticated Echo receiver
      // can mark this job completed after its reminder DELETE succeeds.
      return { state: await options.publisher.publish(job) };
    } catch {
      throw new Error("Single reminder cancellation unavailable.");
    }
  };
}
