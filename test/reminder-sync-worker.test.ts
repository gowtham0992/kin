import { expect, it } from "vitest";
import { createReminderSyncWorker } from "../src/reminder-sync-worker.js";

it("remains paused without any configured AWS resources", async () => {
  await expect(createReminderSyncWorker({})(() => 30_000)).resolves.toEqual({ enabled: false });
});
it("requires isolated configuration before activation", () => {
  expect(() => createReminderSyncWorker({ KIN_REMINDER_SYNC_WORKER_ENABLED: "true" })).toThrow("configuration incomplete");
  expect(() => createReminderSyncWorker({ KIN_REMINDER_SYNC_WORKER_ENABLED: "true", KIN_DYNAMODB_TABLE: "care", KIN_CIRCLE_ID: "circle",
    KIN_SKILL_MESSAGING_SECRET_ID: "kin/oauth" })).toThrow("configuration incomplete");
});
it("refuses to activate the sweep during single-receipt testing", () => {
  expect(() => createReminderSyncWorker({ KIN_REMINDER_SYNC_WORKER_ENABLED: "true", KIN_REMINDER_SINGLE_TEST_ENABLED: "true" }))
    .toThrow("Single reminder testing requires a paused sweep.");
});
