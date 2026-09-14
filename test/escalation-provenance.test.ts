import { describe, expect, it } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { planMissedTaskEscalations, runEscalationSweep, toEscalationSummary } from "../src/escalation.js";
import { SnsAlertPublisher } from "../src/sns-alert-publisher.js";
import { createEscalationWorker } from "../src/escalation-worker.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { EscalationRecord } from "../src/escalation.js";

describe("frozen follow-up provenance", () => {
  it("records acceptance after the provider responds, not at the start of the sweep", async () => {
    let now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    const worker = createEscalationWorker({ repository: store, graceMinutes: 30, now: () => now,
      log: () => undefined, publisher: { publish: async () => {
        now = new Date("2026-09-02T16:00:09.000Z");
        return { messageId: "delayed-provider-acceptance" };
      } } });
    const result = await worker({ source: "kin.scheduler" }, "acceptance-clock-test");
    expect(result.evaluatedAt).toBe("2026-09-02T16:00:00.000Z");
    expect((await store.today()).escalations[0]?.sentAt).toBe("2026-09-02T16:00:09.000Z");
  });

  it.each(["sent", "failed"] as const)("Dynamo records acceptance only for a %s completion with the active attempt", async status => {
    const record: EscalationRecord = { id: "test-follow-up", taskId: "water", taskTitle: "Water",
      dueAt: "2026-09-02T15:00:00Z", createdAt: "2026-09-02T16:00:00Z", updatedAt: "2026-09-02T16:00:00Z",
      status: "sending", recipientMemberId: "theo", recipientMemberName: "Theo", attemptCount: 1,
      attemptId: "active-attempt", leaseUntil: "2026-09-02T16:01:00Z", providerMessageId: null, lastErrorCode: null };
    const commands: UpdateCommand[] = [];
    const completedAt = new Date("2026-09-02T16:00:09.000Z");
    const repository = new DynamoCareRepository({ tableName: "kin-test", circleId: "family-1", client: {
      send: async command => {
        expect(command).toBeInstanceOf(UpdateCommand);
        commands.push(command as UpdateCommand);
        return { Attributes: { ...record, status, ...(status === "sent" ? { sentAt: completedAt.toISOString() } : {}) } };
      },
    } });
    const saved = status === "sent"
      ? await repository.completeEscalation({ record, attemptId: "active-attempt", providerMessageId: "accepted", completedAt })
      : await repository.failEscalation({ record, attemptId: "active-attempt", errorCode: "provider-unavailable", failedAt: completedAt });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.input).toMatchObject({ ConditionExpression: "#status = :sending AND attemptId = :attemptId",
      ExpressionAttributeValues: { ":attemptId": "active-attempt", ":updatedAt": completedAt.toISOString() } });
    expect(commands[0]!.input.UpdateExpression?.includes("sentAt = :updatedAt")).toBe(status === "sent");
    if (status === "sent") expect(saved.sentAt).toBe(completedAt.toISOString());
    else expect(saved).not.toHaveProperty("sentAt");
  });

  it("keeps provider acceptance time and recipient stable after acknowledgment", async () => {
    let now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    const { records } = await runEscalationSweep({ snapshot: await store.today(), store,
      publisher: { publish: async () => ({ messageId: "test-accepted" }) }, now, attemptId: "test-attempt" });
    expect(records[0]).toMatchObject({ sentAt: now.toISOString(), recipientMemberId: "theo" });
    now = new Date("2026-09-02T16:10:00.000Z");
    const summary = await store.acknowledgeEscalation({ id: records[0]!.id, memberId: "maya", name: "Maya" });
    expect(summary).toMatchObject({ sentAt: "2026-09-02T16:00:00.000Z", recipientMemberId: "theo",
      acknowledgedAt: now.toISOString(), acknowledgedBy: "Maya" });
  });

  it.each(["not_yet", "no_response"] as const)("freezes %s context into the routed outbox and SMS copy", async reason => {
    let now = new Date("2026-09-02T16:00:00.000Z");
    const store = createDemoStore(() => now);
    if (reason === "not_yet") await store.confirm({ taskId: "morning-water", response: "not_yet", actor: "Evelyn", requestId: "recorded-not-yet" });
    now = new Date("2026-09-02T16:30:00.000Z");
    const event = planMissedTaskEscalations({ snapshot: await store.today(), now }).events[0]!;
    const { record } = (await store.queueEscalation(event))!;
    expect(record).toMatchObject({ responseState: reason,
      ...(reason === "not_yet" ? { responseRecordedAt: "2026-09-02T16:00:00.000Z" } : {}) });
    let message = "";
    await new SnsAlertPublisher({ topicArn: "arn:aws:sns:us-east-1:123456789012:test",
      client: { send: async command => { message = command.input.Message!; return { MessageId: "test" }; } } }).publish(record);
    expect(message).toContain(reason === "not_yet" ? "recorded Not yet" : "No response was recorded");
    expect(message).not.toContain(record.taskTitle);
    expect(message).not.toContain("missed");
    const replay = await store.queueEscalation({ ...event, responseState: reason === "not_yet" ? "no_response" : "not_yet" });
    expect(replay!.record.responseState).toBe(reason);
  });

  it("never infers provider acceptance time for a legacy record", () => {
    const summary = toEscalationSummary({ id: "legacy", taskId: "water", taskTitle: "Water", dueAt: "2026-09-02T15:00:00Z",
      createdAt: "2026-09-02T16:00:00Z", updatedAt: "2026-09-02T18:00:00Z", status: "sent", recipientMemberId: "theo",
      recipientMemberName: "Theo", attemptCount: 1, attemptId: null, leaseUntil: null, providerMessageId: "legacy-id", lastErrorCode: null });
    expect(summary).not.toHaveProperty("sentAt");
  });
});
