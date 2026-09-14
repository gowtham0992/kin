import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { KinEchoStack } from "../infra/kin-echo-stack.js";
import { KinApiStack } from "../infra/kin-api-stack.js";
import { KinReminderSyncStack } from "../infra/kin-reminder-sync-stack.js";

const env = { account: "123456789012", region: "us-east-1" };

it("keeps ticket issuance opt-in on the API without giving OAuth the flag", () => {
  const template = Template.fromStack(new KinApiStack(new App(), "TicketRollout", { env }));
  template.hasParameter("ReminderTicketsEnabled", { Default: "false", AllowedValues: ["true", "false"] });
  template.hasParameter("CompletionUndoEnabled", { Default: "false", AllowedValues: ["true", "false"] });
  template.hasParameter("RescheduleEnabled", { Default: "false", AllowedValues: ["true", "false"] });
  template.hasParameter("PlanPauseEnabled", { Default: "false", AllowedValues: ["true", "false"] });
  template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "kin-mcp-api",
    Environment: { Variables: { KIN_REMINDER_TICKETS_ENABLED: { Ref: "ReminderTicketsEnabled" } } } });
  const oauth = Object.values(template.findResources("AWS::Lambda::Function"))
    .find(resource => resource.Properties.FunctionName === "kin-oauth-api")!;
  expect(oauth.Properties.Environment.Variables).not.toHaveProperty("KIN_REMINDER_TICKETS_ENABLED");
  template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "kin-mcp-api", Environment: { Variables: {
    KIN_COMPLETION_UNDO_ENABLED: { Ref: "CompletionUndoEnabled" }, KIN_RESCHEDULE_ENABLED: { Ref: "RescheduleEnabled" },
    KIN_PLAN_PAUSE_ENABLED: { Ref: "PlanPauseEnabled" },
  } } });
  expect(oauth.Properties.Environment.Variables).not.toHaveProperty("KIN_COMPLETION_UNDO_ENABLED");
  expect(oauth.Properties.Environment.Variables).not.toHaveProperty("KIN_RESCHEDULE_ENABLED");
}, 30_000);

it("gates Echo consent offers behind the receiver and scopes job permissions to cancellation keys", () => {
  const template = Template.fromStack(new KinEchoStack(new App(), "EchoRollout", { env }));
  for (const parameter of ["EchoReminderSyncEnabled", "EchoPlanCancelSyncEnabled", "EchoUndoEnabled", "EchoPlanPauseEnabled"]) {
    template.hasParameter(parameter, { Default: "false", AllowedValues: ["true", "false"] });
  }
  template.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: {
    KIN_ECHO_REMINDER_SYNC_ENABLED: { Ref: "EchoReminderSyncEnabled" },
    KIN_ECHO_PLAN_CANCEL_SYNC_ENABLED: { Ref: "EchoPlanCancelSyncEnabled" },
    KIN_ECHO_REMINDER_SYNC_TABLE: "kin-echo-reminder-sync",
    KIN_ECHO_UNDO_ENABLED: { Ref: "EchoUndoEnabled" },
    KIN_ECHO_PLAN_PAUSE_ENABLED: { Ref: "EchoPlanPauseEnabled" },
  } } });
  const rules = template.toJSON().Rules;
  expect(rules.EchoSyncOffersRequireReceiver).toEqual({
    RuleCondition: { "Fn::Equals": [{ Ref: "EchoPlanCancelSyncEnabled" }, "true"] },
    Assertions: [{ Assert: { "Fn::And": [
      { "Fn::Equals": [{ Ref: "EchoReminderSyncEnabled" }, "true"] },
      { "Fn::Equals": [{ Ref: "EchoCareEnabled" }, "true"] },
      { "Fn::Equals": [{ Ref: "EchoReminderTestEnabled" }, "true"] },
    ] }, AssertDescription: "Synchronized offers require the receiver, linked care, and consented reminders." }],
  });
  const policies = Object.values(template.findResources("AWS::IAM::Policy"));
  const policy = policies.find(item => item.Condition === "EchoSyncReceiverEnabled")!;
  expect(policy).toBeDefined();
  expect(policy.Properties.PolicyDocument.Statement).toEqual([{
    Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"], Effect: "Allow",
    Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":dynamodb:us-east-1:123456789012:table/kin-echo-reminder-sync"]] },
    Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CANCEL#*"] } },
  }]);
}, 30_000);

it("makes worker and schedule independently pausable and forbids scheduling a paused worker", () => {
  const template = Template.fromStack(new KinReminderSyncStack(new App(), "WorkerRollout", {
    careTableName: "kin-care-state", circleId: "test-circle", env }));
  for (const parameter of ["ReminderSyncWorkerEnabled", "ReminderSyncScheduleEnabled"]) {
    template.hasParameter(parameter, { Default: "false", AllowedValues: ["true", "false"] });
  }
  template.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: {
    KIN_REMINDER_SYNC_WORKER_ENABLED: { Ref: "ReminderSyncWorkerEnabled" },
  } } });
  template.hasResourceProperties("AWS::Events::Rule", { State: { "Fn::If": ["ReminderScheduleActive", "ENABLED", "DISABLED"] } });
  expect(template.toJSON().Rules.ScheduleRequiresWorker).toEqual({
    RuleCondition: { "Fn::Equals": [{ Ref: "ReminderSyncScheduleEnabled" }, "true"] },
    Assertions: [{ Assert: { "Fn::Equals": [{ Ref: "ReminderSyncWorkerEnabled" }, "true"] },
      AssertDescription: "Enable the worker before enabling its schedule." }],
  });
  template.hasOutput("WorkerFunctionName", { Value: Match.anyValue() });
}, 30_000);
