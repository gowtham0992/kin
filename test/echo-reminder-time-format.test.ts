import { expect, it, vi } from "vitest";
import { createEchoReminderClient } from "../src/echo-reminders.js";

it.each([
  ["2026-09-17T21:30:00-06:00", "2026-09-18T03:30:00.000"],
  ["2026-09-18T03:30:00.000Z", "2026-09-18T03:30:00.000"],
  ["2026-09-18T09:00:00+05:30", "2026-09-18T03:30:00.000"],
])("normalizes %s to Alexa's offset-free UTC scheduled time", async (dueAt, expected) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ alertToken: "synthetic" }), { status: 201 }));
  await createEchoReminderClient(fetcher).createCheckIn!("https://api.amazonalexa.com", "synthetic-token", "2026-09-18T03:00:00.000Z", dueAt);
  const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
  expect(body.trigger).toEqual({ type: "SCHEDULED_ABSOLUTE", scheduledTime: expected, timeZoneId: "Etc/UTC" });
  expect(Date.parse(body.trigger.scheduledTime + "Z")).toBe(Date.parse(dueAt));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses the same offset-free UTC encoding for reminder updates", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  await createEchoReminderClient(fetcher).updateCheckIn!("https://api.amazonalexa.com", "synthetic-token", "synthetic-alert", "2026-09-18T03:00:00.000Z", "2026-09-17T21:30:00-06:00");
  const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
  expect(body.trigger).toEqual({ type: "SCHEDULED_ABSOLUTE", scheduledTime: "2026-09-18T03:30:00.000", timeZoneId: "Etc/UTC" });
});
