import { z } from "zod";
import type { EchoReminderClient } from "./echo-reminders.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export const reminderSyncMessageSchema = z.object({
  kind: z.literal("kin.reminder.cancel.v1"), jobId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const reminderCancellationJobSchema = z.object({
  jobId: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.string().min(1).max(1024),
  endpoint: z.enum(["https://api.amazonalexa.com", "https://api.eu.amazonalexa.com", "https://api.fe.amazonalexa.com"]),
  alertToken: z.string().min(1).max(2048).refine(value => !/[\s\p{Cc}]/u.test(value)),
  // Only a trusted plan-change producer can authorize this permanent cancellation.
  state: z.enum(["pending", "completed"]), operation: z.literal("cancel"),
  expiresAt: z.number().int().nonnegative(),
}).strict();
const jobSchema = reminderCancellationJobSchema;
export type ReminderCancellationJob = z.infer<typeof jobSchema>;
export interface ReminderCancellationJobs {
  get(jobId: string): Promise<ReminderCancellationJob | null>;
  complete(job: ReminderCancellationJob): Promise<void>;
}
export interface ReminderSyncContext { userId: string; endpoint: string; apiAccessToken: string; timestamp: string }
export class ReminderSyncUnavailable extends Error {
  constructor() { super("Reminder synchronization unavailable."); this.name = "ReminderSyncUnavailable"; }
}

/** Read/complete only. This adapter cannot authorize or enqueue jobs. */
export function createDynamoReminderCancellationJobs(tableName: string, supplied?: {
  send(command: GetCommand | UpdateCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
}): ReminderCancellationJobs {
  if (!/^kin-echo-reminder-sync(?:-[a-z0-9-]+)?$/.test(tableName)) throw new Error("An isolated reminder sync table is required.");
  const client = supplied ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
  const key = (jobId: string) => {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new ReminderSyncUnavailable();
    return { PK: `CANCEL#${jobId}` };
  };
  const get = async (jobId: string) => {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: key(jobId), ConsistentRead: true }),
      { abortSignal: AbortSignal.timeout(750) }) as { Item?: Record<string, unknown> };
    if (!result.Item) return null;
    const { PK, entityType, ttl, ...value } = result.Item;
    if (PK !== key(jobId).PK || entityType !== "ReminderCancellation") throw new ReminderSyncUnavailable();
    const job = jobSchema.parse(value);
    if (ttl !== undefined && ttl !== Math.ceil(job.expiresAt / 1000) + 7 * 86400) throw new ReminderSyncUnavailable();
    if (job.jobId !== jobId) throw new ReminderSyncUnavailable();
    return job;
  };
  return { get, async complete(rawJob) {
    const job = jobSchema.parse(rawJob);
    try {
      await client.send(new UpdateCommand({ TableName: tableName, Key: key(job.jobId),
        ConditionExpression: "entityType = :type AND jobId = :job AND #state = :pending AND #operation = :cancel AND userId = :user AND endpoint = :endpoint AND alertToken = :alert AND expiresAt = :expiry",
        UpdateExpression: "SET #state = :completed",
        ExpressionAttributeNames: { "#state": "state", "#operation": "operation" },
        ExpressionAttributeValues: { ":type": "ReminderCancellation", ":job": job.jobId, ":pending": "pending", ":completed": "completed",
          ":cancel": "cancel", ":user": job.userId, ":endpoint": job.endpoint, ":alert": job.alertToken, ":expiry": job.expiresAt },
      }), { abortSignal: AbortSignal.timeout(750) });
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
        const current = await get(job.jobId);
        if (current && current.state === "completed" && current.userId === job.userId && current.endpoint === job.endpoint &&
          current.alertToken === job.alertToken && current.expiresAt === job.expiresAt) return;
      }
      throw new ReminderSyncUnavailable();
    }
  } };
}

/** Cancellation-only receiver. Never accepts an operation, reminder ID or time from the message.
 * The durable job producer must verify circle membership, reminder ownership and sync consent.
 * Concurrent/repeated DELETE is safe; neither this path nor its retries create a reminder.
 */
export function createReminderCancellationReceiver(jobs: ReminderCancellationJobs,
  client: Pick<EchoReminderClient, "remove">, now: () => number = Date.now) {
  return async (rawMessage: unknown, context: ReminderSyncContext): Promise<void> => {
    try {
      const message = reminderSyncMessageSchema.parse(rawMessage);
      const time = now(), sentAt = Date.parse(context.timestamp);
      if (!Number.isFinite(sentAt) || sentAt > time + 30_000 || time - sentAt > 90_000) throw new Error("stale");
      const rawJob = await jobs.get(message.jobId);
      if (!rawJob) throw new Error("missing");
      const job = jobSchema.parse(rawJob);
      if (job.jobId !== message.jobId || job.userId !== context.userId || job.endpoint !== context.endpoint) throw new Error("binding");
      if (job.state === "completed") return;
      if (job.expiresAt <= now() || !client.remove) throw new Error("expired");
      await client.remove(context.endpoint, context.apiAccessToken, job.alertToken);
      // If the save fails, reject the event so it can retry the idempotent DELETE.
      // Provider acceptance must never be recorded before the provider responds.
      await jobs.complete(job);
    } catch { throw new ReminderSyncUnavailable(); }
  };
}
