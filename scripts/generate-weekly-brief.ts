import { createDynamoCareRepository } from "../src/dynamo-care-repository.js";
import {
  createBedrockBriefGenerator,
  WeeklyBriefService,
} from "../src/weekly-brief.js";

const tableName = requiredEnvironment("KIN_DYNAMODB_TABLE");
const modelId = requiredEnvironment("KIN_BEDROCK_MODEL_ID");
const circleId = process.env.KIN_CIRCLE_ID?.trim() || "demo-family";
const region = process.env.AWS_REGION?.trim() || "us-east-1";
const timeZone = process.env.KIN_TIME_ZONE?.trim() || "UTC";
const repository = createDynamoCareRepository({ tableName, circleId, region, timeZone });
const service = new WeeklyBriefService(
  repository,
  createBedrockBriefGenerator({ modelId, region,
    timeoutMs: process.env.KIN_BEDROCK_TIMEOUT_MS === undefined ? undefined : Number(process.env.KIN_BEDROCK_TIMEOUT_MS) }),
  timeZone,
);

console.log(JSON.stringify(await service.create(), null, 2));

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
