import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { KinDataStack } from "../infra/kin-data-stack.js";

describe("Kin AWS data infrastructure", () => {
  it("synthesizes an encrypted, recoverable, on-demand table", () => {
    const app = new App();
    const template = Template.fromStack(new KinDataStack(app, "TestKinData"));

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "kin-care-state",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      SSESpecification: { SSEEnabled: true },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
        RecoveryPeriodInDays: 7,
      },
    });

    const resources = template.findResources("AWS::DynamoDB::Table");
    expect(Object.values(resources)[0]).toMatchObject({
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });

    template.hasResourceProperties("AWS::SNS::Topic", {
      TopicName: "kin-care-alerts",
      DisplayName: "Kin care alerts",
      KmsMasterKeyId: Match.anyValue(),
    });

    template.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ],
      },
    });
  });
});
