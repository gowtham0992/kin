import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { buildDemoSeed } from "../src/demo-seed.js";
import { writeDemoSeed } from "../src/demo-seed-writer.js";

const tableName = process.env.KIN_DYNAMODB_TABLE?.trim();
if (!tableName) throw new Error("KIN_DYNAMODB_TABLE is required");

const circleId = process.env.KIN_CIRCLE_ID?.trim() || "demo-family";
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 1 }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const items = buildDemoSeed({
  circleId,
  timeZone: process.env.KIN_TIME_ZONE?.trim() || "UTC",
});

const { seeded, preserved } = await writeDemoSeed(client, tableName, circleId, items);

console.log(`Seeded ${seeded} Kin records; preserved ${preserved} existing records for ${circleId}.`);
