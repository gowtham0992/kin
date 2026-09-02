import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { buildDemoSeed } from "../src/demo-seed.js";

const tableName = process.env.KIN_DYNAMODB_TABLE?.trim();
if (!tableName) throw new Error("KIN_DYNAMODB_TABLE is required");

const circleId = process.env.KIN_CIRCLE_ID?.trim() || "demo-family";
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const items = buildDemoSeed({ circleId });

let seeded = 0;
let preserved = 0;
for (const Item of items) {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      }),
    );
    seeded += 1;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      preserved += 1;
      continue;
    }
    throw error;
  }
}

console.log(`Seeded ${seeded} Kin records; preserved ${preserved} existing records for ${circleId}.`);
