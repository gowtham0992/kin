import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import webPush from "web-push";
import { z } from "zod";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import { createPushSubscriptions } from "./push-subscriptions.js";
import { pushSubscriptionSchema } from "./web-push.js";
import { createPushTest, pushTestApprovalSchema } from "./push-test.js";

export async function runConfiguredPushTest(environment: NodeJS.ProcessEnv, event: unknown) {
  // Explicit opt-in independent of the scheduler flag; disabled before client construction.
  if (environment.KIN_PUSH_TEST_ENABLED !== "true" || environment.KIN_ESCALATION_WORKER_ENABLED !== "false"
    || environment.KIN_WEB_PUSH_ENABLED !== "true") throw new Error("Push test unavailable");
  const approval = pushTestApprovalSchema.parse(JSON.parse(environment.KIN_PUSH_TEST_APPROVAL ?? "null"));
  const config = z.object({ AWS_REGION: z.literal("us-east-1"), KIN_DYNAMODB_TABLE: z.string().min(3),
    KIN_CIRCLE_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), KIN_TIME_ZONE: z.string().min(1),
    KIN_WEB_PUSH_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    KIN_WEB_PUSH_SECRET_ARN: z.string().regex(/^arn:aws:secretsmanager:us-east-1:\d{12}:secret:kin\/web-push-[A-Za-z0-9]+$/),
  }).parse(environment);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 }));
  const secretClient = new SecretsManagerClient({ region: config.AWS_REGION, maxAttempts: 1 });
  const destinations = createPushSubscriptions({ tableName: config.KIN_DYNAMODB_TABLE, circleId: config.KIN_CIRCLE_ID, client: db });
  const repository = createDynamoCareRepository({ tableName: config.KIN_DYNAMODB_TABLE, circleId: config.KIN_CIRCLE_ID,
    region: config.AWS_REGION, timeZone: config.KIN_TIME_ZONE });
  const key = { PK: `PUSH_TEST#${approval.id}`, SK: "RECEIPT" };
  try {
    return await createPushTest({ approval,
      target: () => destinations.forRecipient(approval.memberId),
      onDuty: async () => (await repository.today()).onDuty?.memberId === approval.memberId,
      claim: async () => {
        try {
          await db.send(new PutCommand({ TableName: config.KIN_DYNAMODB_TABLE,
            Item: { ...key, status: "attempted", attemptedAt: new Date().toISOString() },
            ConditionExpression: "attribute_not_exists(PK)" }), { abortSignal: AbortSignal.timeout(5000) });
          return true;
        } catch (error) {
          if ((error as { name?: string })?.name === "ConditionalCheckFailedException") return false;
          throw new Error("Push test receipt unavailable");
        }
      },
      finish: async status => {
        await db.send(new UpdateCommand({ TableName: config.KIN_DYNAMODB_TABLE, Key: key,
          UpdateExpression: "SET #status = :status", ConditionExpression: "#status = :attempted",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": status, ":attempted": "attempted" } }), { abortSignal: AbortSignal.timeout(5000) });
      },
      send: async target => {
        const secret = await secretClient.send(new GetSecretValueCommand({ SecretId: config.KIN_WEB_PUSH_SECRET_ARN }),
          { abortSignal: AbortSignal.timeout(5000) });
        const vapid = z.object({ subject: z.string().regex(/^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/),
          publicKey: z.literal(config.KIN_WEB_PUSH_PUBLIC_KEY), privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        }).strict().parse(JSON.parse(secret.SecretString ?? "null"));
        const tag = createHash("sha256").update(approval.id).digest("base64url").slice(0, 32);
        const result = await webPush.sendNotification(pushSubscriptionSchema.parse(target.subscription),
          JSON.stringify({ version: 1, kind: "connection_test", tag, title: "Kin · Test notification",
            body: "Your Kin phone connection test. No care action is needed." }),
          { vapidDetails: vapid, TTL: 60, urgency: "normal", topic: tag, timeout: 5000 });
        if (result.statusCode < 200 || result.statusCode >= 300) throw new Error("Push not accepted");
      },
    })(event);
  } catch { throw new Error("Push test unavailable; inspect before retrying"); }
  finally { db.destroy(); secretClient.destroy(); }
}
