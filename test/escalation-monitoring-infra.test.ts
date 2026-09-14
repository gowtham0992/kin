import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { KinDataStack } from "../infra/kin-data-stack.js";

describe("delivery symptom monitoring", () => {
  let template: Template;
  // Synthesis actually bundles the Lambda. Do it once with an explicit cold-build
  // budget, rather than charging bundling time against each assertion's 5s limit.
  beforeAll(() => {
    template = Template.fromStack(new KinDataStack(new App(), "DeliveryMonitoringTest"));
  }, 30_000);
  it("alarms on failed, blocked, uncertain and stuck deliveries even when Lambda succeeds", () => {
    for (const [field, name] of [["failed", "Failed"], ["blocked", "Blocked"], ["receiptPending", "ReceiptPending"], ["stuck", "Stuck"]]) {
      template.hasResourceProperties("AWS::Logs::MetricFilter", {
        FilterPattern: '{ $.message.event = "kin.escalation_delivery.health" }',
        MetricTransformations: [{ MetricNamespace: "Kin/Delivery", MetricName: name,
          MetricValue: `$.message.${field}`, DefaultValue: 0, Unit: "Count" }],
      });
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "Kin/Delivery", MetricName: name, Statistic: "Maximum", Period: 300,
        Threshold: 1, EvaluationPeriods: 1, TreatMissingData: "notBreaching",
        AlarmDescription: Match.stringLikeRegexp("docs/delivery-operations.md"),
      });
    }
  });

  it("routes every worker alarm only to an explicitly supplied operator topic", () => {
    template.hasParameter("OperationsAlarmTopicArn", { Type: "String", Default: "" });
    template.hasCondition("OperationsAlarmDestinationConfigured", {
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "OperationsAlarmTopicArn" }, ""] }],
    });
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
    expect(alarms).toHaveLength(6);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toEqual({ "Fn::If": ["OperationsAlarmDestinationConfigured",
        [{ Ref: "OperationsAlarmTopicArn" }], { Ref: "AWS::NoValue" }] });
      expect(JSON.stringify(alarm.Properties.AlarmActions)).not.toContain("CareAlerts");
    }
    template.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Action: "dynamodb:ConditionCheckItem", Effect: "Allow",
        Condition: { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } } }),
    ]) } });
  });
});
