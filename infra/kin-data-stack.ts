import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
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
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Schedule,
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
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
      ],
      resources: [this.table.tableArn],
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

    new Alarm(this, "EscalationWorkerErrors", {
      alarmName: "kin-escalation-worker-errors",
      alarmDescription: "Kin's scheduled escalation worker returned an error.",
      metric: worker.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, "EscalationWorkerDeadLettersVisible", {
      alarmName: "kin-escalation-worker-dead-letters",
      alarmDescription: "Kin has an escalation worker invocation requiring investigation.",
      metric: workerDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
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
