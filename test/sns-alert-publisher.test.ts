import { PublishCommand } from "@aws-sdk/client-sns";
import { describe, expect, it } from "vitest";
import { SnsAlertPublisher } from "../src/sns-alert-publisher.js";

describe("SnsAlertPublisher", () => {
  it("publishes a privacy-minimized alert with duty-roster filter metadata", async () => {
    const commands: PublishCommand[] = [];
    const publisher = new SnsAlertPublisher({
      topicArn: "arn:aws:sns:us-east-1:123456789012:kin-care-alerts",
      client: {
        async send(command) {
          commands.push(command);
          return { MessageId: "message-1" };
        },
      },
    });

    const result = await publisher.publish({
      id: "missed_morning-water_2026-09-02T15:00:00.000Z",
      taskId: "morning-water",
      taskTitle: "Drink a glass of water",
      dueAt: "2026-09-02T15:00:00.000Z",
      createdAt: "2026-09-02T16:00:00.000Z",
      updatedAt: "2026-09-02T16:00:00.000Z",
      recipientMemberId: "theo",
      recipientMemberName: "Theo",
      status: "sending",
      attemptCount: 1,
      attemptId: "worker-1",
      leaseUntil: "2026-09-02T16:01:00.000Z",
      providerMessageId: null,
      lastErrorCode: null,
    });

    expect(result).toEqual({ messageId: "message-1" });
    expect(commands[0]?.input).toMatchObject({
      Message: "A Kin check-in needs family follow-up. Open Kin to see the shared family update.",
      MessageAttributes: {
        onDutyMemberId: { StringValue: "theo" },
      },
    });
    expect(commands[0]?.input.Message).not.toContain("Drink a glass of water");
    expect(commands[0]?.input.Message).not.toContain("missed");
  });
});
