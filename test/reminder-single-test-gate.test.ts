import { expect, it, vi } from "vitest";
import { runSingleReminderTest, singleReminderTestKind } from "../src/reminder-single-receipt.js";

const id = "a".repeat(64);
const environment = { KIN_REMINDER_SINGLE_TEST_ENABLED: "true", KIN_REMINDER_SINGLE_RECEIPT_ID: id, KIN_REMINDER_SYNC_WORKER_ENABLED: "false" };
const event = { kind: singleReminderTestKind, receiptId: id };
it.each([
  [{}, event],
  [{ ...environment, KIN_REMINDER_SINGLE_TEST_ENABLED: "false" }, event],
  [{ ...environment, KIN_REMINDER_SINGLE_TEST_ENABLED: "TRUE" }, event],
  [{ ...environment, KIN_REMINDER_SINGLE_RECEIPT_ID: undefined }, event],
  [{ ...environment, KIN_REMINDER_SYNC_WORKER_ENABLED: "true" }, event],
  [environment, { ...event, receiptId: "b".repeat(64) }],
  [environment, { ...event, kind: "other" }],
  [environment, { ...event, alertToken: "injected" }],
  [environment, null],
  [environment, { ...event, receiptId: "invalid" }],
])("rejects unauthorized test before dependency construction %#", async (env, input) => {
  const construct = vi.fn();
  await expect(runSingleReminderTest(input, env, construct)).rejects.toThrow("Single reminder test is not authorized.");
  expect(construct).not.toHaveBeenCalled();
});
it("runs only the configured receipt after explicit enablement", async () => {
  const run = vi.fn(async () => ({ state: "accepted" as const }));
  const construct = vi.fn(() => run);
  expect(await runSingleReminderTest(event, environment, construct)).toEqual({ state: "accepted" });
  expect(construct).toHaveBeenCalledTimes(1); expect(run.mock.calls).toEqual([[id]]);
});
