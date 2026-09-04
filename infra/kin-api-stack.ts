import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  CfnParameter,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  HttpApi,
  HttpMethod,
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
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Provider as CustomResourceProvider } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface KinApiStackProps extends StackProps {
  table: ITable;
}

export class KinApiStack extends Stack {
  constructor(scope: Construct, id: string, props: KinApiStackProps) {
    super(scope, id, props);

    const alexaRedirectUrisParameter = new CfnParameter(this, "AlexaRedirectUris", {
      type: "String",
      default: "",
      description: "Comma-separated exact HTTPS callback URIs supplied by Alexa MCP Toolkit.",
      allowedPattern: "^$|^https://[^,]+(,https://[^,]+)*$",
    });
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
    const oauthSecret = new Secret(this, "OAuthConfiguration", {
      secretName: "kin/oauth/configuration",
      description: "Kin OAuth signing JWK, cookie keys, CSRF key, and Alexa client credentials.",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const secretProvisionerLogGroup = new LogGroup(this, "OAuthSecretProvisionerLogs", {
      logGroupName: "/aws/lambda/kin-oauth-secret-provisioner",
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const secretProvisioner = new NodejsFunction(this, "OAuthSecretProvisioner", {
      functionName: "kin-oauth-secret-provisioner",
      description: "Idempotently creates Kin OAuth key material without exposing it to CloudFormation.",
      entry: path.resolve(moduleDirectory, "oauth-secret-provider.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      logGroup: secretProvisionerLogGroup,
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      systemLogLevelV2: SystemLogLevel.WARN,
      bundling: { minify: true, sourceMap: true, sourcesContent: false, target: "node22" },
    });
    oauthSecret.grantRead(secretProvisioner);
    oauthSecret.grantWrite(secretProvisioner);
    const secretProvider = new CustomResourceProvider(this, "OAuthSecretProvider", {
      onEventHandler: secretProvisioner,
      logGroup: new LogGroup(this, "OAuthSecretProviderFrameworkLogs", {
        logGroupName: "/aws/lambda/kin-oauth-secret-provider-framework",
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
    });
    const secretProvisioning = new CustomResource(this, "OAuthSecretMaterial", {
      serviceToken: secretProvider.serviceToken,
      properties: { SecretId: oauthSecret.secretArn, SchemaVersion: 1 },
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
    const oauthFunctionLogGroup = new LogGroup(this, "OAuthFunctionLogs", {
      logGroupName: "/aws/lambda/kin-oauth-api",
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const oauthFunction = new NodejsFunction(this, "OAuthFunction", {
      functionName: "kin-oauth-api",
      description: "Standards-compliant OAuth server and family account-linking interaction for Alexa+.",
      entry: path.resolve(moduleDirectory, "../src/oauth-lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 768,
      timeout: Duration.seconds(10),
      tracing: Tracing.ACTIVE,
      logGroup: oauthFunctionLogGroup,
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      systemLogLevelV2: SystemLogLevel.WARN,
      environment: {
        KIN_OAUTH_ISSUER: httpApi.apiEndpoint,
        KIN_MCP_RESOURCE_URI: `${httpApi.apiEndpoint}/mcp`,
        KIN_OAUTH_STATE_TABLE: oauthStateTable.tableName,
        KIN_COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        KIN_OAUTH_SECRET_ID: oauthSecret.secretArn,
        KIN_ALEXA_REDIRECT_URIS: alexaRedirectUrisParameter.valueAsString,
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
      },
    });
    oauthFunction.node.addDependency(secretProvisioning);
    oauthSecret.grantRead(oauthFunction);
    oauthFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
        "dynamodb:UpdateItem",
      ],
      resources: [oauthStateTable.tableArn],
    }));
    const oauthIntegration = new HttpLambdaIntegration("KinOAuthIntegration", oauthFunction, {
      scopePermissionToRoute: false,
    });
    for (const route of [
      { path: "/.well-known/oauth-authorization-server", methods: [HttpMethod.GET] },
      { path: "/.well-known/openid-configuration", methods: [HttpMethod.GET] },
      { path: "/auth", methods: [HttpMethod.GET, HttpMethod.POST] },
      { path: "/token", methods: [HttpMethod.POST] },
      { path: "/jwks", methods: [HttpMethod.GET] },
      { path: "/token/revocation", methods: [HttpMethod.POST] },
      { path: "/interaction/{proxy+}", methods: [HttpMethod.ANY] },
    ]) {
      httpApi.addRoutes({ ...route, integration: oauthIntegration });
    }
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
    apiFunction.addEnvironment("KIN_OAUTH_ISSUER", httpApi.apiEndpoint);
    apiFunction.addEnvironment("KIN_OAUTH_JWKS_URI", `${httpApi.apiEndpoint}/jwks`);
    apiFunction.addEnvironment("KIN_OAUTH_AUTHORIZATION_SERVER", httpApi.apiEndpoint);
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
    new CfnOutput(this, "OAuthIssuer", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "OAuthJwksUri", { value: `${httpApi.apiEndpoint}/jwks` });
    new CfnOutput(this, "OAuthConfigurationSecretArn", { value: oauthSecret.secretArn });
    new CfnOutput(this, "OAuthStateTableName", { value: oauthStateTable.tableName });
    new CfnOutput(this, "FamilyUserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "FamilyUserPoolClientId", { value: userPoolClient.userPoolClientId });
  }
}
