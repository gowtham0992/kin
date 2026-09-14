import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createMcpServer } from "../src/mcp.js";
import { createDemoStore, InMemoryCareStore, type TodaySnapshot } from "../src/domain.js";
import { createDynamoReminderTickets, reminderSyncConsent, reminderTicketHash } from "../src/reminder-tickets.js";
import { createReminderCancellationQueue } from "../src/reminder-cancellation-queue.js";
import { createDynamoReminderClaims } from "../src/echo-reminder-claims.js";
import { createDynamoReminderCancellationJobs } from "../src/echo-reminder-sync.js";
import { createEchoReminderClient } from "../src/echo-reminders.js";
import { createEchoHandler } from "../src/echo-lambda.js";
import { taskReview } from "../src/task-review.js";
import { createReminderMessagePublisher } from "../src/reminder-message-publisher.js";

const now = Date.parse("2026-09-13T20:00:00Z"), dueAt = "2026-09-13T21:00:00.000Z";
const PK = "CIRCLE#family-a", careTable = "care", receiptTable = "kin-echo-reminder-claims", queueTable = "kin-echo-reminder-sync";
const skillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
const task = { id: "walk", title: "Private title", dueAt, state: "scheduled" as const, lastResponse: null, confirmedAt: null, confirmedBy: null };
const authorization = { member: { circleId: "family-a", memberId: "parent", name: "Parent", role: "care_recipient" as const, status: "active" as const },
  key: { PK, SK: `ACCESS#${"a".repeat(64)}` }, assertCurrent: async () => {} };
function database() {
  const rows = new Map<string, Record<string, unknown>>();
  const id = (table: string, key: Record<string, unknown>) => `${table}:${key.PK}:${key.SK ?? ""}`;
  const send = vi.fn(async (command: GetCommand | PutCommand | TransactWriteCommand | UpdateCommand): Promise<any> => {
    const value = command.input;
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(id(command.input.TableName!, command.input.Key!))) };
    if (command instanceof PutCommand) { rows.set(id(command.input.TableName!, command.input.Item!), structuredClone(command.input.Item!)); return {}; }
    if (command instanceof UpdateCommand) { rows.get(id(command.input.TableName!, command.input.Key!))!.state = "completed"; return {}; }
    for (const item of command.input.TransactItems ?? []) {
      if (item.Put) {
        const key = id(item.Put.TableName!, item.Put.Item!);
        if (rows.has(key)) throw Object.assign(new Error("existing"), { name: "TransactionCanceledException" });
        rows.set(key, structuredClone(item.Put.Item!));
      }
    }
    return {};
  });
  const putTask = (state: string) => rows.set(id(careTable, { PK, SK: `TASK#${dueAt}#walk` }), { ...task, state, PK, SK: `TASK#${dueAt}#walk`, entityType: "CareTask" });
  putTask("scheduled"); return { rows, send, putTask };
}
describe("consented reminder binding through MCP, Echo and cancellation", () => {
  it("queues cancellation at the original key after a real one-off reschedule without creating a new reminder", async () => {
    const store = new InMemoryCareStore([task], () => new Date(now));
    const moved = await store.changeTask({ taskId: task.id, action: "reschedule", dueAt: "2026-09-13T22:00:00.000Z",
      expected: { title: task.title, dueAt: task.dueAt }, actor: "Maya", requestId: "reviewed-reschedule", confirm: true });
    const original = (await store.activityBetween({ startDate: "2026-09-13", endDate: "2026-09-13" })).tasks.find(value => value.id === task.id)!;
    const receiptId = "b".repeat(64), ticket = "t".repeat(43), fingerprint = "c".repeat(64);
    const db = database();
    db.rows.set(`${careTable}:${PK}:TASK#${dueAt}#${task.id}`, { ...original, PK, SK: `TASK#${dueAt}#${task.id}`, entityType: "CareTask" });
    db.rows.set(`${receiptTable}:RECEIPT#${receiptId}:`, { PK: `RECEIPT#${receiptId}`, entityType: "AcceptedPlanReminder", ticket,
      userId: "synthetic-user", endpoint: "https://api.amazonalexa.com", alertToken: "old-reminder", taskId: task.id, dueAt, fingerprint, acceptedAt: now - 1000 });
    const ticketSK = `REMINDER_TICKET#${reminderTicketHash(ticket)}`;
    db.rows.set(`${careTable}:${PK}:${ticketSK}`, { PK, SK: ticketSK, entityType: "ReminderTicket", circleId: "family-a", consent: reminderSyncConsent,
      taskId: task.id, dueAt, fingerprint, issuedAt: now - 2000, validUntil: now, accessKey: `ACCESS#${"a".repeat(64)}`, memberId: "parent" });
    const queue = createReminderCancellationQueue({ careTable, receiptTable, queueTable, circleId: "family-a", client: db, now: () => now });
    expect(await queue.enqueue(receiptId)).toMatchObject({ state: "queued" });
    const command = db.send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)![0] as TransactWriteCommand;
    expect(command.input.TransactItems![2]!.ConditionCheck!.Key).toEqual({ PK, SK: `TASK#${dueAt}#${task.id}` });
    expect(command.input.TransactItems![3]!.Put!.Item).toMatchObject({ operation: "cancel", alertToken: "old-reminder" });
    expect(JSON.stringify(command.input)).not.toContain(moved.replacement!.taskId);
  });

  it("joins the real service layers and cancels only after the stored task is terminal", async () => {
    const db = database();
    const tickets = createDynamoReminderTickets({ tableName: careTable, circleId: "family-a", client: db, now: () => now });
    const server = createMcpServer(createDemoStore(), undefined, authorization.member, authorization, tickets);
    const client = new Client({ name: "reminder-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      const snapshot: TodaySnapshot = { date: "2026-09-13", tasks: [task], onDuty: null, escalations: [], summary: { total: 1, completed: 0, remaining: 1, skipped: 0 } };
      const care = { today: async () => snapshot, confirm: vi.fn(), prepareReminder: async (_token: string, input: any) => {
        const result = await client.callTool({ name: "prepare_plan_reminder", arguments: input });
        expect(result.isError).toBeFalsy(); return result.structuredContent as { ticket: string; expiresAt: number };
      } };
      const fetcher = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => options?.method === "POST"
        ? new Response(JSON.stringify({ alertToken: "alexa-owned-id" }), { status: 201 }) : new Response(null, { status: 200 }));
      const reminders = createEchoReminderClient(fetcher), jobs = createDynamoReminderCancellationJobs(queueTable, db);
      const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true",
        KIN_ECHO_REMINDER_TEST_ENABLED: "true", KIN_ECHO_PLAN_CANCEL_SYNC_ENABLED: "true", KIN_ECHO_REMINDER_SYNC_ENABLED: "true" },
      { care, reminders, reminderClaims: createDynamoReminderClaims(receiptTable, db), reminderCancellationJobs: jobs, now: () => now });
      const system = { application: { applicationId: skillId }, apiEndpoint: "https://api.amazonalexa.com", apiAccessToken: "alexa-token",
        user: { userId: "alexa-user", accessToken: "kin-token" } };
      const event = (name: string, attributes: object = {}) => ({ version: "1.0", context: { System: system },
        session: { new: false, sessionId: "session", application: system.application, attributes },
        request: { type: "IntentRequest", requestId: name, timestamp: new Date(now).toISOString(), locale: "en-US", intent: { name } } });
      const proposal = await handle(event("NextCheckInReminderIntent"));
      expect(JSON.stringify(proposal)).toContain("request cancellation"); expect(fetcher).not.toHaveBeenCalled();
      expect([...db.rows.values()].some(row => row.entityType === "ReminderTicket")).toBe(false);
      await handle(event("AMAZON.YesIntent", proposal.sessionAttributes));
      const receipt = [...db.rows.values()].find(row => row.entityType === "AcceptedPlanReminder")!;
      expect(receipt.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify([...db.rows.values()])).not.toContain("kin-token");
      const queue = createReminderCancellationQueue({ careTable, receiptTable, queueTable, circleId: "family-a", client: db, now: () => now });
      const receiptId = String(receipt.PK).slice("RECEIPT#".length);
      expect(await queue.enqueue(receiptId)).toEqual({ state: "unchanged" });
      db.putTask("cancelled");
      const queued = await queue.enqueue(receiptId); expect(queued.state).toBe("queued");
      const messagingFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
      const publisher = createReminderMessagePublisher({ accessToken: async () => "skill-messaging-token", fetch: messagingFetch, now: () => now });
      await expect(publisher.publish((await jobs.get(queued.jobId!))!)).resolves.toBe("accepted");
      expect((await jobs.get(queued.jobId!))?.state).toBe("pending");
      const published = JSON.parse(String(messagingFetch.mock.calls[0]![1]!.body));
      expect(published.data).toEqual({ kind: "kin.reminder.cancel.v1", jobId: queued.jobId });
      // Documented out-of-session envelope can omit application and locale.
      const { application: _application, ...backgroundSystem } = system;
      const response = await handle({ version: "1.0", context: { System: backgroundSystem }, request: {
        type: "Messaging.MessageReceived", requestId: "background", timestamp: new Date(now).toISOString(),
        message: published.data } });
      expect(response).toEqual({ version: "1.0", response: {} });
      expect(fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "DELETE"]);
      expect((await jobs.get(queued.jobId!))?.state).toBe("completed");
      expect(await queue.enqueue(receiptId)).toEqual(queued);
    } finally { await client.close(); await server.close(); }
  });
  it("refuses tickets without write-capable membership or explicit current consent", async () => {
    const db = database(), service = createDynamoReminderTickets({ tableName: careTable, circleId: "family-a", client: db, now: () => now });
    const input = { taskId: task.id, expected: taskReview(task), consent: reminderSyncConsent } as const;
    await expect(service.issue(input, { ...authorization, member: { ...authorization.member, role: "viewer" } })).rejects.toThrow();
    await expect(service.issue({ ...input, consent: "forged" as typeof reminderSyncConsent }, authorization)).rejects.toThrow();
    await expect(service.issue(input, { ...authorization, key: { ...authorization.key, PK: "CIRCLE#other" } })).rejects.toThrow();
    expect(db.send).not.toHaveBeenCalled();
  });
  it("stores only a ticket hash and fences both reviewed task and membership in the transaction", async () => {
    const db = database();
    const result = await createDynamoReminderTickets({ tableName: careTable, circleId: "family-a", client: db, now: () => now })
      .issue({ taskId: task.id, expected: taskReview(task), consent: reminderSyncConsent }, authorization);
    expect(JSON.stringify([...db.rows.values()])).not.toContain(result.ticket);
    expect(JSON.stringify([...db.rows.values()])).toContain(reminderTicketHash(result.ticket));
    const command = db.send.mock.calls[0]![0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.ConditionCheck?.Key).toEqual(authorization.key);
    expect(command.input.TransactItems?.[1]?.ConditionCheck?.ConditionExpression).toContain("confirmedBy = :by");
  });
});
