import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceeded, ConversationBudgetUnavailable, createDynamoConversationBudget } from "../src/conversation-budget.js";

const identity = { circleId: "family-private", memberId: "caregiver-private" };
const fixedNow = () => new Date("2026-09-06T15:00:00.000Z");
afterEach(() => vi.restoreAllMocks());

// A shared conditional-storage boundary, not process-local quota state. Command-shape
// assertions below pin the real Dynamo conditions this boundary evaluates.
class ConditionalTable {
  readonly rows = new Map<string, { attempts?: number; nextAllowedAt?: number }>();
  async send(command: TransactWriteCommand) {
    const updates = command.input.TransactItems!.map(item => item.Update!);
    const reasons = updates.map(update => {
      const row = this.rows.get(JSON.stringify(update.Key)), values = update.ExpressionAttributeValues!;
      const denied = row && (values[":limit"] !== undefined ? row.attempts! >= values[":limit"] : row.nextAllowedAt! > values[":now"]);
      return { Code: denied ? "ConditionalCheckFailed" : "None" };
    });
    if (reasons.some(reason => reason.Code === "ConditionalCheckFailed")) {
      throw Object.assign(new Error("Limit"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    }
    for (const update of updates) {
      const key = JSON.stringify(update.Key), row = this.rows.get(key), values = update.ExpressionAttributeValues!;
      this.rows.set(key, values[":limit"] !== undefined
        ? { attempts: (row?.attempts ?? values[":zero"]) + values[":one"] }
        : { nextAllowedAt: values[":next"] });
    }
    return {};
  }
}

describe("shared conversation usage reservations", () => {
  it("uses one atomic count/cooldown transaction with hashed identity, bounded retention, and a deadline", async () => {
    const send = vi.fn(async () => ({}));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await createDynamoConversationBudget({ tableName: "care-test", now: fixedNow, client: { send } }).reserve(identity);
    expect(send).toHaveBeenCalledOnce();
    const [command, options] = send.mock.calls[0]! as unknown as [TransactWriteCommand, { abortSignal: AbortSignal }];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(2);
    const [daily, cooldown] = command.input.TransactItems!.map(item => item.Update!);
    expect(daily!.Key).toEqual({ PK: expect.stringMatching(/^CONVERSATION_BUDGET#[a-f0-9]{64}$/), SK: "DAY#2026-09-06" });
    expect(cooldown!.Key).toEqual({ PK: daily!.Key!.PK, SK: "COOLDOWN" });
    expect(JSON.stringify(command.input)).not.toContain(identity.circleId);
    expect(JSON.stringify(command.input)).not.toContain(identity.memberId);
    expect(daily!.UpdateExpression).toBe("SET #attempts = if_not_exists(#attempts, :zero) + :one, expiresAt = :expiry, entityType = :type");
    expect(daily!.ConditionExpression).toBe("attribute_not_exists(#attempts) OR #attempts < :limit");
    expect(daily!.ExpressionAttributeNames).toEqual({ "#attempts": "attempts" });
    expect(daily!.ExpressionAttributeValues).toEqual({
      ":zero": 0, ":one": 1, ":limit": 20,
      ":expiry": Date.parse("2026-09-14T00:00:00Z") / 1000, ":type": "ConversationBudget",
    });
    expect(cooldown!.UpdateExpression).toBe("SET nextAllowedAt = :next, expiresAt = :expiry, entityType = :type");
    expect(cooldown!.ConditionExpression).toBe("attribute_not_exists(nextAllowedAt) OR nextAllowedAt <= :now");
    expect(cooldown!.ExpressionAttributeValues).toEqual({ ":now": fixedNow().getTime(), ":next": fixedNow().getTime() + 10000,
      ":expiry": Date.parse("2026-09-13T15:00:10Z") / 1000, ":type": "ConversationCooldown" });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(1000);
  });

  it("shares the cooldown and daily cap across independent runtime instances", async () => {
    const client = new ConditionalTable(); let current = fixedNow().getTime();
    const instances = Array.from({ length: 30 }, () => createDynamoConversationBudget({ tableName: "care-test", client, now: () => new Date(current) }));
    const concurrent = await Promise.allSettled(instances.map(budget => budget.reserve(identity)));
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(result => result.status === "rejected").every(result => result.reason instanceof BudgetExceeded)).toBe(true);
    for (let index = 1; index < 20; index++) { current += 10000; await instances[index]!.reserve(identity); }
    current += 10000;
    await expect(instances[20]!.reserve(identity)).rejects.toMatchObject({ name: "BudgetExceeded", retryAfterSeconds: 60 });
    expect([...client.rows.values()]).toEqual([{ attempts: 20 }, { nextAllowedAt: current }]);
  });

  it("isolates member and circle identities and rolls UTC days without waiting for TTL deletion", async () => {
    const client = new ConditionalTable(); let current = Date.parse("2026-09-06T23:59:59Z");
    const budget = createDynamoConversationBudget({ tableName: "care-test", client, now: () => new Date(current) });
    await budget.reserve(identity);
    await budget.reserve({ ...identity, memberId: "another-caregiver" });
    await budget.reserve({ ...identity, circleId: "another-family" });
    expect(client.rows.size).toBe(6);
    current += 1000;
    await expect(budget.reserve(identity)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(client.rows.size).toBe(6); // Denied cooldown cannot consume the new day's quota.
    current += 9000;
    await budget.reserve(identity);
    expect(client.rows.size).toBe(7);
    expect([...client.rows.values()].filter(row => row.attempts !== undefined).every(row => row.attempts === 1)).toBe(true);
  });

  it("fails closed without retry or sensitive provider details after an uncertain reservation", async () => {
    const send = vi.fn(async () => { throw new Error("private provider request payload"); });
    const budget = createDynamoConversationBudget({ tableName: "care-test", now: fixedNow, client: { send } });
    const error = await budget.reserve(identity).catch(error => error);
    expect(error).toBeInstanceOf(ConversationBudgetUnavailable);
    expect(String(error)).not.toContain("private provider");
    expect(error.cause).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects malformed identities before touching shared storage", async () => {
    const send = vi.fn(async () => ({}));
    const budget = createDynamoConversationBudget({ tableName: "care-test", now: fixedNow, client: { send } });
    await expect(budget.reserve({ circleId: "", memberId: "forged#member" })).rejects.toBeInstanceOf(ConversationBudgetUnavailable);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, [{ Code: "TransactionConflict" }], [{ Code: "ProvisionedThroughputExceeded" }]])("does not mislabel uncertain transaction cancellation as a usage limit", async reasons => {
    const send = vi.fn(async () => { throw Object.assign(new Error("private cancellation detail"), { name: "TransactionCanceledException", CancellationReasons: reasons }); });
    const budget = createDynamoConversationBudget({ tableName: "care-test", now: fixedNow, client: { send } });
    await expect(budget.reserve(identity)).rejects.toBeInstanceOf(ConversationBudgetUnavailable);
    expect(send).toHaveBeenCalledOnce();
  });
});
