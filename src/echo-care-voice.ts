import { createHash } from "node:crypto";
import type { HandlerInput, RequestHandler } from "ask-sdk-core";
import { z } from "zod";
import { EchoCareError, type EchoCareClient } from "./echo-care-client.js";
import { taskReview, taskReviewSchema } from "./task-review.js";
import type { ConfirmationResponse } from "./domain.js";
import { completionUndoLifetime, reviewedCompletionMatches } from "./response-undo.js";
import { planPauseProposalSchema, type PlanPauseProposal } from "./plan-pause.js";

const pageSize = 5;
const listLifetime = 10 * 60_000;
const reviewLifetime = 90_000;
const rowSchema = z.object({ id: z.string().min(1).max(100), review: taskReviewSchema }).strict();
const stateSchema = z.object({
  binding: z.string().regex(/^[a-f0-9]{64}$/), listedAt: z.number().int().nonnegative(),
  rows: z.array(rowSchema).max(pageSize), hasMore: z.boolean(),
  pending: z.object({ index: z.number().int().min(0).max(pageSize - 1), response: z.enum(["done", "not_yet", "skipped"]),
    requestId: z.string().regex(/^echo_[a-f0-9]{64}$/), preparedAt: z.number().int().nonnegative() }).strict().optional(),
  completion: z.object({ row: rowSchema, before: taskReviewSchema, requestId: z.string().regex(/^echo_[a-f0-9]{64}$/),
    recordedAt: z.number().int().nonnegative() }).strict().optional(),
  pendingUndo: z.object({ requestId: z.string().regex(/^echo_[a-f0-9]{64}$/), preparedAt: z.number().int().nonnegative() }).strict().optional(),
  pendingPause: z.object({ proposal: planPauseProposalSchema, requestId: z.string().regex(/^echo_[a-f0-9]{64}$/),
    preparedAt: z.number().int().nonnegative() }).strict().optional(),
}).strict();
type VoiceState = z.infer<typeof stateSchema>;
const help = "Say today's plan, then mark check-in one done, mark check-in one not yet, or skip check-in one. I'll ask before saving. Anyone using this Echo can use the linked Kin account. I can't identify who's speaking. This is not an emergency service.";
const prompt = "Say today's plan, or stop.";
const responseNames: Record<ConfirmationResponse, string> = { done: "done", not_yet: "not yet", skipped: "skipped" };
const actions: Record<string, ConfirmationResponse | undefined> = {
  MarkTaskDoneIntent: "done", MarkTaskNotYetIntent: "not_yet", SkipTaskIntent: "skipped",
};
const digest = (values: unknown[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");

// Family-controlled text is XML text, never SSML markup. Quotes need no escaping
// in a text node. Exclude XML-forbidden control characters as well.
function xmlText(text: string) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, " ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function say(input: HandlerInput, text: string, reprompt?: string) {
  const builder = input.responseBuilder.speak(xmlText(text)).withShouldEndSession(!reprompt);
  if (reprompt) builder.reprompt(xmlText(reprompt));
  return builder.getResponse();
}
function setState(input: HandlerInput, state?: VoiceState) {
  if (input.requestEnvelope.session) input.attributesManager.setSessionAttributes(state ? { kinCare: state } : {});
}
function link(input: HandlerInput) {
  setState(input);
  input.responseBuilder.withLinkAccountCard();
  return say(input, "Please open Kin Care in the Alexa app and link your Kin account. Once linked, anyone using this Echo can access the plan with that account's permissions.");
}
function validAge(time: number, now: number, lifetime: number) {
  return time <= now && now - time <= lifetime;
}
function currentReview(state: VoiceState | undefined, time: number) {
  const pending = state?.pending;
  const row = pending && state.rows[pending.index];
  return pending && row && row.review.state === "scheduled" && validAge(pending.preparedAt, time, reviewLifetime)
    ? { pending, row } : undefined;
}
function readState(input: HandlerInput, binding: string, now: number): VoiceState | undefined {
  if (input.requestEnvelope.session?.new) return;
  const parsed = stateSchema.safeParse(input.attributesManager.getSessionAttributes().kinCare);
  if (!parsed.success || parsed.data.binding !== binding || !validAge(parsed.data.listedAt, now, listLifetime)) return;
  return parsed.data;
}
function disambiguatingDueTime(row: VoiceState["rows"][number], index: number, rows: VoiceState["rows"]) {
  // The API snapshot has no family timezone. Never silently use the Echo's or
  // Lambda's timezone. Duplicate titles are disambiguated using explicit UTC.
  const duplicate = rows.some((other, i) => i !== index && other.review.title === row.review.title);
  return duplicate ? explicitDueTime(row) : "";
}
function explicitDueTime(row: VoiceState["rows"][number]) {
  return `, scheduled for ${new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
  }).format(new Date(row.review.dueAt))} UTC`;
}
function describeRow(row: VoiceState["rows"][number], index: number, rows: VoiceState["rows"]) {
  const status = row.review.state === "scheduled" ? row.review.lastResponse === "not_yet" ? "not yet" : "not confirmed" : row.review.state;
  return `${index + 1}. ${row.review.title}${disambiguatingDueTime(row, index, rows)}, ${status}.`;
}
function sayReview(input: HandlerInput, row: VoiceState["rows"][number], index: number, rows: VoiceState["rows"], response: ConfirmationResponse) {
  return say(input, `Record ${responseNames[response]} for check-in ${index + 1}, ${row.review.title}${disambiguatingDueTime(row, index, rows)}? Say yes or no.`, "Should I save that response? Say yes or no.");
}
function sayPage(input: HandlerInput, rows: VoiceState["rows"], hasMore: boolean, introduction: string) {
  const next = hasMore ? " Say next check-ins to hear more." : "";
  return say(input, `${introduction} ${rows.map((row, index) => describeRow(row, index, rows)).join(" ")} Say mark check-in one done, or help.${next}`, "Choose a check-in by number, say repeat, or say today's plan.");
}

function sayUndoReview(input: HandlerInput, completion: NonNullable<VoiceState["completion"]>) {
  const previous = completion.before.lastResponse === "not_yet" ? "the earlier not yet response" : "not confirmed";
  return say(input, `Undo done for ${completion.row.review.title}${explicitDueTime(completion.row)}, and restore ${previous}? Canceled reminders won't restart. Say yes or no.`, "Undo that completion? Say yes or no.");
}

function pauseEnd(endsAt: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(endsAt));
}
function sayPauseReview(input: HandlerInput, proposal: PlanPauseProposal) {
  const next = proposal.nextTask ? `The next remaining check-in is ${proposal.nextTask.title}, ${pauseEnd(proposal.nextTask.dueAt, proposal.timeZone)}.`
    : "No later check-in is currently scheduled.";
  return say(input, `Pause for one week, until ${pauseEnd(proposal.endsAt, proposal.timeZone)}? This cancels ${proposal.tasks.length} untouched future check-ins. They won't be moved or caught up. ${next} Say yes or no.`, "Pause those check-ins for one week? Say yes or no.");
}

export function createEchoCareVoice(care: EchoCareClient, now: () => number = Date.now, undoEnabled = false, pauseEnabled = false): RequestHandler {
  return {
    canHandle: () => true,
    async handle(input) {
      const envelope = input.requestEnvelope;
      const request = envelope.request;
      const name = request.type === "IntentRequest" ? request.intent.name : "TodayPlanIntent";
      if (name === "AMAZON.StopIntent" || name === "AMAZON.CancelIntent") {
        setState(input);
        return say(input, "Take care. Goodbye.");
      }
      if (name === "AMAZON.NoIntent") {
        setState(input);
        return say(input, "Okay. I haven't submitted a change.", prompt);
      }
      if (name === "AMAZON.HelpIntent" || name === "HelloKinIntent") {
        setState(input);
        return say(input, name === "HelloKinIntent" ? `Hello from Kin. A little care, shared. ${help}` : help, prompt);
      }
      const token = envelope.context.System.user.accessToken;
      if (!token) return link(input);
      const session = envelope.session;
      if (!session?.sessionId || !envelope.context.System.user.userId) {
        setState(input);
        return say(input, "Please close Kin and open it again to start a new conversation.");
      }
      // This binding is continuity protection, NOT authentication. Every network
      // operation uses the current bearer, and MCP checks current membership.
      // A token refresh conservatively requires a fresh spoken review.
      const binding = digest([session.sessionId, envelope.context.System.user.userId, token]);
      const time = now();
      const state = readState(input, binding, time);
      setState(input); // Never return arbitrary Alexa attributes or old reviews.
      let submitting = false;
      let submittingUndo = false;
      let submittingPause = false;
      try {
        const pauseTurn = name === "PausePlanWeekIntent" || (name === "AMAZON.RepeatIntent" && state?.pendingPause) || (name === "AMAZON.YesIntent" && state?.pendingPause);
        if (pauseTurn) {
          const pending = state?.pendingPause;
          if (!pauseEnabled || !care.reviewPlanPause || !care.pausePlan) return say(input, "A one-week pause isn't available here yet. Review the plan in Kin.");
          if (pending && (!validAge(pending.preparedAt, time, reviewLifetime) || time > Date.parse(pending.proposal.expiresAt) ||
              pending.proposal.tasks.some(task => Date.parse(task.dueAt) <= time))) return say(input, "That pause review expired. Say pause my plan for a week to review again.", prompt);
          if (name === "AMAZON.YesIntent" && pending) {
            submittingPause = true;
            const { proposal } = pending;
            const saved = await care.pausePlan(token, { startsAt: proposal.startsAt, endsAt: proposal.endsAt,
              reviewToken: proposal.reviewToken, requestId: pending.requestId, confirm: true });
            if (JSON.stringify(saved.receipt.cancelled) !== JSON.stringify(proposal.tasks) || JSON.stringify(saved.receipt.nextTask) !== JSON.stringify(proposal.nextTask)) throw new EchoCareError("outcome_unknown");
            return say(input, `Paused until ${pauseEnd(saved.receipt.endsAt, saved.receipt.timeZone)}. Canceled ${saved.receipt.cancelled.length} check-ins; they won't be caught up.`, prompt);
          }
          const current = await care.reviewPlanPause(token), checkedAt = now();
          if (!current.proposal) return say(input, `The plan is already paused until ${pauseEnd(current.control.pause!.endsAt, "UTC")}. Existing canceled check-ins won't be caught up.`, prompt);
          if (name === "AMAZON.RepeatIntent" && pending) {
            // Repeating cannot rebase/extend a previous Yes. A new review is required.
            return say(input, "Say pause my plan for a week to get a fresh pause review.", prompt);
          }
          if (checkedAt < Date.parse(current.proposal.startsAt) || checkedAt > Date.parse(current.proposal.expiresAt) ||
              current.proposal.tasks.some(task => Date.parse(task.dueAt) <= checkedAt)) return say(input, "That pause review expired. Please ask again.", prompt);
          setState(input, { binding, listedAt: checkedAt, rows: [], hasMore: false,
            pendingPause: { proposal: current.proposal, preparedAt: checkedAt,
              requestId: `echo_${digest([binding, request.requestId, current.proposal.reviewToken, "pause"])}` } });
          return sayPauseReview(input, current.proposal);
        }
        const undoTurn = name === "UndoLastCompletionIntent" || (name === "AMAZON.RepeatIntent" && state?.pendingUndo) || (name === "AMAZON.YesIntent" && state?.pendingUndo);
        if (undoTurn) {
          const completion = state?.completion;
          if (!undoEnabled || !care.undoCompletion || !completion || state.pending ||
              !validAge(completion.recordedAt, time, completionUndoLifetime) ||
              (state.pendingUndo && !validAge(state.pendingUndo.preparedAt, time, reviewLifetime))) {
            return say(input, "There isn't a recent completion I can undo in this conversation. Say today's plan to review.", prompt);
          }
          if (name === "AMAZON.YesIntent" && state.pendingUndo) {
            submittingUndo = true;
            await care.undoCompletion(token, { taskId: completion.row.id, confirmationRequestId: completion.requestId,
              requestId: state.pendingUndo.requestId, expected: completion.row.review, restore: completion.before, confirm: true });
            return say(input, `Undid the completion for ${completion.row.review.title}. Canceled reminders stay canceled.`, prompt);
          }
          // A new undo or repeat checks current access and exact task state before
          // speaking retained family content. Repeat never extends consent.
          const snapshot = await care.today(token), checkedAt = now();
          const current = snapshot.tasks.find(task => task.id === completion.row.id);
          if (!current || !reviewedCompletionMatches(current, completion.row.review) ||
              !validAge(completion.recordedAt, checkedAt, completionUndoLifetime) ||
              (state.pendingUndo && !validAge(state.pendingUndo.preparedAt, checkedAt, reviewLifetime))) {
            return say(input, "That completion changed or expired. Say today's plan to review.", prompt);
          }
          const pendingUndo = state.pendingUndo ?? { preparedAt: checkedAt,
            requestId: `echo_${digest([binding, request.requestId, completion.requestId, "undo"])}` };
          setState(input, { ...state, pendingUndo });
          return sayUndoReview(input, completion);
        }
        if (name === "AMAZON.RepeatIntent") {
          const noCurrent = "There isn't a current plan or review to repeat. Say today's plan to start again.";
          const expired = "That confirmation expired. Say today's plan and choose a check-in again.";
          if (!state?.rows.length) return say(input, noCurrent, prompt);
          if (state.pending && !currentReview(state, time)) return say(input, expired, prompt);
          // Repeat is a read, never a write. Recheck current access and retained
          // task reviews before speaking family text from the Alexa session.
          const snapshot = await care.today(token);
          const checkedAt = now();
          if (!validAge(state.listedAt, checkedAt, listLifetime)) return say(input, noCurrent, prompt);
          const reviewed = currentReview(state, checkedAt);
          if (state.pending && !reviewed) return say(input, expired, prompt);
          const changed = state.rows.some(row => {
            const task = snapshot.tasks.find(task => task.id === row.id);
            if (!task) return true;
            const current = taskReview(task);
            return Object.entries(row.review).some(([field, value]) => current[field as keyof typeof current] !== value);
          });
          if (changed) return say(input, "The plan changed since I read that page. Say today's plan to refresh the check-in numbers.", prompt);
          // Keep the original numbering, operation ID and expiry boundaries.
          // A repeat must never extend a list or re-arm an expired review.
          setState(input, state);
          if (reviewed) return sayReview(input, reviewed.row, reviewed.pending.index, state.rows, reviewed.pending.response);
          return sayPage(input, state.rows, state.hasMore, "Here are those check-ins again.");
        }
        if (name === "AMAZON.YesIntent") {
          const reviewed = currentReview(state, time);
          if (!reviewed) {
            return say(input, "There isn't a current check-in waiting for confirmation. Say today's plan and choose a check-in first.", prompt);
          }
          const { pending, row } = reviewed;
          submitting = true;
          const receipt = await care.confirm(token, { taskId: row.id, response: pending.response,
            actor: "Linked Kin account", requestId: pending.requestId, expected: row.review });
          const canUndo = undoEnabled && care.undoCompletion && pending.response === "done" && receipt.task.state === "done" &&
            receipt.task.confirmedAt === receipt.confirmation.recordedAt && receipt.task.confirmedBy === receipt.confirmation.actor &&
            validAge(Date.parse(receipt.confirmation.recordedAt), now(), completionUndoLifetime);
          if (canUndo) setState(input, { binding, listedAt: now(), rows: [], hasMore: false,
            completion: { row: { id: row.id, review: taskReview(receipt.task) }, before: row.review,
              requestId: pending.requestId, recordedAt: Date.parse(receipt.confirmation.recordedAt) } });
          return say(input, `Saved ${responseNames[pending.response]} for ${row.review.title} through the linked Kin account.${receipt.refreshRequired ? " I couldn't refresh the plan. Check Kin for its latest state." : ""}${canUndo ? " Say undo last completion if that was a mistake." : ""}`, prompt);
        }
        const action = actions[name];
        if (action && state) {
          const slot = request.type === "IntentRequest" ? request.intent.slots?.taskNumber?.value : undefined;
          const index = slot && /^[1-5]$/.test(slot) ? Number(slot) - 1 : -1;
          const row = state.rows[index];
          if (!row) {
            setState(input, { ...state, pending: undefined });
            return say(input, "Please use one of the numbers I just read. For example, mark check-in one done.", "Which check-in number, and should I record done, not yet, or skipped?");
          }
          if (row.review.state !== "scheduled") {
            return say(input, `That check-in is already ${row.review.state}. Review it in Kin if it needs changing.`, prompt);
          }
          const pending = { index, response: action, preparedAt: time,
            requestId: `echo_${digest([binding, request.requestId, row.id, row.review, action])}` };
          setState(input, { ...state, pending });
          return sayReview(input, row, index, state.rows, action);
        }
        if (name === "TodayPlanIntent" || name === "NextTasksIntent" || action) {
          if (name === "NextTasksIntent" && state && !state.hasMore) {
            setState(input, { ...state, pending: undefined });
            return say(input, "That was the last page of check-ins. You can choose a number from that page, or say today's plan to refresh.", prompt);
          }
          const snapshot = await care.today(token);
          const afterRow = name === "NextTasksIntent" && state?.hasMore ? state.rows.at(-1) : undefined;
          const afterIndex = afterRow ? snapshot.tasks.findIndex(task => task.id === afterRow.id) : -1;
          if (afterRow && (afterIndex === -1 || snapshot.tasks[afterIndex]!.dueAt !== afterRow.review.dueAt)) {
            return say(input, "The plan changed since I read that page. Say today's plan to refresh the check-in numbers.", prompt);
          }
          const offset = afterRow ? afterIndex + 1 : 0;
          const rows = snapshot.tasks.slice(offset, offset + pageSize).map(task => ({ id: task.id, review: taskReview(task) }));
          const hasMore = snapshot.tasks.length > offset + rows.length;
          if (!rows.length) return say(input, afterRow
            ? "There are no more check-ins to read right now. Say today's plan to refresh."
            : "There are no check-ins to read for today. This doesn't tell us whether someone is safe.", prompt);
          setState(input, { binding, listedAt: time, rows, hasMore });
          return sayPage(input, rows, hasMore, `Here are ${offset ? "the next" : "today's"} check-ins.`);
        }
        // An unrelated utterance cannot leave a previous Yes armed.
        return say(input, "I can help with your family check-ins. Say today's plan, or help for examples.", prompt);
      } catch (error) {
        setState(input);
        if (error instanceof EchoCareError) {
          if (error.code === "unauthenticated") return link(input);
          if (error.code === "forbidden") return say(input, "The linked account doesn't currently have permission for this action. Ask your family organizer to review access in Kin.");
          if (error.code === "conflict" && submittingPause) return say(input, "That pause review changed or expired. I haven't applied it. Say pause my plan for a week to review again.", prompt);
          if (error.code === "conflict" && submittingUndo) return say(input, "That completion changed or expired. I haven't undone it. Say today's plan to review.", prompt);
          if (error.code === "conflict") return say(input, "That check-in changed or is no longer available. I haven't saved this response. Say today's plan to review it again.", prompt);
        }
        if (submittingPause) return say(input, "I couldn't verify whether the pause was saved. Check the plan in Kin before trying again.");
        if (submittingUndo) return say(input, "I couldn't verify whether that completion was undone. Check Kin before trying again.");
        if (submitting) return say(input, "I couldn't verify whether your response was saved. Please check the task in Kin before trying again.");
        return say(input, "I couldn't load the family plan right now. Please try again shortly.");
      }
    },
  };
}
