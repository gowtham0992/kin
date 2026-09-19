import { z } from "zod";
import type { PushDestination } from "./web-push.js";

export const pushTestApprovalSchema = z.object({
  id: z.string().uuid(), memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  subscriptionId: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
}).strict();
export type PushTestApproval = z.infer<typeof pushTestApprovalSchema>;
const eventSchema = z.object({ source: z.literal("kin.push-test"), approvalId: z.string().uuid(),
  action: z.enum(["inspect", "send"]), consent: z.literal(true) }).strict();
export type PushTestStatus = "ready" | "provider_accepted" | "outcome_unknown" | "already_attempted" | "not_ready";

/** Private IAM invocation only. No care/outbox writes, scheduler calls or SMS fallback. */
export function createPushTest(input: {
  approval: PushTestApproval;
  target(): Promise<PushDestination | null>;
  onDuty(): Promise<boolean>;
  claim(): Promise<boolean>;
  finish(status: "provider_accepted" | "outcome_unknown"): Promise<void>;
  send(target: PushDestination): Promise<void>;
  now?: () => number;
}) {
  const approval = pushTestApprovalSchema.parse(input.approval);
  const validTime = () => {
    const remaining = Date.parse(approval.expiresAt) - (input.now?.() ?? Date.now());
    return remaining > 0 && remaining <= 15 * 60_000;
  };
  async function ready() {
    if (!validTime() || !await input.onDuty()) return null;
    const target = await input.target();
    return validTime() && target?.id === approval.subscriptionId ? target : null;
  }
  return async (event: unknown): Promise<{ status: PushTestStatus; delivered: false }> => {
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success || parsed.data.approvalId !== approval.id) throw new Error("Invalid push test request");
    if (!await ready()) return { status: "not_ready", delivered: false };
    if (parsed.data.action === "inspect") return { status: "ready", delivered: false };
    // Claim is durable and never expires/reopens. A crash consumes the approval.
    if (!await input.claim()) return { status: "already_attempted", delivered: false };
    const target = await ready();
    if (!target) return { status: "not_ready", delivered: false };
    let status: "provider_accepted" | "outcome_unknown";
    try { await input.send(target); status = "provider_accepted"; }
    catch { status = "outcome_unknown"; }
    try { await input.finish(status); }
    catch { return { status: "outcome_unknown", delivered: false }; }
    return { status, delivered: false };
  };
}
