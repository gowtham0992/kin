import { createHash } from "node:crypto";
import type { HandlerInput, RequestHandler } from "ask-sdk-core";
import { z } from "zod";
import type { ReminderClaims } from "./echo-reminder-claims.js";
import { EchoCareError, type EchoCareClient } from "./echo-care-client.js";
import { taskReview } from "./task-review.js";
import { createEchoTimeFormatter } from "./echo-time.js";
import { taskReviewSchema } from "./task-review.js";
import { reminderSyncConsent } from "./reminder-tickets.js";
import type { CareTask } from "./domain.js";

export const reminderText = "This is your Kin test reminder. Whenever you are ready, say Alexa, open kin family.";
const permission = "alexa::alerts:reminders:skill:readwrite";
const endpoints = new Set(["https://api.amazonalexa.com", "https://api.eu.amazonalexa.com", "https://api.fe.amazonalexa.com"]);
class ReminderPermissionError extends Error {}
export interface EchoReminderClient {
  createTest(endpoint: string, token: string, requestTime: string): Promise<void>;
  createCheckIn?(endpoint: string, token: string, requestTime: string, dueAt: string): Promise<{ alertToken: string } | void>;
  updateCheckIn?(endpoint: string, token: string, alertToken: string, requestTime: string, dueAt: string): Promise<void>;
  remove?(endpoint: string, token: string, alertToken: string): Promise<void>;
}
const alertTokenSchema = z.string().min(1).max(2048).refine(value => !/[\s\p{Cc}]/u.test(value));
function validateAccess(endpoint: string, token: string) {
  if (!endpoints.has(endpoint) || !token || token.length > 16384 || /\s/.test(token)) throw new Error("Invalid reminder request.");
}
function reminderBody(requestTime: string, dueAt?: string) {
  if (!z.iso.datetime({ offset: true }).safeParse(requestTime).success ||
      (dueAt !== undefined && (!z.iso.datetime({ offset: true }).safeParse(dueAt).success || Date.parse(dueAt) <= Date.parse(requestTime)))) throw new Error("Invalid reminder time.");
  // Alexa's supported scheduledTime formats omit the offset. Normalize the
  // instant to UTC first, then pair the offset-free clock with its explicit zone.
  // Keep stored dueAt and requestTime unchanged.
  return { requestTime, trigger: dueAt ? { type: "SCHEDULED_ABSOLUTE", scheduledTime: new Date(dueAt).toISOString().slice(0, -1), timeZoneId: "Etc/UTC" } : { type: "SCHEDULED_RELATIVE", offsetInSeconds: 120 },
    alertInfo: { spokenInfo: { content: [{ locale: "en-US", text: dueAt ? "It is time for your Kin check-in. Whenever you are ready, say Alexa, open kin family." : reminderText }] } },
    pushNotification: { status: "DISABLED" } };
}
async function acceptedToken(response: Response): Promise<{ alertToken: string }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Reminder receipt unavailable.");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 8192) throw new Error("oversized");
      chunks.push(part.value);
    }
    const result = z.object({ alertToken: alertTokenSchema }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return result;
  } catch { throw new Error("Reminder receipt unavailable."); }
  finally { await reader.cancel().catch(() => {}); }
}

// Bounded, parent-approved one-time reminders, not a recurring plan scheduler.
// Never retry POST: a timeout can occur after Alexa accepted the reminder.
export interface ReminderCreateDiagnostic {
  readonly version: 1;
  readonly operation: "create";
  readonly phase: "validation" | "request" | "receipt";
  readonly outcome: "accepted" | "unverified";
  readonly reason: "none" | "input" | "http" | "permission" | "network" | "timeout" | "receipt";
  readonly elapsedMs: number;
  readonly httpStatus?: number;
}
export function createEchoReminderClient(fetcher: typeof fetch = fetch,
  onDiagnostic?: (record: ReminderCreateDiagnostic) => unknown): EchoReminderClient {
  async function create(endpoint: string, token: string, requestTime: string, dueAt?: string) {
    const started = performance.now();
    let phase: ReminderCreateDiagnostic["phase"] = "validation";
    let reason: ReminderCreateDiagnostic["reason"] = "input";
    let outcome: ReminderCreateDiagnostic["outcome"] = "unverified";
    let status: number | undefined, signal: AbortSignal | undefined;
    try {
      validateAccess(endpoint, token);
      const body = JSON.stringify(reminderBody(requestTime, dueAt));
      signal = AbortSignal.timeout(2500);
      phase = "request"; reason = "network";
      const response = await fetcher(`${endpoint}/v1/alerts/reminders`, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      status = response.status;
      // No upstream bodies, credentials, or user identifiers enter logs/errors.
      if (response.status === 401 || response.status === 403) {
        reason = "permission";
        await response.body?.cancel();
        throw new ReminderPermissionError();
      }
      if (response.status !== 201) {
        reason = "http";
        await response.body?.cancel();
        throw new Error("Reminder outcome unverified.");
      }
      phase = "receipt"; reason = "receipt";
      const receipt = dueAt ? await acceptedToken(response) : undefined;
      if (!dueAt) await response.body?.cancel();
      outcome = "accepted"; reason = "none";
      return receipt;
    } catch (error) {
      if (signal?.aborted && (reason === "network" || reason === "receipt")) reason = "timeout";
      throw error;
    } finally {
      const elapsed = performance.now() - started;
      // Only fixed enums and bounded numbers cross the logging boundary.
      // Never inspect errors, response bodies, headers, tokens, dates or IDs.
      const record: ReminderCreateDiagnostic = Object.freeze({ version: 1, operation: "create", phase, outcome, reason,
        elapsedMs: Number.isFinite(elapsed) ? Math.min(60_000, Math.max(0, Math.floor(elapsed))) : 0,
        ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status } : {}),
      });
      try { void Promise.resolve(onDiagnostic?.(record)).catch(() => {}); } catch { /* Logging cannot change the result. */ }
    }
  }
  async function change(endpoint: string, token: string, alertToken: string, body?: ReturnType<typeof reminderBody>) {
    validateAccess(endpoint, token);
    if (!alertTokenSchema.safeParse(alertToken).success) throw new Error("Invalid reminder identifier.");
    const response = await fetcher(`${endpoint}/v1/alerts/reminders/${encodeURIComponent(alertToken)}`, {
      method: body ? "PUT" : "DELETE", redirect: "error", signal: AbortSignal.timeout(2500),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new ReminderPermissionError();
    // A missing reminder is a completed cancellation, not a reason to recreate it.
    if (response.status !== 200 && !(body === undefined && response.status === 404)) throw new Error("Reminder change unverified.");
  }
  return { createTest: async (endpoint, token, requestTime) => { await create(endpoint, token, requestTime); },
    createCheckIn: (endpoint, token, requestTime, dueAt) => create(endpoint, token, requestTime, dueAt),
    updateCheckIn: async (endpoint, token, alertToken, requestTime, dueAt) => change(endpoint, token, alertToken, reminderBody(requestTime, dueAt)),
    remove: (endpoint, token, alertToken) => change(endpoint, token, alertToken) };
}

const pendingSchema = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/), preparedAt: z.number().int().nonnegative(),
  proposalId: z.string().regex(/^[a-f0-9]{64}$/),
  plan: z.object({ taskId: z.string().min(1).max(100), dueAt: z.iso.datetime({ offset: true }),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), account: z.string().regex(/^[a-f0-9]{64}$/),
    syncReview: taskReviewSchema.optional() }).strict().optional() }).strict();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function planOffer(when: string, sync = false) {
  if (sync) return `This check-in is ${when}. May I set one discreet reminder? Anyone nearby may hear it. Kin will request cancellation if this check-in is completed, skipped or cancelled. Cancellation can be delayed or fail; you can manage reminders in the Alexa app. Say yes or no.`;
  return `This check-in is ${when}. May I set one discreet reminder for that time? It will say it is time for your Kin check-in. Anyone nearby may hear it. Later plan edits won't cancel this reminder; you can cancel it in the Alexa app. Say yes or no.`;
}
/** Offer only; the existing Yes handler rechecks membership, the task and consent before creating anything. */
export function offerCheckInReminder(input: HandlerInput, task: CareTask, time: number, timeZone: string, cancelSync = false): string | undefined {
  const { request, session, context: { System: system } } = input.requestEnvelope;
  const requestAt = Date.parse(request.timestamp);
  if (!session?.sessionId || !system.user.userId || !system.user.accessToken || !system.apiAccessToken || !endpoints.has(system.apiEndpoint) ||
      !Number.isFinite(requestAt) || requestAt > time + 30_000 || time - requestAt > 90_000 ||
      task.state !== "scheduled" || Date.parse(task.dueAt) <= time + 60_000) return;
  const review = taskReview(task);
  const binding = hash([system.application.applicationId, session.sessionId, system.user.userId]);
  const plan = { taskId: task.id, dueAt: task.dueAt, fingerprint: hash(review), account: hash(system.user.accessToken),
    ...(cancelSync ? { syncReview: review } : {}) };
  const text = planOffer(createEchoTimeFormatter(timeZone)(task.dueAt, time), cancelSync);
  input.attributesManager.setSessionAttributes({ kinReminder: { binding, preparedAt: time, proposalId: hash([binding, request.requestId]), plan } });
  return text;
}
const offer = "May I set one test reminder for two minutes from now? It will say this is your Kin test reminder. Anyone nearby may hear it. Say yes or no.";
function say(input: HandlerInput, text: string, keepOpen = false) {
  const builder = input.responseBuilder.speak(text).withShouldEndSession(!keepOpen);
  if (keepOpen) builder.reprompt("Should I set that reminder? Say yes or no.");
  return builder.getResponse();
}
function planReadFailure(input: HandlerInput, error: unknown) {
  if (error instanceof EchoCareError && error.code === "unauthenticated") {
    input.responseBuilder.withLinkAccountCard();
    return say(input, "Please reconnect your Kin account in the Alexa app, then ask for your reminder again. No reminder was requested.");
  }
  if (error instanceof EchoCareError && error.code === "forbidden") {
    return say(input, "Your account cannot access this family plan. Ask your Kin organizer to check your membership. No reminder was requested.");
  }
  return say(input, "Kin is having trouble loading your family plan. Please try again shortly. No reminder was requested.");
}
export function createEchoReminderVoice(client: EchoReminderClient, claims: ReminderClaims, now: () => number = Date.now,
  care?: Pick<EchoCareClient, "today" | "prepareReminder">, recheckCare = care, timeZone = "UTC", cancelSync = false): RequestHandler {
  const formatTime = createEchoTimeFormatter(timeZone);
  return {
    canHandle: input => input.requestEnvelope.request.type === "IntentRequest" &&
      (["TestReminderIntent", "NextCheckInReminderIntent"].includes(input.requestEnvelope.request.intent.name) ||
       input.attributesManager.getSessionAttributes().kinReminder !== undefined),
    async handle(input) {
      const { request, session, context } = input.requestEnvelope;
      const previous = input.attributesManager.getSessionAttributes().kinReminder;
      input.attributesManager.setSessionAttributes({}); // Disarm both care writes and reminder consent.
      if (request.type !== "IntentRequest") return say(input, "Please open Kin again.");
      const name = request.intent.name;
      if (name === "AMAZON.NoIntent" || name === "AMAZON.StopIntent" || name === "AMAZON.CancelIntent") {
        return say(input, "No reminder requested. Take care.");
      }
      const system = context.System;
      if (!session?.sessionId || !system.user.userId || !system.apiAccessToken || !endpoints.has(system.apiEndpoint)) {
        return say(input, "I can't set a reminder from this session. Open Kin on your Echo and try again.");
      }
      const binding = createHash("sha256").update(JSON.stringify([system.application.applicationId, session.sessionId, system.user.userId])).digest("hex");
      const time = now();
      const requestAt = Date.parse(request.timestamp);
      if (!Number.isFinite(requestAt) || requestAt > time + 30_000 || time - requestAt > 90_000) {
        return say(input, "That reminder request expired. Say test reminder to start again.");
      }
      if (name === "NextCheckInReminderIntent") {
        const token = system.user.accessToken;
        if (!care || !token) {
          input.responseBuilder.withLinkAccountCard();
          return say(input, "Please link your Kin account in the Alexa app before setting a plan reminder.");
        }
        try {
          const snapshot = await care.today(token);
          const readAt = now();
          const next = snapshot.tasks.filter(task => task.state === "scheduled" && Date.parse(task.dueAt) > readAt + 60_000)
            .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
          if (!next) return say(input, "There are no upcoming check-ins at least a minute away in today's plan. I haven't set a reminder.");
          if (cancelSync && (!recheckCare?.prepareReminder || !claims.recordAccepted)) return say(input, "Reminder synchronization is not ready. No reminder was requested.");
          const plan = { taskId: next.id, dueAt: next.dueAt, fingerprint: hash(taskReview(next)), account: hash(token),
            ...(cancelSync ? { syncReview: taskReview(next) } : {}) };
          input.attributesManager.setSessionAttributes({ kinReminder: { binding, preparedAt: readAt,
            proposalId: hash([binding, request.requestId]), plan } });
          return say(input, planOffer(formatTime(plan.dueAt, readAt), cancelSync), true);
        } catch (error) {
          return planReadFailure(input, error);
        }
      }
      if (name === "TestReminderIntent") {
        const proposalId = createHash("sha256").update(JSON.stringify([binding, request.requestId])).digest("hex");
        input.attributesManager.setSessionAttributes({ kinReminder: { binding, preparedAt: time, proposalId } });
        return say(input, offer, true);
      }
      const pending = pendingSchema.safeParse(previous);
      if (!pending.success || session.new || pending.data.binding !== binding ||
          pending.data.preparedAt > time || time - pending.data.preparedAt > 90_000) {
        return say(input, "That reminder request expired. Say test reminder to start again.");
      }
      if (name === "AMAZON.RepeatIntent") {
        input.attributesManager.setSessionAttributes({ kinReminder: pending.data });
        return say(input, pending.data.plan ? planOffer(formatTime(pending.data.plan.dueAt, time), !!pending.data.plan.syncReview) : offer, true);
      }
      if (name !== "AMAZON.YesIntent") return say(input, "No reminder requested. Ask for a reminder again when you are ready.");
      try {
        const plan = pending.data.plan;
        let ticket: { ticket: string; expiresAt: number } | undefined;
        if (plan) {
          const token = system.user.accessToken;
          if (!recheckCare || !token || hash(token) !== plan.account || !client.createCheckIn) return say(input, "Please ask for your next check-in reminder again. Your account session changed.");
          if (plan.syncReview) {
            if (!cancelSync || !recheckCare.prepareReminder || hash(plan.syncReview) !== plan.fingerprint) return say(input, "Reminder synchronization changed. Please ask again. No reminder was requested.");
            try { ticket = await recheckCare.prepareReminder(token, { taskId: plan.taskId, expected: plan.syncReview, consent: reminderSyncConsent }); }
            catch (error) { return planReadFailure(input, error); }
          } else {
          let snapshot;
          try { snapshot = await recheckCare.today(token); }
          catch (error) { return planReadFailure(input, error); }
          const current = snapshot.tasks.find(task => task.id === plan.taskId);
          if (!current || current.state !== "scheduled" || hash(taskReview(current)) !== plan.fingerprint || Date.parse(plan.dueAt) <= now() + 30_000) {
            return say(input, "That check-in changed or its time is too close. I haven't set a reminder. Ask for your next check-in reminder again.");
          }
          }
        }
        if (!await claims.claim(pending.data.proposalId, pending.data.preparedAt)) {
          return say(input, "I won't submit that reminder request again. Please check Reminders in the Alexa app before starting another test.");
        }
        // A slow claim must not extend the period of spoken consent.
        if (now() - pending.data.preparedAt > 90_000) return say(input, "That reminder request expired. Say test reminder to start again.");
        if (ticket && (ticket.expiresAt <= now() || Date.parse(plan!.dueAt) <= now() + 30_000)) return say(input, "That reminder request expired. Please ask again. No reminder was requested.");
        if (plan) {
          const receipt = await client.createCheckIn!(system.apiEndpoint, system.apiAccessToken, new Date(now()).toISOString(), plan.dueAt);
          if (claims.recordAccepted) {
            try {
              if (!receipt) throw new Error("Missing receipt");
              await claims.recordAccepted(pending.data.proposalId, {
                alertToken: receipt.alertToken, endpoint: system.apiEndpoint, userId: system.user.userId,
                taskId: plan.taskId, dueAt: plan.dueAt, fingerprint: plan.fingerprint, acceptedAt: now(),
                ...(ticket ? { ticket: ticket.ticket } : {}),
              });
            } catch {
              return say(input, "Alexa accepted your reminder, but Kin couldn't save its reference. Please manage it in the Alexa app. Don't request another copy.");
            }
          }
          return say(input, "Alexa accepted the reminder for that check-in's scheduled time. You can manage or cancel it in the Alexa app. This does not mark the check-in done.");
        }
        await client.createTest(system.apiEndpoint, system.apiAccessToken, new Date(now()).toISOString());
        return say(input, "Alexa accepted the test reminder for two minutes from now. Listen for it on your Echo. You can manage or cancel it in the Alexa app. This has not changed your family plan.");
      } catch (error) {
        if (error instanceof ReminderPermissionError) {
          input.responseBuilder.withAskForPermissionsConsentCard([permission]);
          return say(input, "I couldn't get reminder access. Check Kin Care's reminder permission in the Alexa app, then open Kin and ask for your reminder again. I won't create one automatically after permission changes.");
        }
        return say(input, "I couldn't verify whether Alexa accepted the reminder. Please check Reminders in the Alexa app before trying again, so you don't create a duplicate.");
      }
    },
  };
}
