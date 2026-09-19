import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { createDynamoCareRepository } from "./dynamo-care-repository.js";
import { createPushSubscriptions } from "./push-subscriptions.js";
import { createWebPushPublisher } from "./web-push.js";
import { careLoopApprovalSchema, createCareLoopTest } from "./care-loop-test.js";

export async function runConfiguredCareLoopTest(environment: NodeJS.ProcessEnv, event: unknown) {
  // Independent, default-off acceptance gate. Never enable normal scheduled delivery here.
  if (environment.KIN_CARE_LOOP_TEST_ENABLED !== "true" || environment.KIN_ESCALATION_WORKER_ENABLED !== "false"
    || environment.KIN_WEB_PUSH_ENABLED !== "true") throw new Error("Care-loop test unavailable");
  const approval = careLoopApprovalSchema.parse(JSON.parse(environment.KIN_CARE_LOOP_TEST_APPROVAL ?? "null"));
  const config = z.object({ AWS_REGION: z.literal("us-east-1"), KIN_DYNAMODB_TABLE: z.string().min(3),
    KIN_CIRCLE_ID: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), KIN_TIME_ZONE: z.string().min(1),
    KIN_WEB_PUSH_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    KIN_WEB_PUSH_SECRET_ARN: z.string().regex(/^arn:aws:secretsmanager:us-east-1:\d{12}:secret:kin\/web-push-[A-Za-z0-9]+$/),
  }).parse(environment);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 }));
  const secrets = new SecretsManagerClient({ region: config.AWS_REGION, maxAttempts: 1 });
  const destinations = createPushSubscriptions({ tableName: config.KIN_DYNAMODB_TABLE, circleId: config.KIN_CIRCLE_ID, client: db });
  const repository = createDynamoCareRepository({ tableName: config.KIN_DYNAMODB_TABLE, circleId: config.KIN_CIRCLE_ID,
    region: config.AWS_REGION, timeZone: config.KIN_TIME_ZONE });
  try {
    return await createCareLoopTest({ approval, store: repository,
      snapshot: () => repository.escalationSnapshot(new Date()),
      target: () => destinations.forRecipient(approval.memberId),
      claim: async () => {
        try {
          await db.send(new PutCommand({ TableName: config.KIN_DYNAMODB_TABLE,
            Item: { PK: `CARE_LOOP_TEST#${approval.id}`, SK: "RECEIPT", status: "attempted",
              attemptedAt: new Date().toISOString() },
            ConditionExpression: "attribute_not_exists(PK)" }), { abortSignal: AbortSignal.timeout(5000) });
          return true;
        } catch (error) {
          if ((error as { name?: string })?.name === "ConditionalCheckFailedException") return false;
          throw new Error("Care-loop receipt unavailable");
        }
      },
      publish: async (record, target) => {
        const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.KIN_WEB_PUSH_SECRET_ARN }),
          { abortSignal: AbortSignal.timeout(5000) });
        const vapid = z.object({ subject: z.string().regex(/^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/),
          publicKey: z.literal(config.KIN_WEB_PUSH_PUBLIC_KEY), privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        }).strict().parse(JSON.parse(secret.SecretString ?? "null"));
        // Reuse the real privacy-safe follow-up transport, with a pinned destination.
        return createWebPushPublisher({ vapid, destinations: {
          forRecipient: async memberId => {
            if (memberId !== approval.memberId) return null;
            const current = await destinations.forRecipient(memberId);
            return current?.id === target.id && current.id === approval.subscriptionId ? current : null;
          },
          removeExpired: (memberId, id) => destinations.removeExpired(memberId, id),
        } }).publish(record);
      },
    })(event);
  } catch { throw new Error("Care-loop test unavailable; inspect before retrying"); }
  finally { db.destroy(); secrets.destroy(); }
}
