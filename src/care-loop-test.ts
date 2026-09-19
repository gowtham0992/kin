import { z } from "zod";
import type { TodaySnapshot } from "./domain.js";
import { planMissedTaskEscalations, runEscalationSweep, type EscalationStore, type EscalationRecord } from "./escalation.js";
import { pushTestApprovalSchema } from "./push-test.js";
import type { PushDestination } from "./web-push.js";

export const careLoopTestTitle = "Kin test — missed check-in";
export const careLoopApprovalSchema = pushTestApprovalSchema.extend({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), dueAt: z.string().datetime(),
}).strict();
export type CareLoopApproval = z.infer<typeof careLoopApprovalSchema>;
const requestSchema = z.object({ source: z.literal("kin.care-loop-test"),
  approvalId: z.string().uuid(), action: z.enum(["inspect", "send"]), consent: z.literal(true),
}).strict();

/** Operator-only acceptance boundary; never an unrestricted scheduler invocation.
 * The runtime must atomically claim a permanent receipt and never retry a send.
 * A publisher acceptance is not proof of handset delivery. */
export function createCareLoopTest(input: {
  approval: CareLoopApproval;
  snapshot(): Promise<TodaySnapshot>;
  target(): Promise<PushDestination | null>;
  claim(): Promise<boolean>;
  store: EscalationStore;
  publish(record: EscalationRecord, target: PushDestination): Promise<{ messageId: string }>;
  now?: () => Date;
}) {
  const approval = careLoopApprovalSchema.parse(input.approval);
  const now = input.now ?? (() => new Date());
  const validTime = () => {
    const remaining = Date.parse(approval.expiresAt) - now().getTime();
    return remaining > 0 && remaining <= 15 * 60_000;
  };
  async function ready(allowOwnRecord = false) {
    if (!validTime()) return null;
    const snapshot = await input.snapshot();
    const tasks = snapshot.tasks.filter(task => task.id === approval.taskId);
    if (tasks.length !== 1 || tasks[0]!.title !== careLoopTestTitle || tasks[0]!.dueAt !== approval.dueAt
      || (!allowOwnRecord && snapshot.escalations.some(record => record.taskId === approval.taskId))) return null;
    const scoped = { ...snapshot, tasks };
    // Acceptance uses the real default grace, not a fast-forwarded production clock.
    const plan = planMissedTaskEscalations({ snapshot: scoped, now: now(), graceMinutes: 30 });
    if (plan.events.length !== 1 || plan.events[0]!.recipient.memberId !== approval.memberId) return null;
    const target = await input.target();
    return validTime() && target?.id === approval.subscriptionId ? { snapshot: scoped, target } : null;
  }
  return async (event: unknown) => {
    const request = requestSchema.safeParse(event);
    if (!request.success || request.data.approvalId !== approval.id) throw new Error("Invalid care-loop test request");
    if (!await ready()) return { status: "not_ready" as const, delivered: false as const };
    if (request.data.action === "inspect") return { status: "ready" as const, delivered: false as const };
    if (!await input.claim()) return { status: "already_attempted" as const, delivered: false as const };
    const current = await ready();
    if (!current) return { status: "not_ready" as const, delivered: false as const };
    let attempted = false;
    const result = await runEscalationSweep({ snapshot: current.snapshot, store: input.store,
      now: now(), completionClock: now, graceMinutes: 30, attemptId: approval.id,
      publisher: { publish: async record => {
        if (attempted || record.taskId !== approval.taskId || record.dueAt !== approval.dueAt
          || record.taskTitle !== careLoopTestTitle || record.recipientMemberId !== approval.memberId) {
          throw new Error("Care-loop test scope changed");
        }
        attempted = true;
        const latest = await ready(true);
        if (!latest) throw new Error("Care-loop test routing changed");
        return input.publish(record, latest.target);
      } },
    });
    const record = result.records[0];
    return { status: record?.status === "sent" ? "provider_accepted" as const : "outcome_unknown" as const,
      delivered: false as const, ...(record ? { escalationId: record.id } : {}) };
  };
}
