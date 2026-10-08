import { createHash, ECDH } from "node:crypto";
import { z } from "zod";
import webPush from "web-push";
import type { EscalationRecord } from "./escalation.js";

// Endpoints are supplied by browsers, not arbitrary URLs to fetch from Lambda.
// Exact provider hosts only; a custom push service requires a reviewed addition.
const providers = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
function validEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && providers.has(url.hostname) && !url.username && !url.password
      && !url.port && !url.hash && url.pathname.length > 1;
  } catch { return false; }
}
function base64Key(value: string, length: number) {
  return /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === length
    && Buffer.from(value, "base64url").toString("base64url") === value;
}
function publicPoint(value: string) {
  if (!base64Key(value, 65)) return false;
  try { ECDH.convertKey(Buffer.from(value, "base64url"), "prime256v1"); return true; } catch { return false; }
}
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(validEndpoint),
  expirationTime: z.number().int().nonnegative().nullable().optional(),
  keys: z.object({ p256dh: z.string().refine(publicPoint), auth: z.string().refine(value => base64Key(value, 16)) }).strict(),
}).strict();
export type KinPushSubscription = z.infer<typeof pushSubscriptionSchema>;
export const pushConsentVersion = "kin-on-duty-push-v1";
export const pushEnrollmentBody = z.object({ subscription: pushSubscriptionSchema,
  consent: z.literal(true), consentVersion: z.literal(pushConsentVersion) }).strict();
export const pushRemovalBody = z.object({ endpoint: z.string().max(2048).refine(validEndpoint) }).strict();
export const subscriptionId = (subscription: KinPushSubscription) => createHash("sha256")
  .update(JSON.stringify([subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth])).digest("hex");

export interface PushDestination { id: string; subscription: KinPushSubscription }
export interface PushDestinations {
  /** Must check the subscription owner's current membership, not just the roster. */
  forRecipient(memberId: string): Promise<PushDestination | null>;
  removeExpired(memberId: string, id: string): Promise<void>;
}
export function createWebPushPublisher(input: {
  destinations: PushDestinations;
  vapid: { subject: string; publicKey: string; privateKey: string };
  send?: typeof webPush.sendNotification;
}) {
  const send = input.send ?? webPush.sendNotification;
  return {
    async publish(record: EscalationRecord): Promise<{ messageId: string }> {
      if (!record.recipientMemberId) throw new Error("Push recipient unavailable");
      const target = await input.destinations.forRecipient(record.recipientMemberId);
      if (!target) throw new Error("Push recipient unavailable");
      const subscription = pushSubscriptionSchema.parse(target.subscription);
      const tag = createHash("sha256").update(record.id).digest("base64url").slice(0, 32);
      // No names, task text, URLs, tokens, or patient information on a lock screen.
      const payload = JSON.stringify({ version: 1, tag,
        title: "Kin · Family follow-up",
        body: "A check-in needs a follow-up. Open Kin to review it." });
      try {
        const result = await send(subscription, payload, {
          vapidDetails: input.vapid, TTL: 300, urgency: "normal", topic: tag, timeout: 5000,
        });
        if (result.statusCode < 200 || result.statusCode >= 300) throw new Error("Push not accepted");
        // This is a local provider-acceptance reference, not evidence of handset delivery.
        return { messageId: `webpush:${tag}:${target.id.slice(0, 16)}` };
      } catch (error) {
        const status = (error as { statusCode?: unknown } | null)?.statusCode;
        if (status === 404 || status === 410) await input.destinations.removeExpired(record.recipientMemberId, target.id);
        // WebPushError can include the secret endpoint and upstream response body.
        throw new Error("Push delivery unavailable");
      }
    },
  };
}
