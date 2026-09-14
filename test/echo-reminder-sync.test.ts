import { describe, expect, it, vi } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createEchoHandler } from "../src/echo-lambda.js";
import { createEchoReminderClient } from "../src/echo-reminders.js";
import { createDynamoReminderCancellationJobs, type ReminderCancellationJob } from "../src/echo-reminder-sync.js";

const skillId = "amzn1.ask.skill.a7cb5179-6d37-4fe3-bb53-f39193f67ed6";
const now = Date.parse("2026-09-13T20:00:00Z"), jobId = "a".repeat(64), endpoint = "https://api.amazonalexa.com";
const original: ReminderCancellationJob = { jobId, userId: "user-a", endpoint, alertToken: "owned-reminder",
  operation: "cancel", state: "pending", expiresAt: now + 3600_000 };
function fixture() {
  let row = { ...original };
  const jobs = { get: vi.fn(async () => ({ ...row })), complete: vi.fn(async () => { row.state = "completed"; }) };
  const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
  const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_REMINDER_SYNC_ENABLED: "true" },
    { reminderCancellationJobs: jobs, reminders: createEchoReminderClient(fetcher), now: () => now });
  const event = { version: "1.0", context: { System: { application: { applicationId: skillId },
    user: { userId: "user-a" }, apiEndpoint: endpoint, apiAccessToken: "synthetic-token" } },
    request: { type: "Messaging.MessageReceived", requestId: "synthetic-event", timestamp: new Date(now).toISOString(),
      message: { kind: "kin.reminder.cancel.v1", jobId } } };
  return { jobs, fetcher, handle, event, change: (patch: Partial<ReminderCancellationJob>) => { row = { ...row, ...patch }; } };
}
describe("Alexa background cancellation boundary", () => {
  it("resolves a queued job, deletes only its stored ID, records completion and stays silent", async () => {
    const f = fixture();
    expect(await f.handle(f.event)).toEqual({ version: "1.0", response: {} });
    expect(f.jobs.get).toHaveBeenCalledWith(jobId);
    expect((f.fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(`${endpoint}/v1/alerts/reminders/owned-reminder`);
    expect(f.jobs.complete).toHaveBeenCalledWith(original);
    await f.handle(f.event);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("retries a lost completion receipt as DELETE, never POST", async () => {
    const f = fixture(); f.jobs.complete.mockRejectedValueOnce(new Error("lost save"));
    await expect(f.handle(f.event)).rejects.toThrow("synchronization unavailable");
    f.fetcher.mockImplementation(async () => new Response(null, { status: 404 }));
    await f.handle(f.event);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    for (const call of f.fetcher.mock.calls) expect((call as unknown as [string, RequestInit])[1].method).toBe("DELETE");
  });
  it.each([{ userId: "another-user" }, { endpoint: "https://api.eu.amazonalexa.com" as const }, { jobId: "b".repeat(64) }, { expiresAt: now }])(
    "rejects wrong binding or expired work %j", async patch => {
      const f = fixture(); f.change(patch);
      await expect(f.handle(f.event)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    });
  it("rejects forged payload fields, stale messages and foreign skills before network access", async () => {
    const f = fixture();
    for (const event of [
      { ...f.event, request: { ...f.event.request, message: { ...f.event.request.message, alertToken: "someone-elses" } } },
      { ...f.event, request: { ...f.event.request, timestamp: new Date(now - 90_001).toISOString() } },
      { ...f.event, context: { System: { ...f.event.context.System, application: { applicationId: skillId.replace("a7cb", "b7cb") } } } },
      { ...f.event, session: { application: { applicationId: skillId } } },
    ]) await expect(f.handle(event)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("does not accept completion on a provider failure", async () => {
    const f = fixture(); f.fetcher.mockImplementation(async () => new Response("secret", { status: 403 }));
    await expect(f.handle(f.event)).rejects.toThrow("Reminder synchronization unavailable.");
    expect(f.jobs.complete).not.toHaveBeenCalled();
  });
  it("is off by default and cannot be enabled without its authorized store", async () => {
    const f = fixture();
    await expect(createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true" })(f.event)).rejects.toThrow();
    expect(() => createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_REMINDER_SYNC_ENABLED: "true" })).toThrow("authorized job store");
  });
});

describe("durable cancellation receipt", () => {
  it("uses a consistent key-bound read and conditional completion without creating a missing job", async () => {
    const send = vi.fn(async (command: GetCommand | UpdateCommand) => command instanceof GetCommand
      ? { Item: { PK: `CANCEL#${jobId}`, entityType: "ReminderCancellation", ...original } } : {});
    const jobs = createDynamoReminderCancellationJobs("kin-echo-reminder-sync", { send });
    expect(await jobs.get(jobId)).toEqual(original);
    await jobs.complete(original);
    expect(send.mock.calls[0]![0].input).toMatchObject({ ConsistentRead: true, Key: { PK: `CANCEL#${jobId}` } });
    expect(send.mock.calls[1]![0].input).toMatchObject({ UpdateExpression: "SET #state = :completed",
      ConditionExpression: expect.stringContaining("alertToken = :alert AND expiresAt = :expiry") });
  });
  it("accepts a concurrent completion only for the identical job binding", async () => {
    let row = { ...original, state: "completed" };
    const send = vi.fn(async (command: GetCommand | UpdateCommand) => {
      if (command instanceof UpdateCommand) throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
      return { Item: { PK: `CANCEL#${jobId}`, entityType: "ReminderCancellation", ...row } };
    });
    const jobs = createDynamoReminderCancellationJobs("kin-echo-reminder-sync", { send });
    await jobs.complete(original);
    row.userId = "another-user";
    await expect(jobs.complete(original)).rejects.toThrow();
  });
});
