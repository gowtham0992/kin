import { CfnCondition, CfnOutput, CfnParameter, Fn, Stack, Token } from "aws-cdk-lib";
import { type Alarm, CfnAlarm } from "aws-cdk-lib/aws-cloudwatch";

/** Destination only; never creates a subscription or reuses the care-alert topic.
 * An ARN is not receipt evidence. Operators verify their destination before use.
 */
export function configureOperationsRouting(stack: Stack, alarms: Alarm[]) {
  const topic = new CfnParameter(stack, "OperationsAlarmTopicArn", {
    type: "String", default: "",
    allowedPattern: "^(?:|arn:aws:sns:us-east-1:[0-9]{12}:kin-operations(?:-[A-Za-z0-9_-]+)?)(?![\\s\\S])",
    description: "Existing verified operator SNS destination named kin-operations (or kin-operations-*), never the family care-alert topic. Empty leaves actions unconfigured.",
  });
  const configured = new CfnCondition(stack, "OperationsAlarmDestinationConfigured", {
    expression: Fn.conditionNot(Fn.conditionEquals(topic.valueAsString, "")),
  });
  for (const alarm of alarms) {
    const resource = alarm.node.defaultChild as CfnAlarm;
    resource.alarmActions = Token.asList(Fn.conditionIf(configured.logicalId, [topic.valueAsString], { Ref: "AWS::NoValue" }));
  }
  new CfnOutput(stack, "OperationsAlarmRouting", {
    value: Fn.conditionIf(configured.logicalId, topic.valueAsString, "NOT_CONFIGURED").toString(),
    description: "Configuration only; verify an actual operator receipt and recovery before claiming monitoring is complete.",
  });
}
