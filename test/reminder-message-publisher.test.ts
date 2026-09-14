import { describe, expect, it, vi } from "vitest";
import { createReminderMessagePublisher } from "../src/reminder-message-publisher.js";
import type { ReminderCancellationJob } from "../src/echo-reminder-sync.js";

const job: ReminderCancellationJob = { jobId: "a".repeat(64), userId: "amzn1.user/a?b", endpoint: "https://api.amazonalexa.com",
  alertToken: "private-reminder-id", operation: "cancel", state: "pending", expiresAt: 900_000 };
function fixture(status = 202) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
  const accessToken = vi.fn().mockResolvedValue("skill-token");
  return { request, accessToken, publisher: createReminderMessagePublisher({ fetch: request, accessToken, now: () => 100_000 }) };
}
describe("reminder message publisher", () => {
  it("queues only the job reference and does not claim cancellation", async () => {
    const { publisher, request } = fixture();
    await expect(publisher.publish(job)).resolves.toBe("accepted");
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://api.amazonalexa.com/v1/skillmessages/users/amzn1.user%2Fa%3Fb");
    expect(JSON.parse(String(init!.body))).toEqual({ data: { kind: "kin.reminder.cancel.v1", jobId: job.jobId }, expiresAfterSeconds: 300 });
    expect(init!.redirect).toBe("error");
    expect(String(init!.body)).not.toContain(job.alertToken);
    expect(job.state).toBe("pending");
  });
  it.each([200, 301, 400, 401, 429, 500])("rejects status %s without an internal retry", async status => {
    const { publisher, request } = fixture(status);
    await expect(publisher.publish(job)).rejects.toThrow("Reminder synchronization unavailable.");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...job, state: "completed" as const }, { ...job, expiresAt: 100_000 }])("does no I/O for completed or expired work", async value => {
    const { publisher, request, accessToken } = fixture();
    await expect(publisher.publish(value)).resolves.toBe("unchanged");
    expect(request).not.toHaveBeenCalled(); expect(accessToken).not.toHaveBeenCalled();
  });
  it("rejects an unapproved endpoint before obtaining credentials", async () => {
    const { publisher, request, accessToken } = fixture();
    await expect(publisher.publish({ ...job, endpoint: "https://api.eu.amazonalexa.com" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled(); expect(accessToken).not.toHaveBeenCalled();
  });
  it("rechecks expiration after obtaining a token", async () => {
    let time = 100_000;
    const request = vi.fn<typeof fetch>();
    const publisher = createReminderMessagePublisher({ fetch: request, now: () => time, accessToken: async () => { time = 900_000; return "token"; } });
    await expect(publisher.publish(job)).resolves.toBe("unchanged"); expect(request).not.toHaveBeenCalled();
  });
  it("limits delivery lifetime to the remaining reminder time", async () => {
    const { publisher, request } = fixture();
    await publisher.publish({ ...job, expiresAt: 112_999 });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).expiresAfterSeconds).toBe(12);
  });
  it("sanitizes token failures without sending a message", async () => {
    const { publisher, request, accessToken } = fixture();
    accessToken.mockRejectedValue(new Error("private-credential"));
    await expect(publisher.publish(job)).rejects.toThrow(/^Reminder synchronization unavailable\.$/);
    expect(request).not.toHaveBeenCalled();
  });
});
