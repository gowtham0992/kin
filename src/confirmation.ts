import type { CareRepository, TodaySnapshot } from "./domain.js";
import { createHash } from "node:crypto";
import type { Membership } from "./membership.js";

export async function confirmWithReceipt(
  store: CareRepository,
  input: Parameters<CareRepository["confirm"]>[0],
  member?: Membership,
) {
  // A committed write remains successful even if a follow-up view cannot load.
  const result = await store.confirm(member ? {
    ...input, actor: member.name,
    requestId: `member_${createHash("sha256").update(JSON.stringify([member.memberId, input.requestId])).digest("hex")}`,
  } : input);
  let snapshot: TodaySnapshot | null = null;
  try {
    snapshot = await store.today();
  } catch {
    console.warn(JSON.stringify({ event: "kin.confirmation.snapshot_unavailable" }));
  }
  return { ...result, confirmation: { ...result.confirmation, requestId: input.requestId }, snapshot, refreshRequired: snapshot === null };
}
