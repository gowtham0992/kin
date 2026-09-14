import { describe, expect, it, vi } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { createEchoReminderClient } from "../src/echo-reminders.js";
import { createDynamoReminderClaims } from "../src/echo-reminder-claims.js";

const endpoint = "https://api.amazonalexa.com", requestTime = "2026-09-13T12:00:00Z", dueAt = "2026-09-13T13:00:00Z";
describe("reminder lifecycle transport", () => {
  it("returns only the accepted ID, without extra provider fields", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ alertToken: "opaque/id", privateField: "excluded" }), { status: 201 }));
    expect(await createEchoReminderClient(fetcher).createCheckIn!(endpoint, "token", requestTime, dueAt)).toEqual({ alertToken: "opaque/id" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["", "{}", '{"alertToken":""}', "x".repeat(8193)])("does not invent an ID or retry an accepted POST with invalid receipt", async body => {
    const fetcher = vi.fn(async () => new Response(body, { status: 201 }));
    await expect(createEchoReminderClient(fetcher).createCheckIn!(endpoint, "token", requestTime, dueAt)).rejects.toThrow("receipt unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("updates only the encoded reminder ID, with generic speech and no push", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    await createEchoReminderClient(fetcher).updateCheckIn!(endpoint, "token", "opaque/id?query", requestTime, dueAt);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${endpoint}/v1/alerts/reminders/opaque%2Fid%3Fquery`);
    expect(options.method).toBe("PUT"); expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body as string)).toMatchObject({ trigger: { scheduledTime: dueAt }, pushNotification: { status: "DISABLED" } });
  });
  it.each([200, 404])("treats cancellation status %s as complete", async status => {
    const fetcher = vi.fn(async () => new Response(null, { status }));
    await createEchoReminderClient(fetcher).remove!(endpoint, "token", "known-id");
    expect(fetcher).toHaveBeenCalledOnce();
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ method: "DELETE", redirect: "error" });
  });
  it.each([401, 403, 429, 500])("fails closed on cancellation status %s without retry", async status => {
    const fetcher = vi.fn(async () => new Response("private upstream detail", { status }));
    await expect(createEchoReminderClient(fetcher).remove!(endpoint, "token", "known-id")).rejects.not.toThrow("private upstream detail");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects foreign hosts, blank IDs and past updates before any network call", async () => {
    const fetcher = vi.fn(); const client = createEchoReminderClient(fetcher);
    await expect(client.remove!("https://attacker.example", "token", "id")).rejects.toThrow();
    await expect(client.remove!(endpoint, "token", "")).rejects.toThrow();
    await expect(client.updateCheckIn!(endpoint, "token", "id", dueAt, requestTime)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("immutable reminder reference", () => {
  const receipt = { alertToken: "opaque-id", endpoint, userId: "synthetic-user", taskId: "task-a", dueAt,
    fingerprint: "b".repeat(64), acceptedAt: Date.parse(requestTime) };
  it("stores the accepted reference separately from the duplicate-prevention claim with bounded retention", async () => {
    const send = vi.fn(async (_command: PutCommand) => ({}));
    await createDynamoReminderClaims("kin-echo-reminder-claims", { send }).recordAccepted!("a".repeat(64), receipt);
    expect(send.mock.calls[0]![0].input).toEqual({ TableName: "kin-echo-reminder-claims",
      Item: { PK: `RECEIPT#${"a".repeat(64)}`, entityType: "AcceptedPlanReminder", ...receipt, expiresAt: Date.parse(dueAt) / 1000 + 7 * 86400 },
      ConditionExpression: "attribute_not_exists(PK)" });
  });
  it("never overwrites a reference and hides persistence details on failure", async () => {
    const send = vi.fn(async () => { throw new Error("private database detail"); });
    await expect(createDynamoReminderClaims("kin-echo-reminder-claims", { send }).recordAccepted!("a".repeat(64), receipt)).rejects.toThrow("Reminder reference could not be saved.");
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([{ apiAccessToken: "secret" }, { dueAt: requestTime }, { endpoint: "https://attacker.example" }])("rejects unexpected fields and invalid references %j", async patch => {
    const send = vi.fn();
    await expect(createDynamoReminderClaims("kin-echo-reminder-claims", { send }).recordAccepted!("a".repeat(64), { ...receipt, ...patch })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
