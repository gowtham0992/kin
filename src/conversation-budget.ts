import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";

const identitySchema = z.object({
  circleId: z.string().min(1).max(100),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
}).strict();
export interface ConversationBudget {
  reserve(input: { circleId: string; memberId: string }): Promise<void>;
}
export class BudgetExceeded extends Error {
  readonly retryAfterSeconds = 60;
  constructor() { super("Natural-language requests are temporarily limited. Use an explicit command or try later."); this.name = "BudgetExceeded"; }
}
export class ConversationBudgetUnavailable extends Error {
  constructor() { super("Natural-language usage could not be reserved."); this.name = "ConversationBudgetUnavailable"; }
}

export function createDynamoConversationBudget(options: {
  tableName: string; region?: string; now?: () => Date;
  client?: { send(command: TransactWriteCommand, options: { abortSignal: AbortSignal }): Promise<unknown> };
}): ConversationBudget {
  const client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: options.region, maxAttempts: 1 }));
  const now = options.now ?? (() => new Date());
  return {
    async reserve(rawInput) {
      try {
        const input = identitySchema.parse(rawInput);
        const current = now(), currentMs = current.getTime();
        if (!Number.isFinite(currentMs)) throw new Error("Invalid clock");
        const date = current.toISOString().slice(0, 10);
        const identity = createHash("sha256").update(JSON.stringify([input.circleId, input.memberId])).digest("hex");
        const nextDay = Date.parse(`${date}T00:00:00.000Z`) + 86400000;
        // Every attempt is reserved atomically across Lambda instances. Failed/uncertain
        // calls are never refunded or retried automatically; overcounting fails safely.
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Update: {
              TableName: options.tableName,
              Key: { PK: `CONVERSATION_BUDGET#${identity}`, SK: `DAY#${date}` },
              UpdateExpression: "SET #attempts = if_not_exists(#attempts, :zero) + :one, expiresAt = :expiry, entityType = :type",
              ConditionExpression: "attribute_not_exists(#attempts) OR #attempts < :limit",
              ExpressionAttributeNames: { "#attempts": "attempts" },
              ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": 20,
                ":expiry": Math.floor(nextDay / 1000) + 7 * 86400, ":type": "ConversationBudget" },
            } },
            { Update: {
              TableName: options.tableName,
              Key: { PK: `CONVERSATION_BUDGET#${identity}`, SK: "COOLDOWN" },
              UpdateExpression: "SET nextAllowedAt = :next, expiresAt = :expiry, entityType = :type",
              ConditionExpression: "attribute_not_exists(nextAllowedAt) OR nextAllowedAt <= :now",
              ExpressionAttributeValues: { ":now": currentMs, ":next": currentMs + 10000,
                ":expiry": Math.floor((currentMs + 10000) / 1000) + 7 * 86400, ":type": "ConversationCooldown" },
            } },
          ],
        }), { abortSignal: AbortSignal.timeout(1000) });
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") {
          const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
          if (Array.isArray(reasons) && reasons.some(reason => reason?.Code === "ConditionalCheckFailed")) throw new BudgetExceeded();
        }
        throw new ConversationBudgetUnavailable();
      }
    },
  };
}
