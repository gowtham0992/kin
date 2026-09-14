import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { ReminderLane, ReminderReconciliationStore } from "./reminder-reconciliation.js";

export function createReminderReconciliationStore(options: {
  receiptTable: string; queueTable: string;
  client?: { send(command: GetCommand | PutCommand | ScanCommand, options: { abortSignal: AbortSignal }): Promise<unknown> };
}): ReminderReconciliationStore {
  if (!/^kin-echo-reminder-claims(?:-[a-z0-9-]+)?$/.test(options.receiptTable) ||
      !/^kin-echo-reminder-sync(?:-[a-z0-9-]+)?$/.test(options.queueTable)) throw new Error("Isolated reminder tables required.");
  const client: NonNullable<typeof options.client> = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
  const send = (command: GetCommand | PutCommand | ScanCommand) => client.send(command, { abortSignal: AbortSignal.timeout(1500) });
  const laneKey = (lane: ReminderLane) => {
    if (lane !== "receipts" && lane !== "jobs") throw new Error("Invalid reminder lane.");
    return `CURSOR#${lane}`;
  };
  const scanKey = (value: unknown): string => {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\p{Cc}]/u.test(value)) throw new Error("Invalid reminder scan key.");
    return value;
  };
  return {
    async cursor(lane) {
      const key = laneKey(lane);
      const result = await send(new GetCommand({ TableName: options.queueTable, Key: { PK: key }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      if (!result.Item) return undefined;
      if (result.Item.PK !== key || result.Item.entityType !== "ReminderScanCursor") throw new Error("Invalid reminder cursor.");
      return result.Item.after === null ? undefined : scanKey(result.Item.after);
    },
    async page(lane, after, limit) {
      laneKey(lane);
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Invalid reminder page size.");
      const result = await send(new ScanCommand({ TableName: lane === "receipts" ? options.receiptTable : options.queueTable,
        Limit: limit, ConsistentRead: true, ProjectionExpression: "PK",
        ...(after === undefined ? {} : { ExclusiveStartKey: { PK: scanKey(after) } }),
      })) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      const keys = (result.Items ?? []).map(item => scanKey(item.PK));
      // No filter, and these isolated tables have only a partition key. Preserve DynamoDB's
      // order so the final processed key is a valid ExclusiveStartKey after partial work.
      const last = result.LastEvaluatedKey;
      if (last && Object.keys(last).length && scanKey(last.PK) !== keys.at(-1)) throw new Error("Invalid reminder scan continuation.");
      return { keys, more: !!last && Object.keys(last).length > 0 };
    },
    async saveCursor(lane, after) {
      await send(new PutCommand({ TableName: options.queueTable,
        Item: { PK: laneKey(lane), entityType: "ReminderScanCursor", after: after === undefined ? null : scanKey(after) } }));
    },
    async claimDispatch(jobId, now, until) {
      if (!/^[a-f0-9]{64}$/.test(jobId) || !Number.isSafeInteger(now) || now < 0 ||
          !Number.isSafeInteger(until) || until <= now || until - now > 300_000) throw new Error("Invalid reminder dispatch lease.");
      try {
        await send(new PutCommand({ TableName: options.queueTable,
          Item: { PK: `DISPATCH#${jobId}`, entityType: "ReminderDispatchLease", until, ttl: Math.ceil(until / 1000) + 86400 },
          ConditionExpression: "attribute_not_exists(PK) OR (entityType = :type AND #until <= :now)",
          ExpressionAttributeNames: { "#until": "until" },
          ExpressionAttributeValues: { ":type": "ReminderDispatchLease", ":now": now },
        }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
        throw new Error("Reminder dispatch lease unavailable.");
      }
    },
  };
}
