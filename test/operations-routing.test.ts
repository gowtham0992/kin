import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { KinApiStack } from "../infra/kin-api-stack.js";
import { KinReminderSyncStack } from "../infra/kin-reminder-sync-stack.js";

it.each(["api", "reminder"])("keeps %s alarms removed without changing subscriptions", kind => {
  const app = new App();
  const env = { account: "123456789012", region: "us-east-1" };
  const stack = kind === "api" ? new KinApiStack(app, "ApiOperations", { env })
    : new KinReminderSyncStack(app, "ReminderOperations", { env, careTableName: "kin-care-state", circleId: "test-circle" });
  const template = Template.fromStack(stack);
  template.hasParameter("OperationsAlarmTopicArn", { Default: "" });
  const parameter = template.toJSON().Parameters.OperationsAlarmTopicArn;
  const valid = new RegExp(parameter.AllowedPattern);
  for (const accepted of ["", "arn:aws:sns:us-east-1:123456789012:kin-operations"]) expect(valid.test(accepted)).toBe(true);
  for (const rejected of ["https://example.com", "*", "arn:aws:sns:us-east-1:123456789012:kin-care-alerts", "arn:aws:sns:us-east-1:123456789012:kin-operations\n"]) expect(valid.test(rejected)).toBe(false);
  template.resourceCountIs("AWS::SNS::Subscription", 0);
  template.resourceCountIs("AWS::SNS::Topic", 0);
  template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  template.resourceCountIs("AWS::CloudWatch::CompositeAlarm", 0);
  template.hasOutput("OperationsAlarmRouting", { Value: "ALARMS_REMOVED_BY_OWNER" });
}, 30_000);
