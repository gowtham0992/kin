import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, it } from "vitest";
import { KinDataStack } from "../infra/kin-data-stack.js";

describe("delivery symptom monitoring", () => {
  let template: Template;
  // Synthesis actually bundles the Lambda. Do it once with an explicit cold-build
  // budget, rather than charging bundling time against each assertion's 5s limit.
  beforeAll(() => {
    template = Template.fromStack(new KinDataStack(new App(), "DeliveryMonitoringTest"));
  }, 30_000);
  it("preserves delivery metrics for manual inspection without alarms", () => {
    for (const [field, name] of [["failed", "Failed"], ["blocked", "Blocked"], ["receiptPending", "ReceiptPending"], ["stuck", "Stuck"]]) {
      template.hasResourceProperties("AWS::Logs::MetricFilter", {
        FilterPattern: '{ $.message.event = "kin.escalation_delivery.health" }',
        MetricTransformations: [{ MetricNamespace: "Kin/Delivery", MetricName: name,
          MetricValue: `$.message.${field}`, DefaultValue: 0, Unit: "Count" }],
      });
    }
  });

  it("does not recreate owner-removed alarms and preserves runtime permissions", () => {
    template.hasParameter("OperationsAlarmTopicArn", { Type: "String", Default: "" });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    template.resourceCountIs("AWS::CloudWatch::CompositeAlarm", 0);
    template.hasOutput("OperationsAlarmRouting", { Value: "ALARMS_REMOVED_BY_OWNER" });
    template.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: "dynamodb:ConditionCheckItem", Effect: "Allow",
        Condition: { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } } }),
    ]) } });
  });
});
