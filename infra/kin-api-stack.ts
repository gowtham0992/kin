import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArnFormat,
  CfnOutput,
  CfnParameter,
  CustomResource,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  CfnRoute,
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
import { configureOperationsRouting } from "./operations-routing.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export type KinApiStackProps = StackProps;

export class KinApiStack extends Stack {
  constructor(scope: Construct, id: string, props: KinApiStackProps) {
    super(scope, id, props);
    const publicSiteOrigin = new CfnParameter(this, "PublicSiteOrigin", {
      type: "String", default: "", allowedPattern: "^$|^https://[a-z0-9.-]+$",
      description: "Optional public-site alias only; workspace, OAuth issuer, Echo and push origins stay unchanged.",
    });
    const webPushEnabled = new CfnParameter(this, "WebPushEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Expose opt-in caregiver push only after the worker and application key are configured.",
    });
    const webPushPublicKey = new CfnParameter(this, "WebPushPublicKey", {
      type: "String", default: "", allowedPattern: "^$|^[A-Za-z0-9_-]{87}$",
      description: "Public VAPID application key only. Never place the private key in this parameter.",
    });

    const alexaRedirectUrisParameter = new CfnParameter(this, "AlexaRedirectUris", {
      type: "String",
      default: "",
      description: "Comma-separated exact HTTPS callback URIs supplied by Alexa MCP Toolkit.",
      allowedPattern: "^$|^https://[^,]+(,https://[^,]+)*$",
    });
    const echoRedirectUrisParameter = new CfnParameter(this, "EchoRedirectUris", {
      type: "String",
      default: "",
      description: "Comma-separated exact HTTPS Alexa redirect URLs copied from the classic Kin skill account-linking console. Keep empty until the separate Echo OAuth client is provisioned.",
      allowedPattern: "^$|^https://[^\\s,@#*]+(,https://[^\\s,@#*]+)*$",
    });
    const publicApiEnabledParameter = new CfnParameter(this, "PublicApiEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Deployment safety switch. Promote to true only after disabled-state verification.",
    });
    const mcpAuthMode = new CfnParameter(this, "McpAuthMode", {
      type: "String", default: "alexa", allowedValues: ["alexa", "standard"],
      description: "Select standard for ordinary preregistered MCP OAuth clients; alexa preserves the existing discovery profile. This does not register clients.",
    });
    const canonicalResourceParameterName = "/kin/mcp/canonical-uri";
    const desktopAuthEnabled = new CfnParameter(this, "DesktopAuthEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Register the fixed public desktop acceptance client only after a separately reviewed OAuth rollout. Use standard MCP discovery for its SDK journey.",
    });
    const familyWorkspaceEnabled = new CfnParameter(this, "FamilyWorkspaceEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable authenticated browser care workspace and account access management. Keep false until the family account is provisioned and verified.",
    });
    const familyEnrollmentEnabled = new CfnParameter(this, "FamilyEnrollmentEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"], description: "Enable explicit invitation acceptance during account linking.",
    });
    const browserSessionEnabled = new CfnParameter(this, "BrowserSessionEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable refresh-safe HttpOnly workspace sessions after the matching API and browser assets are deployed.",
    });
    const invitationIssuingEnabled = new CfnParameter(this, "InvitationIssuingEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"], description: "Enable organizer-only invitation creation for existing confirmed accounts.",
    });
    const familyConversationEnabled = new CfnParameter(this, "FamilyConversationEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable optional per-request-consented Bedrock interpretation for authenticated family members. Keep disabled until separately approved.",
    });
    const reminderTicketsEnabled = new CfnParameter(this, "ReminderTicketsEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Issue consent tickets only after the isolated cancellation receiver and runtime grants are verified.",
    });
    const completionUndoEnabled = new CfnParameter(this, "CompletionUndoEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable completion undo only after compatible API and Echo readers are the verified rollback baseline.",
    });
    const rescheduleEnabled = new CfnParameter(this, "RescheduleEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable reviewed one-off rescheduling only after compatible API and Echo readers are the verified rollback baseline.",
    });
    const closeUnansweredEnabled = new CfnParameter(this, "CloseUnansweredEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable overdue closure only after API, Echo, and worker readers accept closed_unanswered. Keep compatible rollback artifacts.",
    });
    const planPauseEnabled = new CfnParameter(this, "PlanPauseEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable reviewed one-week pauses only after every task writer honors plan-control versions. Retain compatible writers on rollback.",
    });
    const careStateTable = Table.fromTableName(this, "CareState", "kin-care-state");

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
      secretStringValue: SecretValue.unsafePlainText('{"schemaVersion":0,"state":"pending-provisioning"}'),
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
        KIN_DYNAMODB_TABLE: careStateTable.tableName,
        KIN_CIRCLE_ID: "demo-family",
        KIN_TIME_ZONE: "America/Denver",
        KIN_BEDROCK_MODEL_ID: "amazon.nova-micro-v1:0",
        KIN_BEDROCK_TIMEOUT_MS: "300",
        KIN_WORKSPACE_BEDROCK_TIMEOUT_MS: "5000",
        KIN_MCP_RESOURCE_PARAMETER: canonicalResourceParameterName,
        KIN_MCP_AUTH_MODE: mcpAuthMode.valueAsString,
        KIN_PUBLIC_API_ENABLED: publicApiEnabledParameter.valueAsString,
        KIN_SERVE_SIMULATOR: "false",
        KIN_FAMILY_WORKSPACE_ENABLED: familyWorkspaceEnabled.valueAsString,
        KIN_BROWSER_SESSION_ENABLED: browserSessionEnabled.valueAsString,
        KIN_WEB_PUSH_ENABLED: webPushEnabled.valueAsString,
        KIN_FOLLOW_UP_PROCESSING_PARAMETER: "/kin/runtime/follow-up-processing",
        KIN_WEB_PUSH_PUBLIC_KEY: webPushPublicKey.valueAsString,
        KIN_FAMILY_CONVERSATION_ENABLED: familyConversationEnabled.valueAsString,
        KIN_REMINDER_TICKETS_ENABLED: reminderTicketsEnabled.valueAsString,
        KIN_COMPLETION_UNDO_ENABLED: completionUndoEnabled.valueAsString,
        KIN_RESCHEDULE_ENABLED: rescheduleEnabled.valueAsString,
        KIN_CLOSE_UNANSWERED_ENABLED: closeUnansweredEnabled.valueAsString,
        KIN_PLAN_PAUSE_ENABLED: planPauseEnabled.valueAsString,
        KIN_BROWSER_AUTH_ENABLED: familyWorkspaceEnabled.valueAsString,
        KIN_BROWSER_CLIENT_ID: "kin-family-browser",
        KIN_INVITATION_ISSUING_ENABLED: invitationIssuingEnabled.valueAsString,
        KIN_COGNITO_USER_POOL_ID: userPool.userPoolId,
        KIN_CIRCLE_NAME: "Kin family circle",
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
            `node --import tsx "${inputDirectory}/scripts/build-widget.ts" "${outputDirectory}/widget/today.html"`,
            `node --import tsx "${inputDirectory}/scripts/build-family.ts" "${outputDirectory}/family"`,
          ],
        },
      },
    });
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["cognito-idp:AdminGetUser"],
      resources: [userPool.userPoolArn],
    }));
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
        "dynamodb:UpdateItem",
      ],
      resources: [careStateTable.tableArn],
    }));
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.nova-micro-v1:0`,
      ],
    }));
    // Invitation and revocation transactions recheck membership atomically.
    // Self-connection replaces only an unused, self-created roster entry; the
    // application transaction retains its prior record in the request receipt.
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW, actions: ["dynamodb:DeleteItem"], resources: [careStateTable.tableArn],
      conditions: { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] },
        "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["CIRCLE#demo-family"] } },
    }));
    apiFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:ConditionCheckItem"],
      resources: [careStateTable.tableArn],
      conditions: { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } },
    }));
    const integration = new HttpLambdaIntegration("KinIntegration", apiFunction, {
      scopePermissionToRoute: true,
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
        KIN_COGNITO_USER_POOL_ID: userPool.userPoolId,
        KIN_OAUTH_SECRET_ID: oauthSecret.secretArn,
        KIN_ALEXA_REDIRECT_URIS: alexaRedirectUrisParameter.valueAsString,
        KIN_ECHO_REDIRECT_URIS: echoRedirectUrisParameter.valueAsString,
        KIN_PUBLIC_API_ENABLED: publicApiEnabledParameter.valueAsString,
        KIN_BROWSER_AUTH_ENABLED: familyWorkspaceEnabled.valueAsString,
        KIN_BROWSER_CLIENT_ID: "kin-family-browser",
        KIN_BROWSER_REDIRECT_URI: `${httpApi.apiEndpoint}/invite.html`,
        KIN_DESKTOP_AUTH_ENABLED: desktopAuthEnabled.valueAsString,
        KIN_FAMILY_ENROLLMENT_ENABLED: familyEnrollmentEnabled.valueAsString,
        KIN_DYNAMODB_TABLE: careStateTable.tableName,
        KIN_CIRCLE_ID: "demo-family",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        // oidc-provider resolves token formats using constructor.name.
        keepNames: true,
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
      effect: Effect.ALLOW, actions: ["cognito-idp:AdminGetUser"], resources: [userPool.userPoolArn],
    }));
    oauthFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW, actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"], resources: [careStateTable.tableArn],
    }));
    // Enrollment checks the roster and creates access only in one transaction.
    oauthFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:ConditionCheckItem", "dynamodb:PutItem"],
      resources: [careStateTable.tableArn],
      conditions: { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } },
    }));
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
    oauthFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:DeleteItem"],
      resources: [oauthStateTable.tableArn],
      conditions: { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } },
    }));
    const oauthIntegration = new HttpLambdaIntegration("KinOAuthIntegration", oauthFunction, {
      scopePermissionToRoute: false,
    });
    // These identities were installed by the route-only production repair.
    // Preserve them so a later CDK release updates rather than recreates routes.
    const sessionRouteIds: Record<string, string> = {
      "GET /session/end": "KinOAuthSessionRoute0",
      "POST /session/end": "KinOAuthSessionRoute1",
      "POST /session/end/confirm": "KinOAuthSessionRoute2",
      "GET /session/end/success": "KinOAuthSessionRoute3",
    };
    for (const route of [
      { path: "/.well-known/oauth-authorization-server", methods: [HttpMethod.GET] },
      { path: "/.well-known/openid-configuration", methods: [HttpMethod.GET] },
      { path: "/auth", methods: [HttpMethod.GET, HttpMethod.POST] },
      { path: "/auth/{proxy+}", methods: [HttpMethod.GET] },
      // The provider ends the old session before resuming a different account's
      // login. Keep its CSRF-bound confirmation on OAuth, not the default API.
      { path: "/session/end", methods: [HttpMethod.GET, HttpMethod.POST] },
      { path: "/session/end/confirm", methods: [HttpMethod.POST] },
      { path: "/session/end/success", methods: [HttpMethod.GET] },
      { path: "/token", methods: [HttpMethod.POST] },
      { path: "/jwks", methods: [HttpMethod.GET] },
      { path: "/token/revocation", methods: [HttpMethod.POST] },
      { path: "/interaction/{proxy+}", methods: [HttpMethod.ANY] },
    ]) {
      for (const added of httpApi.addRoutes({ ...route, integration: oauthIntegration })) {
        const resource = added.node.defaultChild as CfnRoute;
        const existingId = sessionRouteIds[resource.routeKey];
        if (existingId) resource.overrideLogicalId(existingId);
      }
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
    apiFunction.addEnvironment("KIN_BROWSER_REDIRECT_URI", `${httpApi.apiEndpoint}/invite.html`);
    apiFunction.addEnvironment("KIN_PUBLIC_SITE_ORIGIN", publicSiteOrigin.valueAsString);
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
    apiFunction.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [this.formatArn({ service: "ssm", resource: "parameter", resourceName: "kin/runtime/follow-up-processing", arnFormat: ArnFormat.SLASH_RESOURCE_NAME })],
    }));

    configureOperationsRouting(this);

    new CfnOutput(this, "CanonicalMcpUri", { value: canonicalMcpUri });
    new CfnOutput(this, "OAuthIssuer", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "OAuthJwksUri", { value: `${httpApi.apiEndpoint}/jwks` });
    new CfnOutput(this, "OAuthConfigurationSecretArn", { value: oauthSecret.secretArn });
    new CfnOutput(this, "OAuthStateTableName", { value: oauthStateTable.tableName });
    new CfnOutput(this, "FamilyUserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "FamilyUserPoolClientId", { value: userPoolClient.userPoolClientId });
  }
}
