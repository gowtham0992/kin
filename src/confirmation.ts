import type { CareRepository, TodaySnapshot } from "./domain.js";
import { createHash } from "node:crypto";
import type { Membership } from "./membership.js";
import { taskReviewSchema, TaskReviewRequired } from "./task-review.js";
import type { CareWriteAuthorization } from "./care-write-authorization.js";
import { completionUndoBody, type CompletionUndoInput } from "./response-undo.js";
import { FamilyAccessDeniedError } from "./membership.js";
import { planPauseBody, type PlanPauseInput } from "./plan-pause.js";

const memberRequestId = (member: Membership, requestId: string) =>
  `member_${createHash("sha256").update(JSON.stringify([member.memberId, requestId])).digest("hex")}`;

export async function pausePlanWithReceipt(store: CareRepository, input: Omit<PlanPauseInput, "actor">,
  member: Membership | undefined, authorization: CareWriteAuthorization | undefined) {
  if (!member || !authorization || member.memberId !== authorization.member.memberId || member.role === "viewer") throw new FamilyAccessDeniedError();
  const parsed = planPauseBody.parse(input);
  const result = await store.acceptPlanPause({ ...parsed, actor: member.name, requestId: memberRequestId(member, parsed.requestId) }, authorization);
  await authorization.assertCurrent();
  return { ...result, receipt: { ...result.receipt, requestId: parsed.requestId },
    control: { ...result.control, ...(result.control.pause ? { pause: { ...result.control.pause, requestId: parsed.requestId } } : {}) } };
}

export async function undoCompletionWithReceipt(store: CareRepository, input: Omit<CompletionUndoInput, "actor">,
  member: Membership | undefined, authorization: CareWriteAuthorization | undefined) {
  // Undo is only available to an authenticated, currently authorized member.
  if (!member || !authorization || member.memberId !== authorization.member.memberId || member.role === "viewer") throw new FamilyAccessDeniedError();
  const parsed = completionUndoBody.parse(input);
  const result = await store.undoCompletion({ ...parsed, actor: member.name,
    requestId: memberRequestId(member, parsed.requestId), confirmationRequestId: memberRequestId(member, parsed.confirmationRequestId),
  }, authorization);
  await authorization.assertCurrent();
  return { ...result, undo: { ...result.undo, requestId: parsed.requestId, confirmationRequestId: parsed.confirmationRequestId } };
}

export async function confirmWithReceipt(
  store: CareRepository,
  input: Parameters<CareRepository["confirm"]>[0],
  member?: Membership,
  authorization?: CareWriteAuthorization,
) {
  // Internal signed-in callers must not bypass the same review boundary as HTTP/MCP.
  if (member && !taskReviewSchema.safeParse(input.expected).success) throw new TaskReviewRequired();
  // A committed write remains successful even if a follow-up view cannot load.
  const result = await store.confirm(member ? {
    ...input, actor: member.name,
    requestId: memberRequestId(member, input.requestId),
  } : input, authorization);
  if (authorization) await authorization.assertCurrent();
  let snapshot: TodaySnapshot | null = null;
  try {
    snapshot = await store.today();
  } catch {
    console.warn(JSON.stringify({ event: "kin.confirmation.snapshot_unavailable" }));
  }
  // Revocation can happen while a retry receipt or follow-up view is loading.
  // Keep this outside the best-effort snapshot catch: denial is not a refresh warning.
  if (authorization) await authorization.assertCurrent();
  return { ...result, confirmation: { ...result.confirmation, requestId: input.requestId }, snapshot, refreshRequired: snapshot === null };
}
