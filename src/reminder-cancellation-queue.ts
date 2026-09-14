import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { reminderSyncConsent, reminderTicketHash } from "./reminder-tickets.js";
import type { ReminderCancellationJob } from "./echo-reminder-sync.js";

const receiptSchema = z.object({ entityType: z.literal("AcceptedPlanReminder"),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), userId: z.string().min(1).max(1024),
  endpoint: z.enum(["https://api.amazonalexa.com", "https://api.eu.amazonalexa.com", "https://api.fe.amazonalexa.com"]),
  alertToken: z.string().min(1).max(2048).refine(v => !/[\s\p{Cc}]/u.test(v)),
  taskId: z.string().min(1).max(100), dueAt: z.iso.datetime(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: z.number().int().nonnegative(),
});
const ticketSchema = z.object({ entityType: z.literal("ReminderTicket"), circleId: z.string(),
  consent: z.literal(reminderSyncConsent), taskId: z.string(), dueAt: z.string(), fingerprint: z.string(),
  issuedAt: z.number().int(), validUntil: z.number().int(), accessKey: z.string().regex(/^ACCESS#[a-f0-9]{64}$/), memberId: z.string().min(1) });

/** Joins a backend-issued consent ticket to a trusted Echo receipt. Never accepts
 * an Alexa user or reminder ID from a browser, MCP argument, or queue message. */
export function createReminderCancellationQueue(input: { careTable: string; receiptTable: string; queueTable: string; circleId: string;
  now?: () => number; client?: { send(command: GetCommand | TransactWriteCommand): Promise<unknown> } }) {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1,
    requestHandler: { connectionTimeout: 500, requestTimeout: 1500, throwOnRequestTimeout: true } }));
  if (!/^kin-echo-reminder-claims(?:-[a-z0-9-]+)?$/.test(input.receiptTable) || !/^kin-echo-reminder-sync(?:-[a-z0-9-]+)?$/.test(input.queueTable)) throw new Error("Isolated reminder tables required.");
  const get = async (table: string, key: Record<string, string>) => (await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  return { async enqueue(receiptId: string): Promise<{ state: "unchanged" | "queued"; jobId?: string }> {
    if (!/^[a-f0-9]{64}$/.test(receiptId)) throw new Error("Invalid reminder reference.");
    const receiptKey = { PK: `RECEIPT#${receiptId}` };
    const raw = await get(input.receiptTable, receiptKey);
    // Legacy one-time reminders have no synchronization consent.
    if (!raw || raw.ticket === undefined) return { state: "unchanged" };
    if (raw.PK !== receiptKey.PK) throw new Error("Reminder binding unavailable.");
    const receipt = receiptSchema.parse(raw), now = input.now?.() ?? Date.now();
    if (Date.parse(receipt.dueAt) <= now) return { state: "unchanged" };
    const ticketKey = { PK: `CIRCLE#${input.circleId}`, SK: `REMINDER_TICKET#${reminderTicketHash(receipt.ticket)}` };
    const rawTicket = await get(input.careTable, ticketKey);
    if (!rawTicket || rawTicket.PK !== ticketKey.PK || rawTicket.SK !== ticketKey.SK) throw new Error("Reminder binding unavailable.");
    const ticket = ticketSchema.parse(rawTicket);
    if (ticket.circleId !== input.circleId || ticket.taskId !== receipt.taskId || ticket.dueAt !== receipt.dueAt ||
        ticket.fingerprint !== receipt.fingerprint || receipt.acceptedAt < ticket.issuedAt || receipt.acceptedAt > ticket.validUntil) throw new Error("Reminder binding unavailable.");
    const taskKey = { PK: ticketKey.PK, SK: `TASK#${ticket.dueAt}#${ticket.taskId}` };
    const task = await get(input.careTable, taskKey);
    if (!task || task.PK !== taskKey.PK || task.SK !== taskKey.SK || task.entityType !== "CareTask" || task.id !== ticket.taskId || task.dueAt !== ticket.dueAt) throw new Error("Reminder task unavailable.");
    if (task.state === "scheduled") return { state: "unchanged" };
    if (!["done", "skipped", "cancelled"].includes(String(task.state))) throw new Error("Reminder task unavailable.");
    const jobId = createHash("sha256").update(JSON.stringify([receiptKey.PK, ticketKey.PK, ticketKey.SK])).digest("hex");
    const job: ReminderCancellationJob = { jobId, userId: receipt.userId, endpoint: receipt.endpoint,
      alertToken: receipt.alertToken, operation: "cancel", state: "pending", expiresAt: Date.parse(ticket.dueAt) };
    const jobKey = { PK: `CANCEL#${jobId}` };
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: input.receiptTable, Key: receiptKey,
          ConditionExpression: "entityType = :type AND ticket = :ticket AND userId = :user AND endpoint = :endpoint AND alertToken = :alert AND fingerprint = :fingerprint AND dueAt = :due AND taskId = :task AND acceptedAt = :accepted",
          ExpressionAttributeValues: { ":type": "AcceptedPlanReminder", ":ticket": receipt.ticket, ":user": receipt.userId,
            ":endpoint": receipt.endpoint, ":alert": receipt.alertToken, ":fingerprint": receipt.fingerprint,
            ":due": receipt.dueAt, ":task": receipt.taskId, ":accepted": receipt.acceptedAt } } },
        { ConditionCheck: { TableName: input.careTable, Key: ticketKey,
          ConditionExpression: "entityType = :type AND consent = :consent AND circleId = :circle AND taskId = :task AND dueAt = :due AND fingerprint = :fingerprint AND issuedAt = :issued AND validUntil = :valid",
          ExpressionAttributeValues: { ":type": "ReminderTicket", ":consent": reminderSyncConsent, ":circle": input.circleId,
            ":task": ticket.taskId, ":due": ticket.dueAt, ":fingerprint": ticket.fingerprint, ":issued": ticket.issuedAt, ":valid": ticket.validUntil } } },
        { ConditionCheck: { TableName: input.careTable, Key: taskKey,
          ConditionExpression: "entityType = :type AND id = :task AND dueAt = :due AND #state = :state",
          ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":type": "CareTask", ":task": ticket.taskId, ":due": ticket.dueAt, ":state": task.state } } },
        { Put: { TableName: input.queueTable, Item: { ...jobKey, entityType: "ReminderCancellation", ...job,
          ttl: Math.ceil(job.expiresAt / 1000) + 7 * 86400 }, ConditionExpression: "attribute_not_exists(PK)" } },
      ] }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
      const existing = await get(input.queueTable, jobKey);
      if (!existing || existing.PK !== jobKey.PK || existing.entityType !== "ReminderCancellation" ||
          Object.entries(job).some(([key, value]) => key === "state" ? !["pending", "completed"].includes(String(existing.state)) : existing[key] !== value)) throw error;
    }
    return { state: "queued", jobId };
  } };
}
