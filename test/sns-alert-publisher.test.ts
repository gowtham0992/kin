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
      recipient: {
        memberId: "theo",
        memberName: "Theo",
        startsAt: "2026-09-02T08:00:00.000Z",
        endsAt: "2026-09-03T02:00:00.000Z",
      },
    });

    expect(result).toEqual({ messageId: "message-1" });
    expect(commands[0]?.input).toMatchObject({
      Message: "A scheduled Kin check-in was missed. Open Kin to see the shared family update.",
      MessageAttributes: {
        onDutyMemberId: { StringValue: "theo" },
      },
    });
    expect(commands[0]?.input.Message).not.toContain("Drink a glass of water");
  });
});
