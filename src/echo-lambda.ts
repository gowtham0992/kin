import { SkillBuilders, type HandlerInput, type RequestHandler } from "ask-sdk-core";
import type { RequestEnvelope, ResponseEnvelope } from "ask-sdk-model";
import { z } from "zod";
import { createEchoCareClient, type EchoCareClient } from "./echo-care-client.js";
import { createEchoCareVoice } from "./echo-care-voice.js";
import { createEchoReminderClient, createEchoReminderVoice, type EchoReminderClient } from "./echo-reminders.js";
import { createDynamoReminderClaims, type ReminderClaims } from "./echo-reminder-claims.js";
import { createDynamoReminderCancellationJobs, createReminderCancellationReceiver, reminderSyncMessageSchema, type ReminderCancellationJobs } from "./echo-reminder-sync.js";

const skillIdSchema = z.string().regex(/^amzn1\.ask\.skill\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const applicationSchema = z.object({ applicationId: skillIdSchema });
const requestFields = {
  requestId: z.string().min(1).max(256),
  timestamp: z.iso.datetime({ offset: true }),
  locale: z.string().min(1).max(32).optional(),
};

// Lambda's Alexa trigger authenticates the transport. This boundary additionally
// checks the application ID and accepts only bounded, used input fields.
// Do not mount this handler on an HTTP route: that needs signature verification.
const envelopeSchema = z.object({
  version: z.literal("1.0"),
  context: z.object({ System: z.object({ application: applicationSchema.optional(),
    apiEndpoint: z.string().max(2048).optional(),
    apiAccessToken: z.string().min(1).max(16384).optional(),
    user: z.object({ userId: z.string().min(1).max(1024).optional(), accessToken: z.string().min(1).max(16384).optional() }).optional(),
  }) }),
  session: z.object({ application: applicationSchema, sessionId: z.string().min(1).max(1024).optional(), new: z.boolean().optional(),
    attributes: z.object({ kinCare: z.unknown().optional(), kinReminder: z.unknown().optional() }).optional(),
  }).optional(),
  request: z.discriminatedUnion("type", [
    z.object({ ...requestFields, type: z.literal("Messaging.MessageReceived"), message: reminderSyncMessageSchema }),
    z.object({ ...requestFields, type: z.literal("LaunchRequest") }),
    z.object({ ...requestFields, type: z.literal("SessionEndedRequest") }),
    z.object({
      ...requestFields,
      type: z.literal("IntentRequest"),
      intent: z.object({ name: z.string().min(1).max(128), slots: z.object({
        taskNumber: z.object({ name: z.literal("taskNumber"), value: z.string().max(32).optional() }).optional(),
      }).optional() }),
    }),
  ]),
});

const reprompt = "You can say hello, help, or stop.";
const help = "This is Kin's voice connection test. Family account linking is not connected yet, so I can't read or change your plan. You can say hello, or stop to close Kin.";

function speak(input: HandlerInput, text: string, keepOpen = false) {
  const response = input.responseBuilder.speak(text).withShouldEndSession(!keepOpen);
  if (keepOpen) response.reprompt(reprompt);
  return response.getResponse();
}

export function createEchoHandler(environment: NodeJS.ProcessEnv, dependencies: { care?: EchoCareClient; reminders?: EchoReminderClient; reminderClaims?: ReminderClaims; reminderCancellationJobs?: ReminderCancellationJobs; now?: () => number } = {}) {
  const skillId = skillIdSchema.safeParse(environment.KIN_ECHO_SKILL_ID);
  if (!skillId.success) throw new Error("Kin Echo requires a valid configured Skill ID.");
  const enabled = environment.KIN_ECHO_ENABLED === "true";
  const careEnabled = enabled && environment.KIN_ECHO_CARE_ENABLED === "true";
  const reminderTestEnabled = enabled && environment.KIN_ECHO_REMINDER_TEST_ENABLED === "true";
  const syncEnabled = enabled && environment.KIN_ECHO_REMINDER_SYNC_ENABLED === "true";
  if (syncEnabled && !dependencies.reminderCancellationJobs) throw new Error("Kin reminder synchronization requires an authorized job store.");
  const cancelReminder = syncEnabled ? createReminderCancellationReceiver(dependencies.reminderCancellationJobs!,
    dependencies.reminders ?? createEchoReminderClient(), dependencies.now) : undefined;
  const reminderClaims = reminderTestEnabled ? dependencies.reminderClaims ?? createDynamoReminderClaims(environment.KIN_ECHO_REMINDER_CLAIMS_TABLE ?? "") : undefined;
  const care = careEnabled ? dependencies.care ?? createEchoCareClient(environment.KIN_ECHO_MCP_ENDPOINT ?? "", {
    onDiagnostic: diagnostic => console.info(JSON.stringify({ event: "kin_echo_care_result", ...diagnostic })),
  }) : undefined;
  const handlers: RequestHandler[] = [
    {
      canHandle: input => input.requestEnvelope.request.type === "SessionEndedRequest",
      handle: input => {
        if (input.requestEnvelope.session) input.attributesManager.setSessionAttributes({});
        return input.responseBuilder.getResponse();
      },
    },
    {
      canHandle: () => !enabled,
      handle: input => speak(input, "Kin voice testing is paused. Please try again after setup is complete."),
    },
    {
      canHandle: input => input.requestEnvelope.request.locale !== "en-US",
      handle: input => {
        if (input.requestEnvelope.session) input.attributesManager.setSessionAttributes({});
        return speak(input, "This Kin voice test currently supports English, United States. Please check your Alexa language settings.");
      },
    },
    ...(reminderClaims ? [createEchoReminderVoice(dependencies.reminders ?? createEchoReminderClient(), reminderClaims, dependencies.now,
      careEnabled ? dependencies.care ?? createEchoCareClient(environment.KIN_ECHO_MCP_ENDPOINT ?? "", {
        timeoutMs: 5000,
        onDiagnostic: diagnostic => console.info(JSON.stringify({ event: "kin_echo_reminder_plan_result", stage: "offer", ...diagnostic })),
      }) : undefined,
      careEnabled ? dependencies.care ?? createEchoCareClient(environment.KIN_ECHO_MCP_ENDPOINT ?? "", {
        // Leave room for the claim and Alexa POST during the confirmation turn.
        timeoutMs: 2000,
        onDiagnostic: diagnostic => console.info(JSON.stringify({ event: "kin_echo_reminder_plan_result", stage: "confirmation", ...diagnostic })),
      }) : undefined, environment.KIN_ECHO_TIME_ZONE ?? "UTC", environment.KIN_ECHO_PLAN_CANCEL_SYNC_ENABLED === "true")] : []),
    ...(care ? [createEchoCareVoice(care, dependencies.now, environment.KIN_ECHO_UNDO_ENABLED === "true", environment.KIN_ECHO_PLAN_PAUSE_ENABLED === "true")] : []),
    {
      canHandle: input => input.requestEnvelope.request.type === "LaunchRequest",
      handle: input => speak(input, "Welcome to Kin. This is a voice connection test. Your family account is not connected yet. You can say hello, help, or stop.", true),
    },
    {
      canHandle: () => true,
      handle: input => {
        const request = input.requestEnvelope.request;
        if (request.type !== "IntentRequest") return input.responseBuilder.getResponse();
        switch (request.intent.name) {
          case "AMAZON.CancelIntent":
          case "AMAZON.StopIntent":
            return speak(input, "Take care. Goodbye.");
          case "HelloKinIntent":
            return speak(input, "Hello from Kin. A little care, shared. This test hasn't read or changed any family information.", true);
          case "AMAZON.HelpIntent":
          case "AMAZON.RepeatIntent":
            return speak(input, help, true);
          default:
            return speak(input, "I can only help with this voice connection test right now. You can say hello, help, or stop.", true);
        }
      },
    },
  ];

  // The default path remains a no-network smoke test. The opt-in care path
  // forwards the linked bearer to MCP; it never receives database privileges.
  const skill = SkillBuilders.custom().withSkillId(skillId.data).addRequestHandlers(...handlers).create();
  return async (event: unknown): Promise<ResponseEnvelope> => {
    const parsed = envelopeSchema.safeParse(event);
    if (!parsed.success) throw new Error("Invalid Kin Echo request.");
    const application = parsed.data.context.System.application;
    // Amazon's documented background message envelope may omit application.
    // Only that transport-authenticated event is allowed to omit it; voice isn't.
    if ((application ? application.applicationId !== skillId.data : parsed.data.request.type !== "Messaging.MessageReceived") ||
        (parsed.data.session && parsed.data.session.application.applicationId !== skillId.data)) {
      throw new Error("Invalid Kin Echo request.");
    }
    if (parsed.data.request.type === "Messaging.MessageReceived") {
      const system = parsed.data.context.System;
      if (!cancelReminder || parsed.data.session || !system.user?.userId || !system.apiEndpoint || !system.apiAccessToken) {
        throw new Error("Invalid Kin reminder synchronization request.");
      }
      await cancelReminder(parsed.data.request.message, { userId: system.user.userId, endpoint: system.apiEndpoint,
        apiAccessToken: system.apiAccessToken, timestamp: parsed.data.request.timestamp });
      // Out-of-session events must never speak, reprompt, or expose the job.
      return { version: "1.0", response: {} };
    }
    if (!careEnabled && !reminderTestEnabled) {
      if (parsed.data.session) parsed.data.session.attributes = {};
      delete parsed.data.context.System.user;
    } else {
      parsed.data.context.System.user ??= {};
    }
    // Extra Alexa fields are stripped instead of copied into responses.
    return skill.invoke(parsed.data as RequestEnvelope);
  };
}

let configuredHandler: ReturnType<typeof createEchoHandler> | undefined;
export async function handler(event: unknown): Promise<ResponseEnvelope> {
  configuredHandler ??= createEchoHandler(process.env, process.env.KIN_ECHO_ENABLED === "true" && process.env.KIN_ECHO_REMINDER_SYNC_ENABLED === "true"
    ? { reminderCancellationJobs: createDynamoReminderCancellationJobs(process.env.KIN_ECHO_REMINDER_SYNC_TABLE ?? "") } : {});
  return configuredHandler(event);
}
