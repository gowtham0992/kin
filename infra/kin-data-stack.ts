import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Alias } from "aws-cdk-lib/aws-kms";
import { Topic } from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

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

    new CfnOutput(this, "CareStateTableName", {
      value: this.table.tableName,
      description: "Set this value as KIN_DYNAMODB_TABLE.",
    });

    new CfnOutput(this, "CareAlertsTopicArn", {
      value: this.alertTopic.topicArn,
      description: "Set this value as KIN_ALERT_TOPIC_ARN.",
    });
  }
}
