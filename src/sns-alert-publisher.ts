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
        Message: record.responseState === "not_yet"
          ? "A Kin check-in still needs follow-up after a recorded Not yet response. Open Kin to see the shared family update."
          : record.responseState === "no_response"
            ? "No response was recorded for a Kin check-in. Open Kin to see the shared family update."
            : "A Kin check-in needs family follow-up. Open Kin to see the shared family update.",
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
