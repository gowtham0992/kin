import { describe, expect, it } from "vitest";
import { assertPausedReleaseDefaults } from "../src/release-defaults.js";

// Independent contract: removing a required flag from the implementation must not weaken this fixture.
const gates = {
  KinDataStack: ["WebPushEnabled", "EscalationWorkerEnabled", "EscalationScheduleEnabled"],
  KinApiStack: ["WebPushEnabled", "PublicApiEnabled", "FamilyWorkspaceEnabled", "FamilyEnrollmentEnabled",
    "InvitationIssuingEnabled", "FamilyConversationEnabled", "ReminderTicketsEnabled", "CompletionUndoEnabled",
    "RescheduleEnabled", "PlanPauseEnabled"],
  KinEchoStack: ["EchoEnabled", "EchoCareEnabled", "EchoReminderTestEnabled", "EchoReminderSyncEnabled",
    "EchoUndoEnabled", "EchoPlanPauseEnabled", "EchoPlanCancelSyncEnabled"],
  KinReminderSyncStack: ["ReminderSyncWorkerEnabled", "ReminderSyncScheduleEnabled"],
};
type Parameter = { Type?: unknown; Default?: unknown; AllowedValues?: unknown };
const fixture = () => Object.entries(gates).map(([name, flags]) => ({ name,
  template: { Parameters: Object.fromEntries(flags.map(flag => [flag,
    { Type: "String", Default: "false", AllowedValues: ["true", "false"] }])) as Record<string, Parameter> } }));
const allGates = Object.entries(gates).flatMap(([stack, flags]) => flags.map(flag => [stack, flag] as const));
const parameters = (stacks: ReturnType<typeof fixture>, name: string) => stacks.find(stack => stack.name === name)!.template.Parameters;

describe("offline release activation defaults", () => {
  it("accepts all four current stacks with paused activation defaults", () => {
    expect(() => assertPausedReleaseDefaults(fixture())).not.toThrow();
  });
  it.each(allGates)("rejects an enabled %s/%s", (name, flag) => {
    const stacks = fixture(); parameters(stacks, name)[flag]!.Default = "true";
    expect(() => assertPausedReleaseDefaults(stacks)).toThrow(`${name}/${flag}`);
  });
  it.each(allGates)("rejects a missing required %s/%s", (name, flag) => {
    const stacks = fixture(); delete parameters(stacks, name)[flag];
    expect(() => assertPausedReleaseDefaults(stacks)).toThrow(`${name}/${flag}`);
  });
  it.each([undefined, false, 0, "False", "FALSE", " false", "false ", ""])("rejects a nonliteral false default %j", value => {
    const stacks = fixture(); parameters(stacks, "KinApiStack").PublicApiEnabled!.Default = value;
    expect(() => assertPausedReleaseDefaults(stacks)).toThrow("KinApiStack/PublicApiEnabled");
  });
  it.each([
    { Type: "Number" }, { AllowedValues: undefined }, { AllowedValues: ["false"] },
    { AllowedValues: ["true", "false", "auto"] }, { AllowedValues: [true, false] },
  ])("rejects malformed required gate declarations %j", patch => {
    const stacks = fixture(); Object.assign(parameters(stacks, "KinEchoStack").EchoEnabled!, patch);
    expect(() => assertPausedReleaseDefaults(stacks)).toThrow("KinEchoStack/EchoEnabled");
  });
  it.each(Object.keys(gates))("rejects an unsafe newly introduced boolean parameter in %s", name => {
    const stacks = fixture(); parameters(stacks, name).FutureFeature = { Type: "String", Default: "true", AllowedValues: ["false", "true"] };
    expect(() => assertPausedReleaseDefaults(stacks)).toThrow(`${name}/FutureFeature`);
  });
  it("accepts a new default-off boolean with reversed allowed values and unrelated parameters", () => {
    const stacks = fixture(), values = parameters(stacks, "KinApiStack");
    values.FutureFeature = { Type: "String", Default: "false", AllowedValues: ["false", "true"] };
    values.McpAuthMode = { Type: "String", Default: "alexa", AllowedValues: ["alexa", "standard"] };
    values.RequiredIdentifier = { Type: "String" };
    expect(() => assertPausedReleaseDefaults(stacks)).not.toThrow();
  });
  it.each(Object.keys(gates))("rejects the missing required stack %s", name => {
    expect(() => assertPausedReleaseDefaults(fixture().filter(stack => stack.name !== name))).toThrow(name);
  });
  it("rejects duplicate stack names instead of letting a safe copy hide an unsafe one", () => {
    const stacks = fixture(); stacks.push(structuredClone(stacks[0]!));
    expect(() => assertPausedReleaseDefaults(stacks)).toThrow("KinDataStack");
  });
  it.each([undefined, null, [], "false"].map(value => [value]))("rejects missing or malformed parameters %j", value => {
    const stacks: Array<{ name: string; template: { Parameters?: unknown } }> = fixture();
    stacks[0]!.template.Parameters = value;
    expect(() => assertPausedReleaseDefaults(stacks)).toThrow("KinDataStack");
  });
});
