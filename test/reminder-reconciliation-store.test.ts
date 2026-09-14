import { expect, it, vi } from "vitest";
import { createReminderReconciliationStore } from "../src/reminder-reconciliation-store.js";

function fixture() {
  const send = vi.fn().mockResolvedValue({});
  return { send, store: createReminderReconciliationStore({ receiptTable: "kin-echo-reminder-claims", queueTable: "kin-echo-reminder-sync", client: { send } }) };
}
it("pages only the isolated table with a bounded, unfiltered projection", async () => {
  const { send, store } = fixture();
  send.mockResolvedValue({ Items: [{ PK: "CLAIM#a" }, { PK: "RECEIPT#b" }], LastEvaluatedKey: { PK: "RECEIPT#b" } });
  await expect(store.page("receipts", "previous", 25)).resolves.toEqual({ keys: ["CLAIM#a", "RECEIPT#b"], more: true });
  expect(send.mock.calls[0]![0].input).toEqual({ TableName: "kin-echo-reminder-claims", Limit: 25, ConsistentRead: true, ProjectionExpression: "PK", ExclusiveStartKey: { PK: "previous" } });
});
it("rejects a continuation that would skip unprocessed records", async () => {
  const { send, store } = fixture(); send.mockResolvedValue({ Items: [{ PK: "one" }], LastEvaluatedKey: { PK: "two" } });
  await expect(store.page("jobs", undefined, 25)).rejects.toThrow("Invalid reminder scan continuation.");
});
it("keeps an atomic dispatch lease separate from cancellation identity", async () => {
  const { send, store } = fixture();
  expect(await store.claimDispatch("a".repeat(64), 1000, 301000)).toBe(true);
  const input = send.mock.calls[0]![0].input;
  expect(input.Item).toEqual({ PK: `DISPATCH#${"a".repeat(64)}`, entityType: "ReminderDispatchLease", until: 301000, ttl: 86701 });
  expect(input.ConditionExpression).toContain("#until <= :now");
  expect(input.Item).not.toHaveProperty("state");
});
it("distinguishes contention from unavailable storage", async () => {
  const { send, store } = fixture();
  send.mockRejectedValue(Object.assign(new Error(), { name: "ConditionalCheckFailedException" }));
  expect(await store.claimDispatch("a".repeat(64), 1000, 2000)).toBe(false);
  send.mockRejectedValue(new Error("private-diagnostic"));
  await expect(store.claimDispatch("a".repeat(64), 1000, 2000)).rejects.toThrow(/^Reminder dispatch lease unavailable\.$/);
});
it("round-trips end-of-scan cursors without an undefined DynamoDB attribute", async () => {
  const { send, store } = fixture(); await store.saveCursor("jobs", undefined);
  const Item = send.mock.calls[0]![0].input.Item;
  expect(Item.after).toBe(null); send.mockResolvedValue({ Item });
  await expect(store.cursor("jobs")).resolves.toBeUndefined();
});
