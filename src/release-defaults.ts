const requiredActivationFlags: Record<string, readonly string[]> = {
  KinDataStack: ["WebPushEnabled", "EscalationWorkerEnabled", "EscalationScheduleEnabled"],
  KinApiStack: ["WebPushEnabled", "PublicApiEnabled", "FamilyWorkspaceEnabled", "FamilyEnrollmentEnabled",
    "InvitationIssuingEnabled", "FamilyConversationEnabled", "ReminderTicketsEnabled", "CompletionUndoEnabled",
    "RescheduleEnabled", "PlanPauseEnabled"],
  KinEchoStack: ["EchoEnabled", "EchoCareEnabled", "EchoReminderTestEnabled", "EchoReminderSyncEnabled",
    "EchoUndoEnabled", "EchoPlanPauseEnabled", "EchoPlanCancelSyncEnabled"],
  KinReminderSyncStack: ["ReminderSyncWorkerEnabled", "ReminderSyncScheduleEnabled"],
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const booleanValues = (value: unknown) => Array.isArray(value) && value.length === 2 &&
  value.includes("true") && value.includes("false");

function requirePaused(stack: string, flag: string, parameter: unknown) {
  if (!record(parameter) || parameter.Type !== "String" || !booleanValues(parameter.AllowedValues) || parameter.Default !== "false") {
    throw new Error(`Missing, malformed, or unpaused release default ${stack}/${flag}`);
  }
}

/** Local preparation guard only. It neither overrides nor proves live deployment parameters. */
export function assertPausedReleaseDefaults(stacks: readonly { name: string; template: unknown }[]): void {
  for (const name of Object.keys(requiredActivationFlags)) {
    if (stacks.filter(stack => stack.name === name).length !== 1) throw new Error(`Expected exactly one release stack ${name}`);
  }
  for (const stack of stacks) {
    const parameters = record(stack.template) ? stack.template.Parameters : undefined;
    if (!record(parameters)) throw new Error(`Missing or malformed release parameters for ${stack.name}`);
    for (const flag of requiredActivationFlags[stack.name] ?? []) requirePaused(stack.name, flag, parameters[flag]);
    // Future Boolean switches must also stay off, even before their names join the required list.
    for (const [flag, parameter] of Object.entries(parameters)) {
      if (record(parameter) && booleanValues(parameter.AllowedValues)) requirePaused(stack.name, flag, parameter);
    }
  }
}
