import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { KinReminderSyncStack } from "../infra/kin-reminder-sync-stack.js";

it("creates an isolated, retained and doubly paused worker candidate", () => {
  const template = Template.fromStack(new KinReminderSyncStack(new App(), "ReminderSyncTest", {
    careTableName: "kin-care-state", circleId: "test-circle", env: { account: "123456789012", region: "us-east-1" } }));
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "kin-echo-reminder-sync", DeletionProtectionEnabled: true, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } });
  template.hasParameter("ReminderSyncWorkerEnabled", { Default: "false" });
  template.hasParameter("ReminderSyncScheduleEnabled", { Default: "false" });
  template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 1, Environment: { Variables: { KIN_REMINDER_SYNC_WORKER_ENABLED: { Ref: "ReminderSyncWorkerEnabled" } } } });
  template.hasResourceProperties("AWS::Events::Rule", { State: { "Fn::If": ["ReminderScheduleActive", "ENABLED", "DISABLED"] } });
  const policy = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  expect(policy).toContain("CIRCLE#test-circle");
  for (const forbidden of ["dynamodb:DeleteItem", "dynamodb:UpdateItem", "sns:Publish", "iam:PassRole"]) expect(policy).not.toContain(forbidden);
  expect(JSON.stringify(template.toJSON())).toContain("KinReminderSyncRuntimeBoundary");
}, 30_000);

it("grants secret-value access to the exact colon-delimited Skill Messaging secret ARN", () => {
  const template = Template.fromStack(new KinReminderSyncStack(new App(), "ReminderSecretTest", {
    careTableName: "kin-care-state", circleId: "test-circle", env: { account: "123456789012", region: "us-east-1" } }));
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: Match.arrayWith([{
      Action: "secretsmanager:GetSecretValue",
      Effect: "Allow",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" },
        ":secretsmanager:us-east-1:123456789012:secret:kin/alexa-skill-messaging-??????"]] },
    }]) },
  });
}, 30_000);
