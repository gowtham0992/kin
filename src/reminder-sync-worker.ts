import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createDynamoReminderCancellationJobs } from "./echo-reminder-sync.js";
import { createReminderCancellationQueue } from "./reminder-cancellation-queue.js";
import { createReminderMessagePublisher } from "./reminder-message-publisher.js";
import { createReminderReconciliation } from "./reminder-reconciliation.js";
import { createReminderReconciliationStore } from "./reminder-reconciliation-store.js";
import { createSkillMessagingToken } from "./skill-messaging-token.js";
import { createSingleReceiptCancellation, runSingleReminderTest, singleReminderTestKind } from "./reminder-single-receipt.js";

export function createReminderSyncWorker(environment: NodeJS.ProcessEnv) {
  // No client construction, secret read, or network request when paused.
  if (environment.KIN_REMINDER_SYNC_WORKER_ENABLED !== "true") return async (_remainingMs: () => number) => ({ enabled: false });
  if (environment.KIN_REMINDER_SINGLE_TEST_ENABLED === "true") throw new Error("Single reminder testing requires a paused sweep.");
  return createReminderReconciliation({ enabled: true, ...createReminderSyncDependencies(environment) });
}

function createReminderSyncDependencies(environment: NodeJS.ProcessEnv) {
  const receiptTable = environment.KIN_ECHO_REMINDER_CLAIMS_TABLE ?? "";
  const queueTable = environment.KIN_ECHO_REMINDER_SYNC_TABLE ?? "";
  const careTable = environment.KIN_DYNAMODB_TABLE ?? "";
  const circleId = environment.KIN_CIRCLE_ID ?? "";
  const secretId = environment.KIN_SKILL_MESSAGING_SECRET_ID;
  if (!careTable || !circleId || secretId !== "kin/alexa-skill-messaging") throw new Error("Reminder synchronization configuration incomplete.");
  const store = createReminderReconciliationStore({ receiptTable, queueTable });
  const queue = createReminderCancellationQueue({ receiptTable, queueTable, careTable, circleId });
  const jobs = createDynamoReminderCancellationJobs(queueTable);
  const secrets = new SecretsManagerClient({ maxAttempts: 1 });
  const accessToken = createSkillMessagingToken({ credentials: async () => {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), { abortSignal: AbortSignal.timeout(1500) });
    if (!response.SecretString || response.SecretString.length > 8192) throw new Error("Skill messaging credentials unavailable.");
    return JSON.parse(response.SecretString) as unknown;
  } });
  return { store, queue, jobs, publisher: createReminderMessagePublisher({ accessToken }) };
}

let worker: ReturnType<typeof createReminderSyncWorker> | undefined;
export async function handler(event: unknown, context: { getRemainingTimeInMillis(): number }) {
  try {
    if (typeof event === "object" && event !== null && "kind" in event && event.kind === singleReminderTestKind) {
      const report = await runSingleReminderTest(event, process.env, () => {
        const { store, ...dependencies } = createReminderSyncDependencies(process.env);
        return createSingleReceiptCancellation({ ...dependencies, dispatch: store });
      });
      console.info(JSON.stringify({ event: "kin_reminder_single_test", ...report }));
      return report;
    }
    worker ??= createReminderSyncWorker(process.env);
    const report = await worker(() => context.getRemainingTimeInMillis());
    console.info(JSON.stringify({ event: "kin_reminder_sync_sweep", ...report }));
    if ("failed" in report && report.failed) throw new Error("failed");
    return report;
  } catch {
    // No raw SDK/provider errors: those can include user IDs or credential material.
    throw new Error("Kin reminder synchronization sweep incomplete.");
  }
}
