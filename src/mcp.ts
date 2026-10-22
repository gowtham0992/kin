import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ConfirmationConflict,
  TaskNotFoundError,
  confirmationResponses,
  type CareRepository,
} from "./domain.js";
import { WeeklyBriefService } from "./weekly-brief.js";
import { confirmWithReceipt, undoCompletionWithReceipt, pausePlanWithReceipt } from "./confirmation.js";
import { planPauseBody, PlanPauseConflict } from "./plan-pause.js";
import { FamilyAccessDeniedError, type Membership } from "./membership.js";
import type { CareWriteAuthorization } from "./care-write-authorization.js";
import { taskReviewSchema, TaskReviewConflict } from "./task-review.js";
import { reminderTicketInputSchema, type ReminderTickets } from "./reminder-tickets.js";
import { completionUndoBody, CompletionUndoConflict } from "./response-undo.js";

const widgetUri = "ui://kin/today.html";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetPath = process.env.KIN_WIDGET_PATH?.trim() ||
  path.resolve(moduleDirectory, "../dist/widget/today.html");

export function createMcpServer(
  store: CareRepository,
  weeklyBrief: WeeklyBriefService = new WeeklyBriefService(store),
  member?: Membership,
  authorization?: CareWriteAuthorization,
  reminderTickets?: ReminderTickets,
): McpServer {
  // All current tool inputs are small fixed shapes (at most 18 members,
  // including nested reviews). Bound aggregate validation work before parsing.
  const server = new McpServer({ name: "kin", version: "0.1.0" }, { maxToolInputElements: 256 });
  if (store.planPauseEnabled && member && authorization && member.role !== "viewer") {
    const failure = (error: unknown) => {
      if (error instanceof FamilyAccessDeniedError) return { isError: true, content: [{ type: "text" as const, text: "Family access does not allow this pause." }], structuredContent: { code: "family_access_denied" } };
      if (error instanceof PlanPauseConflict) return { isError: true, content: [{ type: "text" as const, text: error.message }], structuredContent: { code: "pause_conflict" } };
      throw error;
    };
    server.registerTool("review_plan_pause", {
      description: "Read a fresh review for cancelling untouched future check-ins in the next 168 hours and blocking new check-ins in that interval. Not a reversible pause. No write. Show the cancellation list, end and next remaining task; occurrences never return, shift or catch up. Active cancellation interval returns a null proposal.", inputSchema: {},
    }, async () => {
      try { await authorization.assertCurrent(); const proposal = await store.proposePlanPause(), control = await store.planControl();
        await authorization.assertCurrent();
        return { content: [{ type: "text", text: "Review this cancellation before asking for explicit confirmation. No change was submitted." }], structuredContent: { proposal, control } };
      } catch (error) { return failure(error); }
    });
    server.registerTool("pause_care_plan", {
      description: "Apply exactly the freshly reviewed seven-day cancellation only after explicit Yes. Cancels selected untouched future occurrences atomically and blocks new check-ins in that interval; never restores them, creates reminders or moves/catches up tasks. Keep the request ID when retrying an uncertain write.", inputSchema: planPauseBody.shape,
    }, async input => {
      try { const result = await pausePlanWithReceipt(store, input, member, authorization);
        return { content: [{ type: "text", text: "The reviewed cancellation was saved. Selected occurrences were canceled, not moved or temporarily hidden." }], structuredContent: { ...result } };
      } catch (error) { return failure(error); }
    });
  }
  if (store.completionUndoEnabled && member && authorization) server.registerTool("undo_care_completion", {
    title: "Undo a recent accidental completion",
    description: "After explicit review and consent, undo this account's own recent done response and restore its exact prior scheduled response. Requires the original confirmation request ID and current task review; does not recreate reminders or retract delivered alerts.",
    inputSchema: completionUndoBody.shape,
  }, async input => {
    try {
      const result = await undoCompletionWithReceipt(store, input, member, authorization);
      return { content: [{ type: "text", text: "The completion was undone. Canceled reminders stay canceled." }], structuredContent: { ...result } };
    } catch (error) {
      if (error instanceof FamilyAccessDeniedError) return { isError: true, content: [{ type: "text", text: "Family access does not allow this undo." }], structuredContent: { code: "family_access_denied" } };
      if (error instanceof CompletionUndoConflict) return { isError: true, content: [{ type: "text", text: error.message }], structuredContent: { code: "undo_conflict" } };
      throw error;
    }
  });
  if (reminderTickets) server.registerTool("prepare_plan_reminder", {
    description: "Prepare an account-bound ticket only after explicit consent to cancel this Echo reminder when its check-in is completed, skipped or cancelled. Does not create a reminder.",
    inputSchema: reminderTicketInputSchema.shape,
  }, async value => {
    try {
      if (!authorization) throw new FamilyAccessDeniedError();
      const result = await reminderTickets.issue(value, authorization);
      return { content: [{ type: "text" as const, text: "Reminder ticket prepared; no reminder has been created." }], structuredContent: { ...result } };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Reminder preparation unavailable. Review the current plan and try again." }], structuredContent: { code: "reminder_unavailable" } };
    }
  });

  registerAppTool(
    server,
    "show_today",
    {
      title: "Show today's care plan",
      description:
        "Shows today's shared family care tasks and their current confirmation state.",
      inputSchema: {},
      _meta: { ui: { resourceUri: widgetUri } },
    },
    async () => {
      const snapshot = await store.today();
      return {
        content: [
          {
            type: "text",
            text: `${snapshot.summary.completed} of ${snapshot.summary.total} care tasks are complete today.`,
          },
        ],
        // Keep the strict classic Echo reader's existing wire contract. The
        // authenticated REST workspace gets the richer follow-up title.
        structuredContent: { ...snapshot, escalations: snapshot.escalations.map(({ taskTitle: _title, ...alert }) => alert) },
      };
    },
  );

  registerAppTool(
    server,
    "show_weekly_brief",
    {
      title: "Show the weekly family brief",
      description:
        "Summarizes the last seven days of recorded care activity with evidence-linked family follow-ups. It does not provide medical advice.",
      inputSchema: {},
      _meta: {},
    },
    async () => {
      const brief = await weeklyBrief.create();
      return {
        content: [{ type: "text", text: `${brief.headline}. ${brief.overview}` }],
        structuredContent: { ...brief },
      };
    },
  );

  registerAppTool(
    server,
    "confirm_care_task",
    {
      title: "Confirm a care task",
      description:
        "Records that a family care task is done, not done yet, or intentionally skipped.",
      inputSchema: {
        expected: taskReviewSchema.describe("Required exact task state reviewed with the person from show_today: title, dueAt, state, lastResponse, confirmedAt and confirmedBy. A changed task is rejected atomically; retry keeps the original request ID and reviewed state."),
        taskId: z.string().min(1).max(100).describe("The care task identifier."),
        response: z.enum(confirmationResponses).describe("The person's response."),
        actor: z.string().min(1).max(80).describe("The person confirming the task."),
        requestId: z
          .string()
          .min(8)
          .max(100)
          .describe("A unique idempotency key for this confirmation attempt."),
      },
      _meta: { ui: { resourceUri: widgetUri } },
    },
    async (input) => {
      try {
        const result = await confirmWithReceipt(store, input, member, authorization);
        return {
          content: [
            {
              type: "text",
              text: result.replayed
                ? `That confirmation was already recorded for ${result.task.title}.`
                : `Recorded ${result.confirmation.response.replace("_", " ")} for ${result.task.title}.`,
            },
          ],
          structuredContent: {
            ...(result.snapshot ?? {}), confirmation: result.confirmation,
            task: result.task, refreshRequired: result.refreshRequired,
          },
        };
      } catch (error) {
        if (error instanceof ConfirmationConflict) {
          return { isError: true,
            content: [{ type: "text", text: "That request was already used for a different task or response. Review the task before sending a new confirmation." }],
            structuredContent: { code: "confirmation_conflict" } };
        }
        if (error instanceof FamilyAccessDeniedError) {
          return { isError: true, content: [{ type: "text", text: "Family access changed. Sign in again before saving." }], structuredContent: { code: "family_access_denied" } };
        }
        if (error instanceof TaskReviewConflict) {
          return { isError: true, content: [{ type: "text", text: error.message }], structuredContent: { code: "review_conflict" } };
        }
        if (error instanceof TaskNotFoundError) {
          return {
            isError: true,
            content: [{ type: "text", text: "I couldn't find that care task." }],
            structuredContent: { code: "task_not_found" },
          };
        }
        throw error;
      }
    },
  );

  registerAppResource(
    server,
    widgetUri,
    widgetUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await readFile(widgetPath, "utf8");
      return {
        contents: [{ uri: widgetUri, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
