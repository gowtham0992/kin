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
  TaskNotFoundError,
  confirmationResponses,
  type CareRepository,
} from "./domain.js";
import { WeeklyBriefService } from "./weekly-brief.js";

const widgetUri = "ui://kin/today.html";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetPath = process.env.KIN_WIDGET_PATH?.trim() ||
  path.resolve(moduleDirectory, "../widget/today.html");

export function createMcpServer(
  store: CareRepository,
  weeklyBrief: WeeklyBriefService = new WeeklyBriefService(store),
): McpServer {
  const server = new McpServer({ name: "kin", version: "0.1.0" });

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
        structuredContent: { ...snapshot },
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
        const result = await store.confirm(input);
        const snapshot = await store.today();
        return {
          content: [
            {
              type: "text",
              text: result.replayed
                ? `That confirmation was already recorded for ${result.task.title}.`
                : `Recorded ${result.confirmation.response.replace("_", " ")} for ${result.task.title}.`,
            },
          ],
          structuredContent: { ...snapshot, confirmation: result.confirmation },
        };
      } catch (error) {
        if (error instanceof TaskNotFoundError) {
          return {
            isError: true,
            content: [{ type: "text", text: "I couldn't find that care task." }],
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
