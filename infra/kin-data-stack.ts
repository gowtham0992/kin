import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  CfnCondition,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Token,
  type StackProps,
} from "aws-cdk-lib";
import {
  Alarm,
  CfnAlarm,
  ComparisonOperator,
  TreatMissingData,
  Unit,
} from "aws-cdk-lib/aws-cloudwatch";
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Alias } from "aws-cdk-lib/aws-kms";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  ApplicationLogLevel,
  Architecture,
  LoggingFormat,
  Runtime,
  SystemLogLevel,
  Tracing,
} from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Schedule,
  CfnSchedule,
  ScheduleExpression,
  ScheduleTargetInput,
  TimeWindow,
} from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export class KinDataStack extends Stack {
  readonly table: Table;
  readonly alertTopic: Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const webPushEnabled = new CfnParameter(this, "WebPushEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Choose Web Push instead of SNS for the existing routed outbox. Does not enable the worker or schedule.",
    });
    const webPushPublicKey = new CfnParameter(this, "WebPushPublicKey", {
      type: "String", default: "", allowedPattern: "^$|^[A-Za-z0-9_-]{87}$",
      description: "Public application key matching the caregiver workspace and VAPID secret.",
    });
    const webPushSecret = new CfnParameter(this, "WebPushSecretArn", {
      type: "String", default: "", allowedPattern: "^$|^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$",
      description: "Existing VAPID JSON secret (subject, publicKey, privateKey). No secret contents in templates.",
    });
    const webPushConfigured = new CfnCondition(this, "WebPushConfigured", {
      expression: Fn.conditionAnd(Fn.conditionEquals(webPushEnabled.valueAsString, "true"),
        Fn.conditionNot(Fn.conditionEquals(webPushSecret.valueAsString, ""))),
    });

    const workerEnabled = new CfnParameter(this, "EscalationWorkerEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Allow this worker version to read care state and publish follow-ups. Keep false during a reviewed release pause; older worker packages do not honor this gate.",
    });
    const scheduleEnabled = new CfnParameter(this, "EscalationScheduleEnabled", {
      type: "String", default: "false", allowedValues: ["true", "false"],
      description: "Admit new five-minute sweeps only when the worker is also enabled. Disabling scheduling does not drain queued or in-flight invocations.",
    });
    const schedulingEnabled = new CfnCondition(this, "EscalationSchedulingEnabled", {
      expression: Fn.conditionAnd(
        Fn.conditionEquals(workerEnabled.valueAsString, "true"),
        Fn.conditionEquals(scheduleEnabled.valueAsString, "true"),
      ),
    });
    const operationsTopic = new CfnParameter(this, "OperationsAlarmTopicArn", {
      type: "String", default: "",
      allowedPattern: "^$|^arn:[a-z0-9-]+:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$",
      description: "Existing operator-owned SNS topic with a verified notification destination. Empty means alarms have no actions. Never use the family care-alert topic. Verify before enabling the worker.",
    });
    const operationsConfigured = new CfnCondition(this, "OperationsAlarmDestinationConfigured", {
      expression: Fn.conditionNot(Fn.conditionEquals(operationsTopic.valueAsString, "")),
    });

    this.table = new Table(this, "CareState", {
      tableName: "kin-care-state",
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

    this.alertTopic = new Topic(this, "CareAlerts", {
      topicName: "kin-care-alerts",
      displayName: "Kin care alerts",
      enforceSSL: true,
      masterKey: Alias.fromAliasName(this, "SnsManagedKey", "alias/aws/sns"),
    });

    const workerDeadLetterQueue = new Queue(this, "EscalationWorkerDeadLetters", {
      queueName: "kin-escalation-worker-dlq",
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const workerLogGroup = new LogGroup(this, "EscalationWorkerLogs", {
      logGroupName: "/aws/lambda/kin-escalation-worker",
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const worker = new NodejsFunction(this, "EscalationWorker", {
      functionName: "kin-escalation-worker",
      description: "Routes overdue Kin care tasks to the caregiver frozen in the outbox.",
      entry: path.resolve(moduleDirectory, "../src/escalation-worker.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      tracing: Tracing.ACTIVE,
      logGroup: workerLogGroup,
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      systemLogLevelV2: SystemLogLevel.WARN,
      environment: {
        KIN_ESCALATION_WORKER_ENABLED: workerEnabled.valueAsString,
        KIN_WEB_PUSH_ENABLED: webPushEnabled.valueAsString,
        KIN_WEB_PUSH_PUBLIC_KEY: webPushPublicKey.valueAsString,
        KIN_WEB_PUSH_SECRET_ARN: webPushSecret.valueAsString,
        KIN_DYNAMODB_TABLE: this.table.tableName,
        KIN_ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        KIN_CIRCLE_ID: "demo-family",
        KIN_TIME_ZONE: "America/Denver",
        KIN_GRACE_MINUTES: "30",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        target: "node22",
      },
    });
    worker.addToRolePolicy(new PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [Fn.conditionIf(webPushConfigured.logicalId, webPushSecret.valueAsString,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:kin-web-push-disabled`).toString()],
    }));
    worker.addToRolePolicy(new PolicyStatement({
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
      ],
      resources: [this.table.tableArn],
    }));
    worker.addToRolePolicy(new PolicyStatement({
      actions: ["dynamodb:ConditionCheckItem"],
      resources: [this.table.tableArn],
      conditions: { "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] } },
    }));
    this.alertTopic.grantPublish(worker);
    worker.configureAsyncInvoke({
      maxEventAge: Duration.minutes(15),
      retryAttempts: 1,
      onFailure: new SqsDestination(workerDeadLetterQueue),
    });

    const scheduleTarget = new LambdaInvoke(worker, {
      input: ScheduleTargetInput.fromObject({ source: "kin.scheduler" }),
      deadLetterQueue: workerDeadLetterQueue,
      maxEventAge: Duration.minutes(15),
      retryAttempts: 2,
    });
    const escalationSchedule = new Schedule(this, "EscalationSchedule", {
      scheduleName: "kin-escalation-sweep",
      description: "Checks for overdue Kin care tasks every five minutes.",
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: scheduleTarget,
      timeWindow: TimeWindow.off(),
    });
    // The L2 `enabled` flag is synthesis-time only; preserve a deploy-time pause
    // in the template instead of letting a code update re-enable scheduling.
    const scheduleResource = escalationSchedule.node.defaultChild as CfnSchedule;
    scheduleResource.state = Fn.conditionIf(schedulingEnabled.logicalId, "ENABLED", "DISABLED").toString();

    const alarms: Alarm[] = [];
    alarms.push(new Alarm(this, "EscalationWorkerErrors", {
      alarmName: "kin-escalation-worker-errors",
      alarmDescription: "Kin's scheduled escalation worker returned an error. Runbook: docs/delivery-operations.md#worker-error-or-dead-letter",
      metric: worker.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }));
    alarms.push(new Alarm(this, "EscalationWorkerDeadLettersVisible", {
      alarmName: "kin-escalation-worker-dead-letters",
      alarmDescription: "Kin has an escalation worker invocation requiring investigation. Runbook: docs/delivery-operations.md#worker-error-or-dead-letter",
      metric: workerDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }));

    for (const [field, name, symptom] of [
      ["failed", "Failed", "A follow-up publication failed"],
      ["blocked", "Blocked", "A follow-up has no routed caregiver"],
      ["receiptPending", "ReceiptPending", "Provider accepted a follow-up but its receipt needs reconciliation"],
      ["stuck", "Stuck", "A queued or sending follow-up has not progressed for 15 minutes"],
    ]) {
      const metric = new MetricFilter(this, `Delivery${name}Metric`, {
        logGroup: workerLogGroup,
        filterPattern: FilterPattern.stringValue("$.message.event", "=", "kin.escalation_delivery.health"),
        metricNamespace: "Kin/Delivery", metricName: name!, metricValue: `$.message.${field}`,
        defaultValue: 0, unit: Unit.COUNT,
      });
      alarms.push(new Alarm(this, `Delivery${name}Alarm`, {
        alarmName: `kin-delivery-${field}`,
        alarmDescription: `${symptom}. Runbook: docs/delivery-operations.md#delivery-symptoms`,
        metric: metric.metric({ statistic: "Maximum", period: Duration.minutes(5) }),
        threshold: 1, evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }));
    }
    for (const alarm of alarms) {
      const resource = alarm.node.defaultChild as CfnAlarm;
      // Do not create subscriptions or send operational events to family phones.
      resource.alarmActions = Token.asList(Fn.conditionIf(operationsConfigured.logicalId,
        [operationsTopic.valueAsString], { Ref: "AWS::NoValue" }));
    }
    new CfnOutput(this, "OperationsAlarmRouting", {
      value: Fn.conditionIf(operationsConfigured.logicalId, operationsTopic.valueAsString, "NOT_CONFIGURED").toString(),
      description: "Verify subscription receipt before worker enablement; a configured ARN alone is not delivery proof.",
    });

    new CfnOutput(this, "CareStateTableName", {
      value: this.table.tableName,
      description: "Set this value as KIN_DYNAMODB_TABLE.",
    });

    new CfnOutput(this, "CareAlertsTopicArn", {
      value: this.alertTopic.topicArn,
      description: "Set this value as KIN_ALERT_TOPIC_ARN.",
    });

    new CfnOutput(this, "EscalationWorkerName", {
      value: worker.functionName,
    });

    new CfnOutput(this, "EscalationScheduleName", {
      value: escalationSchedule.scheduleName,
    });

    new CfnOutput(this, "EscalationDeadLetterQueueUrl", {
      value: workerDeadLetterQueue.queueUrl,
    });
  }
}
