import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnCondition, CfnOutput, CfnParameter, CfnRule, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { CfnPolicy, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { ApplicationLogLevel, Architecture, LoggingFormat, Runtime, SystemLogLevel } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Isolated classic ASK adapter; family access is separately gated and uses linked-account MCP authorization. */
export class KinEchoStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const skillId = new CfnParameter(this, "EchoSkillId", {
      type: "String",
      allowedPattern: "^amzn1\\.ask\\.skill\\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
      description: "Exact development custom Skill ID copied from the Alexa Developer Console. Required; no shared default.",
    });
    const enabled = new CfnParameter(this, "EchoEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Enable the Echo development skill after disabled-state verification. Set false to pause all voice use.",
    });
    const careEnabled = new CfnParameter(this, "EchoCareEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Enable linked-account family plan access and reviewed confirmations only after account-linking verification. False keeps the connection test.",
    });
    const reminderTestEnabled = new CfnParameter(this, "EchoReminderTestEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable parent-approved one-time reminders only after permission and durable-claim verification.",
    });
    const reminderSyncEnabled = new CfnParameter(this, "EchoReminderSyncEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable the silent cancellation receiver after the separate table and boundary are provisioned. Keep enabled while already queued jobs drain.",
    });
    const undoEnabled = new CfnParameter(this, "EchoUndoEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable reviewed recent-completion undo only after the compatible authenticated MCP backend and interaction model are deployed.",
    });
    const planPauseEnabled = new CfnParameter(this, "EchoPlanPauseEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable explicit one-week pause reviews only after the compatible authenticated backend and interaction model are verified.",
    });
    const planCancelSyncEnabled = new CfnParameter(this, "EchoPlanCancelSyncEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Offer explicitly consented plan cancellation sync only after API tickets and the receiver are verified.",
    });
    const receiverEnabled = new CfnCondition(this, "EchoSyncReceiverEnabled", {
      expression: Fn.conditionEquals(reminderSyncEnabled.valueAsString, "true"),
    });
    new CfnRule(this, "EchoSyncOffersRequireReceiver", {
      ruleCondition: Fn.conditionEquals(planCancelSyncEnabled.valueAsString, "true"),
      assertions: [{ assert: Fn.conditionAnd(
        Fn.conditionEquals(reminderSyncEnabled.valueAsString, "true"),
        Fn.conditionEquals(careEnabled.valueAsString, "true"),
        Fn.conditionEquals(reminderTestEnabled.valueAsString, "true")),
      assertDescription: "Synchronized offers require the receiver, linked care, and consented reminders." }],
    });
    const reminderClaims = new Table(this, "ReminderClaims", {
      tableName: "kin-echo-reminder-claims",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.DEFAULT,
      timeToLiveAttribute: "expiresAt",
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const mcpEndpoint = new CfnParameter(this, "EchoMcpEndpoint", {
      type: "String",
      default: "",
      maxLength: 2048,
      // DNS HTTPS endpoint only: no user info, explicit port, query, fragment, or noncanonical path.
      // The final negative lookahead also rejects a trailing newline (unlike a bare $ anchor).
      allowedPattern: "^(?:https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/mcp)?(?![\\s\\S])",
      constraintDescription: "Leave empty while care is disabled, or use an exact lowercase HTTPS DNS URL ending in /mcp without a port, query, or fragment.",
      description: "Exact Kin MCP endpoint. Linked access tokens are forwarded only to this configured endpoint; no endpoint is assumed.",
    });
    new CfnRule(this, "EchoCareEndpointRequired", {
      ruleCondition: Fn.conditionEquals(careEnabled.valueAsString, "true"),
      assertions: [{
        assert: Fn.conditionNot(Fn.conditionEquals(mcpEndpoint.valueAsString, "")),
        assertDescription: "Echo care requires an explicitly configured HTTPS MCP endpoint.",
      }],
    });
    const logGroup = new LogGroup(this, "EchoLogs", {
      logGroupName: "/aws/lambda/kin-echo-development",
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const role = new Role(this, "EchoExecutionRole", {
      roleName: "kin-echo-development-role",
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Kin Echo adapter: own logs, isolated reminder claims, and separately gated cancellation jobs. No direct family data.",
      // Bootstrap owns this boundary; the Echo stack cannot broaden its maximum permissions.
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, "EchoRuntimeBoundary", this.formatArn({
        service: "iam",
        region: "",
        resource: "policy",
        resourceName: "KinEchoRuntimeBoundary",
      })),
    });
    role.addToPolicy(new PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [logGroup.logGroupArn],
    }));
    // No reads, updates, deletes, scans, or access to the family-state table.
    // The externally managed permissions boundary must separately allow this.
    role.addToPolicy(new PolicyStatement({
      actions: ["dynamodb:PutItem"], resources: [reminderClaims.tableArn],
    }));
    // Separate conditional policy: a normal code rollout or disabled receiver
    // does not silently acquire access to the new table. Bootstrap must also
    // approve these exact actions/keys in KinEchoRuntimeBoundary.
    const cancellationPolicy = new CfnPolicy(this, "CancellationJobPolicy", {
      policyName: "KinEchoCancellationJobs", roles: [role.roleName],
      policyDocument: { Version: "2012-10-17", Statement: [new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [this.formatArn({ service: "dynamodb", resource: "table", resourceName: "kin-echo-reminder-sync" })],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CANCEL#*"] } },
      }).toStatementJson()] },
    });
    cancellationPolicy.cfnOptions.condition = receiverEnabled;
    const handler = new NodejsFunction(this, "EchoFunction", {
      functionName: "kin-echo-development",
      description: "Classic Alexa skill with linked-account MCP access and separately gated reminders. No direct family-data, identity, model, or SMS permissions.",
      entry: path.resolve(moduleDirectory, "../src/echo-lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // Voice requests have a short end-to-end budget; the 128 MB allocation
      // left substantial SDK/authentication overhead in measured live probes.
      memorySize: 512,
      timeout: Duration.seconds(7),
      role,
      logGroup,
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      systemLogLevelV2: SystemLogLevel.INFO,
      environment: {
        KIN_ECHO_SKILL_ID: skillId.valueAsString,
        KIN_ECHO_ENABLED: enabled.valueAsString,
        KIN_ECHO_CARE_ENABLED: careEnabled.valueAsString,
        KIN_ECHO_MCP_ENDPOINT: mcpEndpoint.valueAsString,
        // The current deployment serves one circle configured in Denver time.
        KIN_ECHO_TIME_ZONE: "America/Denver",
        KIN_ECHO_REMINDER_TEST_ENABLED: reminderTestEnabled.valueAsString,
        KIN_ECHO_REMINDER_CLAIMS_TABLE: reminderClaims.tableName,
        KIN_ECHO_REMINDER_SYNC_ENABLED: reminderSyncEnabled.valueAsString,
        KIN_ECHO_PLAN_CANCEL_SYNC_ENABLED: planCancelSyncEnabled.valueAsString,
        KIN_ECHO_REMINDER_SYNC_TABLE: "kin-echo-reminder-sync",
        KIN_ECHO_UNDO_ENABLED: undoEnabled.valueAsString,
        KIN_ECHO_PLAN_PAUSE_ENABLED: planPauseEnabled.valueAsString,
      },
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        target: "node22",
        format: OutputFormat.CJS,
      },
    });
    // ASK uses EventSourceToken for its Skill ID, not the AWS SourceArn condition.
    handler.addPermission("AlexaSkillInvoke", {
      action: "lambda:InvokeFunction",
      principal: new ServicePrincipal("alexa-appkit.amazon.com"),
      eventSourceToken: skillId.valueAsString,
    });

    new CfnOutput(this, "EchoFunctionArn", { value: handler.functionArn });
    new CfnOutput(this, "EchoSkillIdOutput", { value: skillId.valueAsString });
  }
}
