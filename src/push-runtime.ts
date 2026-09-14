import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { createPushSubscriptions } from "./push-subscriptions.js";
import { createWebPushPublisher } from "./web-push.js";
import type { AlertPublisher, EscalationRecord } from "./escalation.js";

const secretSchema = z.object({
  subject: z.string().regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export function createConfiguredPushPublisher(environment: NodeJS.ProcessEnv): AlertPublisher {
  const secretArn = environment.KIN_WEB_PUSH_SECRET_ARN;
  if (!secretArn || !/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(secretArn)) {
    throw new Error("Push requires a configured secret ARN");
  }
  const client = new SecretsManagerClient({ region: environment.AWS_REGION, maxAttempts: 1 });
  const destinations = createPushSubscriptions({ tableName: environment.KIN_DYNAMODB_TABLE!, circleId: environment.KIN_CIRCLE_ID!, region: environment.AWS_REGION });
  let cached: { publisher: AlertPublisher; until: number } | undefined;
  return {
    async publish(record: EscalationRecord) {
      if (!cached || Date.now() >= cached.until) {
        const value = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
        const vapid = secretSchema.parse(JSON.parse(value.SecretString ?? "null"));
        if (vapid.publicKey !== environment.KIN_WEB_PUSH_PUBLIC_KEY) throw new Error("Push application key mismatch");
        cached = { publisher: createWebPushPublisher({ destinations, vapid }), until: Date.now() + 300_000 };
      }
      return cached.publisher.publish(record);
    },
  };
}
