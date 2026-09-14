import { BatchGetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it, vi } from "vitest";
import { buildDemoSeed } from "../src/demo-seed.js";
import { writeDemoSeed } from "../src/demo-seed-writer.js";

const PK = "CIRCLE#seed-test", table = "synthetic-seed-table";
const items = buildDemoSeed({ circleId: "seed-test", now: new Date("2026-09-14T00:00:00.000Z") });
const conditional = () => Object.assign(new Error("Synthetic conflict"), { name: "TransactionCanceledException" });
function fixture(existing: Array<Record<string, any>> = [], race = false, incomplete = false) {
  const rows = new Map(existing.map(row => [row.SK, structuredClone(row)]));
  const send = vi.fn(async (command: any) => {
    if (command instanceof BatchGetCommand) {
      expect(command.input.RequestItems?.[table]?.ConsistentRead).toBe(true);
      const result = { Responses: { [table]: [...rows.values()].map(row => structuredClone(row)) },
        ...(incomplete ? { UnprocessedKeys: { [table]: { Keys: [{ PK, SK: "MEMBER#maya" }] } } } : {}) };
      if (race) rows.set("PLAN_CONTROL", { PK, SK: "PLAN_CONTROL", entityType: "PlanControl", version: 1 });
      return result;
    }
    if (command instanceof PutCommand) {
      if (rows.has(command.input.Item!.SK)) throw Object.assign(new Error("Synthetic existing row"), { name: "ConditionalCheckFailedException" });
      rows.set(command.input.Item!.SK, structuredClone(command.input.Item!)); return {};
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("Unexpected command");
    const writes = command.input.TransactItems!.map(item => item.Put!);
    for (const write of writes) {
      expect(write.ConditionExpression).toBe("attribute_not_exists(PK) AND attribute_not_exists(SK)");
      if (rows.has(write.Item!.SK)) throw conditional();
    }
    for (const write of writes) rows.set(write.Item!.SK, structuredClone(write.Item!));
    return {};
  });
  return { send, rows };
}

it("refuses initialization once a plan control exists, including an active pause", async () => {
  const client = fixture([{ PK, SK: "PLAN_CONTROL", entityType: "PlanControl", version: 1,
    pause: { startsAt: "2026-09-13T00:00:00.000Z", endsAt: "2026-09-20T00:00:00.000Z" } }]);
  await expect(writeDemoSeed(client, table, "seed-test", items)).rejects.toThrow();
  expect(client.rows.size).toBe(1);
});
it("commits all missing seed rows and advances the control together, preserving existing rows", async () => {
  const unchanged = { ...items[0]!, name: "An existing name" }, client = fixture([unchanged]);
  await expect(writeDemoSeed(client, table, "seed-test", items)).resolves.toEqual({ seeded: 11, preserved: 1 });
  expect(client.rows.get(unchanged.SK)).toEqual(unchanged);
  expect(client.rows.get("PLAN_CONTROL")).toEqual({ PK, SK: "PLAN_CONTROL", entityType: "PlanControl", version: 1 });
  expect(client.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
  expect(client.send.mock.calls.some(([command]) => command instanceof PutCommand)).toBe(false);
});
it("makes no partial seed when a task writer or pause creates the control after the read", async () => {
  const client = fixture([], true);
  await expect(writeDemoSeed(client, table, "seed-test", items)).rejects.toThrow();
  expect(client.rows.size).toBe(1);
  expect(client.rows.has(items[3]!.SK)).toBe(false);
});
it("fails closed on an incomplete seed read", async () => {
  const client = fixture([], false, true);
  await expect(writeDemoSeed(client, table, "seed-test", items)).rejects.toThrow();
  expect(client.rows.size).toBe(0);
});
it("rejects foreign keys and duplicate rows without making requests", async () => {
  const client = fixture();
  await expect(writeDemoSeed(client, table, "seed-test", [{ ...items[0]!, PK: "CIRCLE#another" }])).rejects.toThrow();
  await expect(writeDemoSeed(client, table, "seed-test", [items[0]!, items[0]!])).rejects.toThrow();
  expect(client.send).not.toHaveBeenCalled();
});
