import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  HttpApi,
  HttpStage,
  LogGroupLogDestination,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import {
  AccountRecovery,
  Mfa,
  UserPool,
  UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
  type ITable,
} from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  ApplicationLogLevel,
  Architecture,
  LoggingFormat,
  Runtime,
  SystemLogLevel,
  Tracing,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface KinApiStackProps extends StackProps {
  table: ITable;
}

export class KinApiStack extends Stack {
  constructor(scope: Construct, id: string, props: KinApiStackProps) {
    super(scope, id, props);

    const oauthIssuerParameter = new CfnParameter(this, "OAuthIssuer", {
      type: "String",
      description: "Exact HTTPS issuer claim expected in Kin access tokens.",
      allowedPattern: "^https://.+$",
    });
    const oauthJwksUriParameter = new CfnParameter(this, "OAuthJwksUri", {
      type: "String",
      description: "HTTPS JWKS endpoint used to verify Kin access tokens.",
      allowedPattern: "^https://.+$",
    });
    const oauthAuthorizationServerParameter = new CfnParameter(
      this,
      "OAuthAuthorizationServer",
      {
        type: "String",
        description: "Authorization server URL advertised to Alexa+.",
        allowedPattern: "^https://.+$",
      },
    );
    const canonicalResourceParameterName = "/kin/mcp/canonical-uri";

    const apiLogGroup = new LogGroup(this, "ApiAccessLogs", {
      logGroupName: "/aws/apigateway/kin-mcp",
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const oauthStateTable = new Table(this, "OAuthState", {
      tableName: "kin-oauth-state",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriodInDays: 7,
      },
      timeToLiveAttribute: "expiresAt",
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userPool = new UserPool(this, "FamilyAccounts", {
      userPoolName: "kin-family-accounts",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      mfa: Mfa.OFF,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userPoolClient = new UserPoolClient(this, "FamilyAccountClient", {
      userPool,
      userPoolClientName: "kin-oauth-login",
      generateSecret: false,
      authFlows: { userPassword: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(10),
      idTokenValidity: Duration.minutes(10),
      refreshTokenValidity: Duration.days(30),
    });
    const functionLogGroup = new LogGroup(this, "ApiFunctionLogs", {
      logGroupName: "/aws/lambda/kin-mcp-api",
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const apiFunction = new NodejsFunction(this, "ApiFunction", {
      functionName: "kin-mcp-api",
      description: "Authenticated Streamable HTTP endpoint for the Kin Alexa+ MCP add-on.",
      entry: path.resolve(moduleDirectory, "../src/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      tracing: Tracing.ACTIVE,
      logGroup: functionLogGroup,
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      systemLogLevelV2: SystemLogLevel.WARN,
      environment: {
        KIN_DYNAMODB_TABLE: props.table.tableName,
        KIN_CIRCLE_ID: "demo-family",
        KIN_TIME_ZONE: "America/Denver",
        KIN_BEDROCK_MODEL_ID: "amazon.nova-micro-v1:0",
        KIN_BEDROCK_TIMEOUT_MS: "300",
        KIN_MCP_RESOURCE_PARAMETER: canonicalResourceParameterName,
        KIN_OAUTH_ISSUER: oauthIssuerParameter.valueAsString,
        KIN_OAUTH_JWKS_URI: oauthJwksUriParameter.valueAsString,
        KIN_OAUTH_AUTHORIZATION_SERVER: oauthAuthorizationServerParameter.valueAsString,
        KIN_SERVE_SIMULATOR: "false",
        KIN_WIDGET_PATH: "/var/task/widget/today.html",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        target: "node22",
        format: OutputFormat.ESM,
        banner:
          "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDirectory, outputDirectory) => [
            `mkdir -p ${outputDirectory}/widget`,
            `cp ${inputDirectory}/widget/today.html ${outputDirectory}/widget/today.html`,
          ],
        },
      },
    });
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
        "dynamodb:UpdateItem",
      ],
      resources: [props.table.tableArn],
    }));
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.nova-micro-v1:0`,
      ],
    }));
    const integration = new HttpLambdaIntegration("KinIntegration", apiFunction, {
      scopePermissionToRoute: false,
    });
    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: "kin-mcp",
      description: "Public HTTPS transport for the Kin Alexa+ MCP add-on.",
      defaultIntegration: integration,
      createDefaultStage: false,
    });
    const stage = new HttpStage(this, "DefaultStage", {
      httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
      detailedMetricsEnabled: true,
      accessLogSettings: {
        destination: new LogGroupLogDestination(apiLogGroup),
        format: AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: false,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
      },
    });
    const canonicalMcpUri = `${httpApi.apiEndpoint}/mcp`;
    const canonicalResourceParameter = new StringParameter(
      this,
      "CanonicalResourceParameter",
      {
        parameterName: canonicalResourceParameterName,
        description: "Canonical AWS-hosted resource URI for Kin OAuth audience validation.",
        stringValue: canonicalMcpUri,
      },
    );
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ssm:GetParameter"],
      resources: [canonicalResourceParameter.parameterArn],
    }));

    new Alarm(this, "ApiServerErrors", {
      alarmName: "kin-mcp-api-server-errors",
      alarmDescription: "Kin's public MCP endpoint is returning server errors.",
      metric: stage.metricServerError({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, "ApiP95Latency", {
      alarmName: "kin-mcp-api-p95-latency",
      alarmDescription: "Kin's p95 API latency exceeds Alexa+'s 500 ms budget.",
      metric: stage.metricLatency({
        period: Duration.minutes(5),
        statistic: "p95",
      }),
      threshold: 450,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, "CanonicalMcpUri", { value: canonicalMcpUri });
    new CfnOutput(this, "OAuthStateTableName", { value: oauthStateTable.tableName });
    new CfnOutput(this, "FamilyUserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "FamilyUserPoolClientId", { value: userPoolClient.userPoolClientId });
  }
}
