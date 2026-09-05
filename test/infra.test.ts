import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { KinDataStack } from "../infra/kin-data-stack.js";
import { KinApiStack } from "../infra/kin-api-stack.js";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";

describe("Kin AWS infrastructure", () => {
  it("issues a valid service JWT from the actual minified OAuth deployment artifact", async () => {
    const app = new App();
    const stack = new KinApiStack(app, "BundledOAuthTest", {});
    const template = Template.fromStack(stack);
    const resources = template.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: "kin-oauth-api" },
    });
    const codeKey = Object.values(resources)[0]!.Properties.Code.S3Key as string;
    const assembly = app.synth();
    const moduleUrl = pathToFileURL(path.join(assembly.directory, `asset.${codeKey.replace(/\.zip$/, "")}`, "index.mjs")).href;
    const { createConfiguredOAuthApp } = await import(/* @vite-ignore */ moduleUrl);
    const pair = await generateKeyPair("RS256", { extractable: true });
    const key = await exportJWK(pair.privateKey);
    const issuer = "https://api.example.com";
    const serviceClient = { clientId: "bundled-service-client", clientSecret: "test-secret-32-characters-or-more!" };
    const oauth = await createConfiguredOAuthApp({
      KIN_OAUTH_ISSUER: issuer,
      KIN_MCP_RESOURCE_URI: `${issuer}/mcp`,
      KIN_OAUTH_STATE_TABLE: "test-state",
      KIN_COGNITO_CLIENT_ID: "test-cognito-client",
      KIN_OAUTH_SECRET_ID: "test-secret",
    }, {
      secrets: {
        schemaVersion: 1,
        jwks: { keys: [{ ...key, kid: "bundle-test", use: "sig", alg: "RS256" }] },
        cookieKeys: ["a".repeat(32), "b".repeat(32)],
        csrfSecret: "c".repeat(32),
        serviceClient,
      },
      adapter: class TestAdapter {},
    });
    const response = await request(oauth).post("/token")
      .auth(serviceClient.clientId, serviceClient.clientSecret)
      .type("form")
      .send({ grant_type: "client_credentials", scope: "mcp:service", resource: `${issuer}/mcp` });
    expect(response.status).toBe(200);
    const { payload } = await jwtVerify(response.body.access_token, pair.publicKey, {
      issuer, audience: `${issuer}/mcp`, algorithms: ["RS256"],
    });
    expect(payload.scope).toBe("mcp:service");
    expect(response.body.expires_in).toBe(3600);
  }, 30_000);

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

  it("defines a fail-closed public MCP runtime on AWS-managed HTTPS", () => {
    const app = new App();
    const template = Template.fromStack(new KinApiStack(app, "ApiTest", {}));

    template.hasParameter("AlexaRedirectUris", { Type: "String", Default: "" });
    template.hasParameter("PublicApiEnabled", {
      Type: "String",
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    expect(template.findParameters("OAuthIssuer")).toEqual({});
    expect(template.findParameters("OAuthJwksUri")).toEqual({});

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
          KIN_PUBLIC_API_ENABLED: Match.anyValue(),
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
    for (const routeKey of [
      "GET /.well-known/oauth-authorization-server",
      "GET /.well-known/openid-configuration",
      "GET /auth",
      "POST /auth",
      "POST /token",
      "GET /jwks",
      "POST /token/revocation",
      "ANY /interaction/{proxy+}",
    ]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: routeKey });
    }
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
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "kin-family-accounts",
      DeletionProtection: "ACTIVE",
      UsernameConfiguration: { CaseSensitive: false },
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          RequireUppercase: true,
        }),
      },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "kin-oauth-login",
      GenerateSecret: false,
      PreventUserExistenceErrors: "ENABLED",
      EnableTokenRevocation: true,
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"]),
    });
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "kin/oauth/configuration",
      Description: Match.stringLikeRegexp("OAuth signing JWK"),
      SecretString: '{"schemaVersion":0,"state":"pending-provisioning"}',
    });
    const secrets = template.findResources("AWS::SecretsManager::Secret");
    expect(Object.values(secrets)[0]).toMatchObject({
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "kin-oauth-api",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 768,
      Timeout: 10,
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: Match.objectLike({
          KIN_OAUTH_ISSUER: Match.anyValue(),
          KIN_MCP_RESOURCE_URI: Match.anyValue(),
          KIN_OAUTH_STATE_TABLE: Match.anyValue(),
          KIN_COGNITO_CLIENT_ID: Match.anyValue(),
          KIN_OAUTH_SECRET_ID: Match.anyValue(),
          KIN_ALEXA_REDIRECT_URIS: Match.anyValue(),
          KIN_PUBLIC_API_ENABLED: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "kin-oauth-secret-provisioner",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
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
    expect(policies).toContain("secretsmanager:GetSecretValue");
    expect(policies).toContain("secretsmanager:PutSecretValue");
    expect(policies).not.toContain("dynamodb:Scan");
    expect(policies).not.toContain("dynamodb:DeleteItem");
  });
});
