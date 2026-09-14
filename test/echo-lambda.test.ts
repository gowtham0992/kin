import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEchoHandler } from "../src/echo-lambda.js";

const skillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
const otherSkillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000002";
const environment = { KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true" };
const launch = () => ({
  version: "1.0",
  session: { new: true, sessionId: "synthetic-session", application: { applicationId: skillId },
    attributes: { privateNote: "synthetic-private-note" }, user: { userId: "synthetic-user", accessToken: "synthetic-session-token" } },
  context: { System: { application: { applicationId: skillId },
    apiAccessToken: "synthetic-api-token", apiEndpoint: "https://untrusted.invalid",
    user: { accessToken: "synthetic-user-token" } } },
  request: { type: "LaunchRequest", requestId: "synthetic-request", timestamp: "2026-09-10T12:00:00Z", locale: "en-US" },
});
const intent = (name: string) => ({ ...launch(), request: { ...launch().request, type: "IntentRequest", intent: { name } } });

afterEach(() => vi.restoreAllMocks());

describe("Kin's isolated Echo voice connection", () => {
  it("greets without claiming family access and invites a supported next turn", async () => {
    const response = await createEchoHandler(environment)(launch());
    expect(response.version).toBe("1.0");
    expect(response.response.outputSpeech).toMatchObject({ type: "SSML", ssml: expect.stringContaining("Your family account is not connected yet") });
    expect(response.response.shouldEndSession).toBe(false);
    expect(response.response.reprompt?.outputSpeech).toMatchObject({ ssml: "<speak>You can say hello, help, or stop.</speak>" });
  });

  it.each([
    ["HelloKinIntent", "This test hasn't read or changed any family information."],
    ["AMAZON.HelpIntent", "I can't read or change your plan."],
    ["AMAZON.RepeatIntent", "I can't read or change your plan."],
    ["AMAZON.FallbackIntent", "I can only help with this voice connection test"],
    ["UndeclaredIntent", "I can only help with this voice connection test"],
  ])("responds to %s without inventing care capabilities", async (name, expectedSpeech) => {
    const response = await createEchoHandler(environment)(intent(name!));
    expect(response.response.outputSpeech).toMatchObject({ ssml: expect.stringContaining(expectedSpeech!) });
    expect(response.response.shouldEndSession).toBe(false);
  });

  it.each(["AMAZON.StopIntent", "AMAZON.CancelIntent"])("closes on %s without a reprompt", async name => {
    const { response } = await createEchoHandler(environment)(intent(name));
    expect(response.outputSpeech).toMatchObject({ ssml: "<speak>Take care. Goodbye.</speak>" });
    expect(response.shouldEndSession).toBe(true);
    expect(response.reprompt).toBeUndefined();
  });

  it.each(["true", "false"])("ends silently when Alexa ends the session, enabled=%s", async enabled => {
    const request = { ...launch(), request: { ...launch().request, type: "SessionEndedRequest" } };
    expect((await createEchoHandler({ ...environment, KIN_ECHO_ENABLED: enabled })(request)).response).toEqual({});
  });

  it.each([undefined, "false", "TRUE", "1"])("stays paused unless explicitly enabled, value=%s", async enabled => {
    const { response } = await createEchoHandler({ ...environment, KIN_ECHO_ENABLED: enabled })(launch());
    expect(response.outputSpeech).toMatchObject({ ssml: expect.stringContaining("voice testing is paused") });
    expect(response.shouldEndSession).toBe(true);
    expect(response.reprompt).toBeUndefined();
  });

  it.each([undefined, "", "amzn1.ask.skill.", "another-account"])("fails closed on invalid Skill ID configuration %s", configuredId => {
    expect(() => createEchoHandler({ ...environment, KIN_ECHO_SKILL_ID: configuredId })).toThrow("valid configured Skill ID");
  });

  it.each(["context", "session"])("rejects another skill in %s even while paused", async location => {
    const event = launch();
    if (location === "context") event.context.System.application.applicationId = otherSkillId;
    else event.session.application.applicationId = otherSkillId;
    for (const enabled of ["true", "false"]) {
      await expect(createEchoHandler({ ...environment, KIN_ECHO_ENABLED: enabled })(event)).rejects.toThrow("Invalid Kin Echo request.");
    }
  });

  it.each([null, {}, { ...launch(), version: "2.0" }, { ...launch(), context: {} },
    { ...launch(), request: { ...launch().request, type: "IntentRequest" } },
    { ...launch(), request: { ...launch().request, type: "UnknownRequest" } },
    { ...launch(), request: { ...launch().request, timestamp: "not-a-date" } },
    { ...intent("a".repeat(129)) },
  ])("rejects malformed envelope %# with a fixed error", async event => {
    await expect(createEchoHandler(environment)(event)).rejects.toThrow("Invalid Kin Echo request.");
  });

  it("does not echo or log tokens, session attributes, or hostile intent text, and never calls a service", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const handle = createEchoHandler(environment);
    const first = await handle(intent("<speak>synthetic-hostile-intent</speak>"));
    const second = await handle(launch());
    const repeated = await handle(intent("AMAZON.RepeatIntent"));
    expect(repeated.response.outputSpeech).toMatchObject({ ssml: expect.stringContaining("I can't read or change your plan.") });
    const serialized = JSON.stringify([first, second, repeated]);
    expect(serialized).not.toMatch(/synthetic-|untrusted\.invalid/);
    expect(first.sessionAttributes).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("handles unsupported or missing locale explicitly without keeping the microphone open", async () => {
    for (const locale of ["de-DE", undefined]) {
      const event = { ...launch(), request: { ...launch().request, locale } };
      const { response } = await createEchoHandler(environment)(event);
      expect(response.outputSpeech).toMatchObject({ ssml: expect.stringContaining("English, United States") });
      expect(response.shouldEndSession).toBe(true);
    }
  });

  it("accepts an Alexa request without a session and is stateless across repeats", async () => {
    const { session: _session, ...event } = launch();
    const handle = createEchoHandler(environment);
    const first = await handle(event);
    expect(first.version).toBe("1.0");
    expect(await handle(event)).toEqual(first);
    expect(first.sessionAttributes).toBeUndefined();
  });

  it("keeps the importable interaction model limited to the tested voice capabilities", () => {
    const model = JSON.parse(readFileSync(new URL("../alexa/interaction-model-en-US.json", import.meta.url), "utf8"));
    const development = JSON.parse(readFileSync(new URL("../alexa/development.json", import.meta.url), "utf8"));
    expect(model.interactionModel.languageModel.invocationName).toBe("kin family");
    expect(development.invocationName).toBe(model.interactionModel.languageModel.invocationName);
    expect(model.interactionModel.languageModel.intents.map((item: { name: string }) => item.name)).toEqual([
      "TestReminderIntent", "NextCheckInReminderIntent", "HelloKinIntent", "TodayPlanIntent", "NextTasksIntent", "MarkTaskDoneIntent", "MarkTaskNotYetIntent", "SkipTaskIntent", "UndoLastCompletionIntent", "PausePlanWeekIntent",
      "AMAZON.YesIntent", "AMAZON.NoIntent", "AMAZON.HelpIntent", "AMAZON.RepeatIntent", "AMAZON.CancelIntent", "AMAZON.StopIntent", "AMAZON.FallbackIntent",
    ]);
  });
});
