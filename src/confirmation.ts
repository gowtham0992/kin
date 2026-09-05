import type { CareRepository, TodaySnapshot } from "./domain.js";

export async function confirmWithReceipt(
  store: CareRepository,
  input: Parameters<CareRepository["confirm"]>[0],
) {
  // A committed write remains successful even if a follow-up view cannot load.
  const result = await store.confirm(input);
  let snapshot: TodaySnapshot | null = null;
  try {
    snapshot = await store.today();
  } catch {
    console.warn(JSON.stringify({ event: "kin.confirmation.snapshot_unavailable" }));
  }
  return { ...result, snapshot, refreshRequired: snapshot === null };
}
