import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

const receiptSchema = z.object({
  alertToken: z.string().min(1).max(2048).refine(v => !/[\s\p{Cc}]/u.test(v)),
  endpoint: z.enum(["https://api.amazonalexa.com", "https://api.eu.amazonalexa.com", "https://api.fe.amazonalexa.com"]),
  userId: z.string().min(1).max(2048).refine(v => !/[\s\p{Cc}]/u.test(v)),
  taskId: z.string().min(1).max(100), dueAt: z.iso.datetime({ offset: true }),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: z.number().int().nonnegative(),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict();
export type AcceptedReminder = Omit<z.infer<typeof receiptSchema>, "endpoint"> & { endpoint: string };

export interface ReminderClaims {
  claim(key: string, preparedAt: number): Promise<boolean>;
  recordAccepted?(key: string, receipt: AcceptedReminder): Promise<void>;
}
interface Sender {
  send(command: PutCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
}

/** An immutable claim is NOT a delivery receipt. Never reclaim an uncertain POST. */
export function createDynamoReminderClaims(table: string, sender?: Sender): ReminderClaims {
  if (!/^kin-echo-reminder-claims(?:-[a-z0-9-]+)?$/.test(table)) throw new Error("A dedicated Kin reminder claim table is required.");
  const client = sender ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
  return {
    async recordAccepted(key, raw) {
      try {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid key");
        const receipt = receiptSchema.parse(raw);
        const due = Date.parse(receipt.dueAt);
        if (due <= receipt.acceptedAt || due - receipt.acceptedAt > 7 * 86400_000) throw new Error("Invalid time");
        // Separate immutable receipt: never overwrite or reclaim the POST fence.
        // No API token, family task title, or account-link credential is stored.
        await client.send(new PutCommand({ TableName: table,
          Item: { PK: `RECEIPT#${key}`, entityType: "AcceptedPlanReminder", ...receipt,
            expiresAt: Math.floor(due / 1000) + 7 * 86400 },
          ConditionExpression: "attribute_not_exists(PK)",
        }), { abortSignal: AbortSignal.timeout(1000) });
      } catch { throw new Error("Reminder reference could not be saved."); }
    },
    async claim(key, preparedAt) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(preparedAt) || preparedAt < 0) {
        throw new Error("Invalid reminder claim.");
      }
      try {
        await client.send(new PutCommand({ TableName: table,
          Item: { PK: key, preparedAt, expiresAt: Math.floor(preparedAt / 1000) + 86400 },
          ConditionExpression: "attribute_not_exists(PK)",
        }), { abortSignal: AbortSignal.timeout(1000) });
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        // Includes an uncertain database write: do not proceed to Alexa.
        throw new Error("Reminder claim unavailable.");
      }
    },
  };
}
