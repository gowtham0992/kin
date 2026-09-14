import { reminderCancellationJobSchema, ReminderSyncUnavailable, type ReminderCancellationJob } from "./echo-reminder-sync.js";

/** Sends only a durable job reference. A 202 is queue acceptance, never cancellation proof.
 * The token supplier must use this skill's LWA skill-messaging credentials, not a family token.
 * This initial rollout deliberately supports the configured US region only.
 */
export function createReminderMessagePublisher(options: {
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  return { async publish(rawJob: ReminderCancellationJob): Promise<"accepted" | "unchanged"> {
    try {
      const job = reminderCancellationJobSchema.parse(rawJob);
      if (job.state === "completed" || job.expiresAt <= now()) return "unchanged";
      // Never forward an authorization header to a host taken verbatim from a record.
      if (job.endpoint !== "https://api.amazonalexa.com") throw new ReminderSyncUnavailable();
      const token = await options.accessToken();
      if (!token || token.length > 8192 || /[\s\p{Cc}]/u.test(token)) throw new ReminderSyncUnavailable();
      const remaining = Math.floor((job.expiresAt - now()) / 1000);
      if (remaining < 1) return "unchanged";
      const response = await request(`https://api.amazonalexa.com/v1/skillmessages/users/${encodeURIComponent(job.userId)}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(2500),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ data: { kind: "kin.reminder.cancel.v1", jobId: job.jobId },
          expiresAfterSeconds: Math.min(300, remaining) }),
      });
      // The response body is not needed, and must not leak provider diagnostics or identifiers.
      await response.body?.cancel();
      if (response.status !== 202) throw new ReminderSyncUnavailable();
      return "accepted";
    } catch { throw new ReminderSyncUnavailable(); }
  } };
}
