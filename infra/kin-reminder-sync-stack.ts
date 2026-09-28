import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArnFormat, CfnCondition, CfnOutput, CfnParameter, CfnRule, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnRule as EventRule, Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import type { Construct } from "constructs";
import { configureOperationsRouting } from "./operations-routing.js";

/** Separate, paused deployment candidate. Not included in either existing deployment app.
 * Activation requires a reviewed boundary, real messaging secret, and Echo/API grants.
 */
export class KinReminderSyncStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { careTableName: string; circleId: string }) {
    super(scope, id, props);
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(props.careTableName) || !/^[A-Za-z0-9_-]{1,100}$/.test(props.circleId)) throw new Error("Explicit care table and circle required.");
    const workerEnabled = new CfnParameter(this, "ReminderSyncWorkerEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Enable only after receiver, tickets, runtime grants and a bounded acceptance plan are ready.",
    });
    const scheduleEnabled = new CfnParameter(this, "ReminderSyncScheduleEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Start the one-minute cancellation sweep only after controlled acceptance; independent pause gate.",
    });
    const scheduleActive = new CfnCondition(this, "ReminderScheduleActive", {
      expression: Fn.conditionEquals(scheduleEnabled.valueAsString, "true"),
    });
    new CfnRule(this, "ScheduleRequiresWorker", {
      ruleCondition: Fn.conditionEquals(scheduleEnabled.valueAsString, "true"),
      assertions: [{ assert: Fn.conditionEquals(workerEnabled.valueAsString, "true"),
        assertDescription: "Enable the worker before enabling its schedule." }],
    });
    const queue = new Table(this, "ReminderSync", { tableName: "kin-echo-reminder-sync",
      partitionKey: { name: "PK", type: AttributeType.STRING }, billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.DEFAULT, deletionProtection: true, removalPolicy: RemovalPolicy.RETAIN,
      // Separate from job.expiresAt (milliseconds). Dispatch leases use epoch seconds.
      timeToLiveAttribute: "ttl" });
    const logs = new LogGroup(this, "WorkerLogs", { logGroupName: "/aws/lambda/kin-reminder-sync-worker", retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN });
    const role = new Role(this, "WorkerRole", { roleName: "kin-reminder-sync-worker-role", assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(this, "RuntimeBoundary", this.formatArn({ service: "iam", region: "", resource: "policy", resourceName: "KinReminderSyncRuntimeBoundary" })) });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logs.logGroupArn] }));
    const tableArn = (name: string) => this.formatArn({ service: "dynamodb", resource: "table", resourceName: name });
    role.addToPolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:ConditionCheckItem"], resources: [tableArn(props.careTableName)],
      conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [`CIRCLE#${props.circleId}`] } } }));
    role.addToPolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem"], resources: [tableArn("kin-echo-reminder-claims")] }));
    role.addToPolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"], resources: [queue.tableArn] }));
    role.addToPolicy(new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "kin/alexa-skill-messaging-??????", arnFormat: ArnFormat.COLON_RESOURCE_NAME })] }));
    const worker = new NodejsFunction(this, "Worker", { functionName: "kin-reminder-sync-worker", role, logGroup: logs,
      entry: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/reminder-sync-worker.ts"), handler: "handler",
      runtime: Runtime.NODEJS_22_X, architecture: Architecture.ARM_64, memorySize: 256, timeout: Duration.seconds(60), reservedConcurrentExecutions: 1,
      environment: { KIN_REMINDER_SYNC_WORKER_ENABLED: workerEnabled.valueAsString, KIN_DYNAMODB_TABLE: props.careTableName, KIN_CIRCLE_ID: props.circleId,
        KIN_ECHO_REMINDER_CLAIMS_TABLE: "kin-echo-reminder-claims", KIN_ECHO_REMINDER_SYNC_TABLE: queue.tableName,
        KIN_SKILL_MESSAGING_SECRET_ID: "kin/alexa-skill-messaging" }, bundling: { bundleAwsSDK: true, minify: true, target: "node22" } });
    const schedule = new Rule(this, "Schedule", { ruleName: "kin-reminder-sync-sweep", schedule: Schedule.rate(Duration.minutes(1)), enabled: false, targets: [new LambdaFunction(worker, { retryAttempts: 0 })] });
    (schedule.node.defaultChild as EventRule).state = Fn.conditionIf(scheduleActive.logicalId, "ENABLED", "DISABLED").toString();
    configureOperationsRouting(this);
    new CfnOutput(this, "QueueTable", { value: queue.tableName });
    new CfnOutput(this, "WorkerFunctionName", { value: worker.functionName });
    new CfnOutput(this, "ScheduleName", { value: schedule.ruleName });
  }
}
