import { CfnOutput, CfnParameter, Stack } from "aws-cdk-lib";

/** Legacy deployment parameter only; owner-requested alarm removal is explicit. */
export function configureOperationsRouting(stack: Stack) {
  // Retain the parameter for compatibility with existing deployment controls.
  // The owner requested no CloudWatch alarms; this destination is inactive.
  new CfnParameter(stack, "OperationsAlarmTopicArn", {
    type: "String", default: "",
    allowedPattern: "^(?:|arn:aws:sns:us-east-1:[0-9]{12}:kin-operations(?:-[A-Za-z0-9_-]+)?)(?![\\s\\S])",
    description: "Legacy operator destination retained for deployment compatibility. Inactive: CloudWatch alarms removed by owner request.",
  });
  new CfnOutput(stack, "OperationsAlarmRouting", {
    value: "ALARMS_REMOVED_BY_OWNER",
    description: "No CloudWatch alarms. Inspect service logs and delivery state manually.",
  });
}
