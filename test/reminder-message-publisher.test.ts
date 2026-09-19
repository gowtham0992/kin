import { describe, expect, it, vi } from "vitest";
import { createReminderMessagePublisher } from "../src/reminder-message-publisher.js";
import { createReminderCancellationReceiver, type ReminderCancellationJob } from "../src/echo-reminder-sync.js";

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
    expect(JSON.parse(String(init!.body))).toEqual({ data: { kind: "kin.reminder.cancel.v1", jobId: job.jobId }, expiresAfterSeconds: 60 });
    expect(init!.redirect).toBe("error");
    expect(String(init!.body)).not.toContain(job.alertToken);
    expect(job.state).toBe("pending");
  });
  it("keeps the last retained delivery plus a 30-second clock/transit margin within receiver freshness", async () => {
    const { publisher, request } = fixture();
    await publisher.publish(job);
    const message = JSON.parse(String(request.mock.calls[0]![1]!.body));
    const sentAt = 100_000;
    // This models a shared timing budget, not an observed Amazon delivery SLA.
    const receivedAt = sentAt + (message.expiresAfterSeconds + 30) * 1000;
    const jobs = { get: vi.fn().mockResolvedValue(job), complete: vi.fn() };
    const remove = vi.fn();
    const receive = createReminderCancellationReceiver(jobs, { remove }, () => receivedAt);
    await expect(receive(message.data, { userId: job.userId, endpoint: job.endpoint,
      apiAccessToken: "fresh-customer-token", timestamp: new Date(sentAt).toISOString() })).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledExactlyOnceWith(job.endpoint, "fresh-customer-token", job.alertToken);
    expect(jobs.complete).toHaveBeenCalledExactlyOnceWith(job);
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
  it("rechecks expiration and skips sub-second lifetime after obtaining a token", async () => {
    for (const afterToken of [900_000, 899_001]) {
      let time = 100_000;
      const request = vi.fn<typeof fetch>();
      const publisher = createReminderMessagePublisher({ fetch: request, now: () => time,
        accessToken: async () => { time = afterToken; return "token"; } });
      await expect(publisher.publish(job)).resolves.toBe("unchanged"); expect(request).not.toHaveBeenCalled();
    }
  });
  it("caps whole remaining seconds at 60 while the receiver still enforces job expiry", async () => {
    for (const [remainingMs, expectedSeconds] of [[1000, 1], [1999, 1], [12_999, 12],
      [59_999, 59], [60_000, 60], [60_999, 60], [61_000, 60], [300_000, 60]] as const) {
      const { publisher, request } = fixture();
      await publisher.publish({ ...job, expiresAt: 100_000 + remainingMs });
      expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).expiresAfterSeconds).toBe(expectedSeconds);
    }
    const { publisher, request } = fixture();
    const soon = { ...job, expiresAt: 112_999 };
    await publisher.publish(soon);
    const message = JSON.parse(String(request.mock.calls[0]![1]!.body));
    const jobs = { get: vi.fn().mockResolvedValue(soon), complete: vi.fn() }, remove = vi.fn();
    const receive = createReminderCancellationReceiver(jobs, { remove }, () => soon.expiresAt);
    await expect(receive(message.data, { userId: job.userId, endpoint: job.endpoint,
      apiAccessToken: "fresh-customer-token", timestamp: new Date(100_000).toISOString() })).rejects.toThrow("Reminder synchronization unavailable.");
    expect(remove).not.toHaveBeenCalled(); expect(jobs.complete).not.toHaveBeenCalled();
  });
  it("sanitizes token failures without sending a message", async () => {
    const { publisher, request, accessToken } = fixture();
    accessToken.mockRejectedValue(new Error("private-credential"));
    await expect(publisher.publish(job)).rejects.toThrow(/^Reminder synchronization unavailable\.$/);
    expect(request).not.toHaveBeenCalled();
  });
});
