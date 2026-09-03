import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { EscalationRecord } from "./escalation.js";

interface SnsSender {
  send(command: PublishCommand): Promise<{ MessageId?: string }>;
}

export class SnsAlertPublisher {
  readonly #client: SnsSender;
  readonly #topicArn: string;

  constructor(input: { client: SnsSender; topicArn: string }) {
    this.#client = input.client;
    this.#topicArn = input.topicArn;
  }

  async publish(record: EscalationRecord): Promise<{ messageId: string }> {
    if (!record.recipientMemberId) {
      throw new Error("Escalation has no routed recipient");
    }
    const result = await this.#client.send(
      new PublishCommand({
        TopicArn: this.#topicArn,
        Subject: "Kin care check-in needs attention",
        Message: "A scheduled Kin check-in was missed. Open Kin to see the shared family update.",
        MessageAttributes: {
          onDutyMemberId: { DataType: "String", StringValue: record.recipientMemberId },
          escalationId: { DataType: "String", StringValue: record.id },
        },
      }),
    );
    if (!result.MessageId) throw new Error("SNS did not return a message identifier");
    return { messageId: result.MessageId };
  }
}

export function createSnsAlertPublisher(input: {
  topicArn: string;
  region?: string;
}): SnsAlertPublisher {
  return new SnsAlertPublisher({
    client: new SNSClient({ region: input.region ?? "us-east-1" }),
    topicArn: input.topicArn,
  });
}
