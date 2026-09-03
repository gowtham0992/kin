import { randomUUID } from "node:crypto";
import { createDynamoCareRepository } from "../src/dynamo-care-repository.js";
import { runEscalationSweep } from "../src/escalation.js";
import { createSnsAlertPublisher } from "../src/sns-alert-publisher.js";

const tableName = requiredEnvironment("KIN_DYNAMODB_TABLE");
const topicArn = requiredEnvironment("KIN_ALERT_TOPIC_ARN");
const circleId = process.env.KIN_CIRCLE_ID?.trim() || "demo-family";
const region = process.env.AWS_REGION?.trim() || "us-east-1";
const timeZone = process.env.KIN_TIME_ZONE?.trim() || "UTC";
const now = resolveClock();
const repository = createDynamoCareRepository({
  tableName,
  circleId,
  region,
  now: () => now,
  timeZone,
});

const result = await runEscalationSweep({
  snapshot: await repository.escalationSnapshot(now),
  store: repository,
  publisher: createSnsAlertPublisher({ topicArn, region }),
  now,
  attemptId: randomUUID(),
});

const counts = result.records.reduce<Record<string, number>>((summary, record) => {
  summary[record.status] = (summary[record.status] ?? 0) + 1;
  return summary;
}, {});
console.log(JSON.stringify({ evaluatedAt: now.toISOString(), counts }));

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveClock(): Date {
  const override = process.env.KIN_SWEEP_AS_OF?.trim();
  if (!override) return new Date();
  if (process.env.KIN_DEMO_MODE !== "true") {
    throw new Error("KIN_SWEEP_AS_OF requires KIN_DEMO_MODE=true");
  }
  const date = new Date(override);
  if (!Number.isFinite(date.getTime())) throw new Error("KIN_SWEEP_AS_OF must be ISO-8601");
  return date;
}
