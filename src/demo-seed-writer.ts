import { BatchGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { DemoSeedItem } from "./demo-seed.js";

/** Initial setup only. No independent puts or automatic replay after an uncertain commit. */
export async function writeDemoSeed(client: { send(command: BatchGetCommand | TransactWriteCommand): Promise<unknown> }, tableName: string, circleId: string, items: DemoSeedItem[]) {
  const PK = `CIRCLE#${circleId}`;
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) || !/^[A-Za-z0-9_-]{1,100}$/.test(circleId) ||
      !items.length || items.length > 98 || items.some(item => item.PK !== PK || !/^(?:MEMBER|TASK|DUTY)#.+$/.test(item.SK)) ||
      new Set(items.map(item => item.SK)).size !== items.length) throw new Error("Invalid initial seed scope");
  const keys = [...items.map(({ PK, SK }) => ({ PK, SK })), { PK, SK: "PLAN_CONTROL" }];
  const result = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } } })) as {
    Responses?: Record<string, Array<Record<string, unknown>>>; UnprocessedKeys?: Record<string, unknown>;
  };
  const rows = result.Responses?.[tableName];
  if (!Array.isArray(rows) || Object.keys(result.UnprocessedKeys ?? {}).length ||
      rows.some(row => row.PK !== PK || !keys.some(key => key.SK === row.SK)) || new Set(rows.map(row => row.SK)).size !== rows.length) {
    throw new Error("Could not read the complete initialization state; no seed was submitted");
  }
  if (rows.some(row => row.SK === "PLAN_CONTROL")) throw new Error("This circle is already initialized or has plan activity. Use the reviewed workspace; seeding is disabled");
  const missing = items.filter(item => !rows.some(row => row.SK === item.SK));
  if (!missing.length) return { seeded: 0, preserved: items.length };
  await client.send(new TransactWriteCommand({ TransactItems: [
    ...missing.map(Item => ({ Put: { TableName: tableName, Item,
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } })),
    { Put: { TableName: tableName, Item: { PK, SK: "PLAN_CONTROL", entityType: "PlanControl", version: 1 },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
  ] }));
  return { seeded: missing.length, preserved: items.length - missing.length };
}
