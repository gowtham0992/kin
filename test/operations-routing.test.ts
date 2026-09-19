import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { KinApiStack } from "../infra/kin-api-stack.js";
import { KinReminderSyncStack } from "../infra/kin-reminder-sync-stack.js";

it.each(["api", "reminder"])("allows optional operator routing for %s without creating subscriptions", kind => {
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
  const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
  expect(alarms).toHaveLength(kind === "api" ? 2 : 1);
  for (const alarm of alarms) {
    if (alarm.Properties.AlarmName === "kin-mcp-api-p95-latency") {
      // Aggregate latency includes deliberately slower model-backed Week reads.
      expect(alarm.Properties.AlarmActions).toBeUndefined();
      expect(alarm.Properties.Threshold).toBe(450);
    } else {
      expect(alarm.Properties.AlarmActions).toEqual({ "Fn::If": ["OperationsAlarmDestinationConfigured", [{ Ref: "OperationsAlarmTopicArn" }], { Ref: "AWS::NoValue" }] });
    }
    expect(alarm.Properties.AlarmDescription).toContain("docs/delivery-operations.md");
  }
  template.hasOutput("OperationsAlarmRouting", { Value: { "Fn::If": ["OperationsAlarmDestinationConfigured", { Ref: "OperationsAlarmTopicArn" }, "NOT_CONFIGURED"] } });
}, 30_000);
