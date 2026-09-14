import { createHash, randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { careWriteCondition, type CareWriteAuthorization } from "./care-write-authorization.js";
import { FamilyAccessDeniedError } from "./membership.js";
import { taskReviewSchema } from "./task-review.js";

export const reminderSyncConsent = "kin-reminder-sync-v1";
export const reminderTicketInputSchema = z.object({ taskId: z.string().min(1).max(100), expected: taskReviewSchema,
  consent: z.literal(reminderSyncConsent) }).strict();
export type ReminderTicketInput = z.infer<typeof reminderTicketInputSchema>;
export interface ReminderTickets {
  issue(input: ReminderTicketInput, authorization: CareWriteAuthorization): Promise<{ ticket: string; expiresAt: number }>;
}
export const reminderTicketHash = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

/** A ticket is not an Alexa credential or an accepted reminder. Only the trusted
 * Echo receipt writer can join it to an Alexa user and accepted reminder ID. */
export function createDynamoReminderTickets(input: { tableName: string; circleId: string; now?: () => number;
  client?: { send(command: TransactWriteCommand, options: { abortSignal: AbortSignal }): Promise<unknown> } }): ReminderTickets {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
  return { async issue(raw, authorization) {
    const value = reminderTicketInputSchema.parse(raw), now = input.now?.() ?? Date.now();
    if (!authorization || authorization.member.role === "viewer") throw new FamilyAccessDeniedError();
    const guard = careWriteCondition(authorization, input.tableName, input.circleId);
    const due = Date.parse(value.expected.dueAt);
    if (value.expected.state !== "scheduled" || due <= now + 30_000 || due > now + 86400_000) throw new Error("Reminder task unavailable.");
    const ticket = randomBytes(32).toString("base64url"), PK = `CIRCLE#${input.circleId}`;
    const expiresAt = now + 90_000;
    await client.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: guard },
      { ConditionCheck: { TableName: input.tableName, Key: { PK, SK: `TASK#${value.expected.dueAt}#${value.taskId}` },
        ConditionExpression: "entityType = :type AND id = :id AND title = :title AND dueAt = :due AND #state = :state AND lastResponse = :response AND confirmedAt = :at AND confirmedBy = :by",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":type": "CareTask", ":id": value.taskId, ":title": value.expected.title,
          ":due": value.expected.dueAt, ":state": "scheduled", ":response": value.expected.lastResponse,
          ":at": value.expected.confirmedAt, ":by": value.expected.confirmedBy } } },
      { Put: { TableName: input.tableName, Item: { PK, SK: `REMINDER_TICKET#${reminderTicketHash(ticket)}`,
        entityType: "ReminderTicket", circleId: input.circleId, accessKey: authorization.key!.SK,
        memberId: authorization.member.memberId, taskId: value.taskId, dueAt: value.expected.dueAt,
        fingerprint: createHash("sha256").update(JSON.stringify(value.expected)).digest("hex"),
        consent: reminderSyncConsent, issuedAt: now, validUntil: expiresAt,
        expiresAt: Math.floor(due / 1000) + 7 * 86400 }, ConditionExpression: "attribute_not_exists(PK)" } },
    ] }), { abortSignal: AbortSignal.timeout(1000) });
    return { ticket, expiresAt };
  } };
}
