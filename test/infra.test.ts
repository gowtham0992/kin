import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { KinDataStack } from "../infra/kin-data-stack.js";
import { KinApiStack } from "../infra/kin-api-stack.js";

describe("Kin AWS infrastructure", () => {
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

  it("schedules the escalation worker with bounded retries and dead-letter recovery", () => {
    const app = new App();
    const template = Template.fromStack(new KinDataStack(app, "TestKinWorker"));

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "kin-escalation-worker",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Timeout: 30,
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: Match.objectLike({
          KIN_CIRCLE_ID: "demo-family",
          KIN_TIME_ZONE: "America/Denver",
          KIN_GRACE_MINUTES: "30",
        }),
      },
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      Name: "kin-escalation-sweep",
      State: "ENABLED",
      ScheduleExpression: "rate(5 minutes)",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: Match.objectLike({
        Input: '{"source":"kin.scheduler"}',
        RetryPolicy: {
          MaximumEventAgeInSeconds: 900,
          MaximumRetryAttempts: 2,
        },
        DeadLetterConfig: Match.anyValue(),
      }),
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumEventAgeInSeconds: 900,
      MaximumRetryAttempts: 1,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "kin-escalation-worker-dlq",
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });

    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("dynamodb:Query");
    expect(policies).toContain("dynamodb:UpdateItem");
    expect(policies).not.toContain("dynamodb:Scan");
    expect(policies).not.toContain("dynamodb:DeleteItem");
  });

  it("defines a fail-closed public MCP runtime behind a custom HTTPS domain", () => {
    const app = new App();
    const data = new KinDataStack(app, "ApiTestData");
    const template = Template.fromStack(new KinApiStack(app, "ApiTest", {
      table: data.table,
    }));

    template.hasParameter("OAuthIssuer", { Type: "String" });
    template.hasParameter("OAuthJwksUri", { Type: "String" });
    template.hasParameter("OAuthAuthorizationServer", { Type: "String" });

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "kin-mcp-api",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 10,
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: Match.objectLike({
          KIN_CIRCLE_ID: "demo-family",
          KIN_BEDROCK_TIMEOUT_MS: "300",
          KIN_SERVE_SIMULATOR: "false",
          KIN_MCP_RESOURCE_PARAMETER: "/kin/mcp/canonical-uri",
          KIN_OAUTH_ISSUER: Match.anyValue(),
          KIN_OAUTH_JWKS_URI: Match.anyValue(),
          KIN_WIDGET_PATH: "/var/task/widget/today.html",
        }),
      },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "kin-mcp",
      ProtocolType: "HTTP",
    });
    template.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/kin/mcp/canonical-uri",
      Type: "String",
      Value: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "kin-oauth-state",
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      SSESpecification: { SSEEnabled: true },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
        RecoveryPeriodInDays: 7,
      },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 40,
        ThrottlingRateLimit: 20,
        DetailedMetricsEnabled: true,
      },
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });

    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("bedrock:InvokeModel");
    expect(policies).toContain("foundation-model/amazon.nova-micro-v1:0");
    expect(policies).toContain("dynamodb:TransactWriteItems");
    expect(policies).toContain("ssm:GetParameter");
    expect(policies).not.toContain("dynamodb:Scan");
    expect(policies).not.toContain("dynamodb:DeleteItem");
  });
});
