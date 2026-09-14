import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { calendarDayBounds, shiftCalendarDate } from "../src/calendar.js";
import { DutyRotationConflict, type DutyRotationInput, type DutyRotationProposal } from "../src/duty-rotation.js";

const PK = "CIRCLE#rotation-family", now = new Date("2026-09-08T15:00:00.000Z");
type Row = Record<string, unknown> & { PK: string; SK: string };
const member = (id: string, enabled = true): Row => ({ PK, SK: `MEMBER#${id}`, entityType: "CircleMember", id, name: id,
  relationship: id === "parent" ? "parent" : "caregiver", canReceiveAlerts: enabled });
const duty = (date: string, id = "maya"): Row => ({ PK, SK: `DUTY#${date}`, entityType: "DutyAssignment", memberId: id, memberName: id, ...calendarDayBounds(date, "UTC") });
const meta = (version = 1): Row => ({ PK, SK: "ROSTER#META", entityType: "RosterMetadata", circleId: "rotation-family", version });
const input = (proposal: DutyRotationProposal, requestId = "rotation-request-01"): DutyRotationInput => ({
  startDate: proposal.startDate, reviewToken: proposal.reviewToken, requestId, actor: "maya", confirm: true,
});

// A stateful, bounded Dynamo condition emulator, not a mock returning success:
// every condition is evaluated against the complete pre-commit table, all keys
// must be distinct, and writes apply only after every condition has passed.
class ConditionalTable {
  readonly rows = new Map<string, Row>();
  transactions = 0;
  lastTransaction: TransactWriteCommand | undefined;
  beforeTransaction?: () => void;
  afterCommit?: () => void;
  partialMemberPage = false;
  partialDutyPage = false;
  clock = now;
  constructor(rows: Row[] = [member("maya"), member("theo"), member("parent", false)]) { rows.forEach(row => this.put(row)); }
  put(row: Row) { this.rows.set(`${row.PK}|${row.SK}`, structuredClone(row)); }
  get(SK: string) { return this.rows.get(`${PK}|${SK}`); }
  projection(row: Row | undefined, expression?: string, names: Record<string, string> = {}) {
    if (!row || !expression) return structuredClone(row);
    return Object.fromEntries(expression.split(",").map(value => names[value.trim()] ?? value.trim())
      .filter(field => row[field] !== undefined).map(field => [field, structuredClone(row[field])]));
  }
  send = async (command: unknown): Promise<unknown> => {
    if (command instanceof GetCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      const key = command.input.Key!;
      return { Item: this.projection(this.rows.get(`${key.PK}|${key.SK}`), command.input.ProjectionExpression, command.input.ExpressionAttributeNames) };
    }
    if (command instanceof QueryCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      const values = command.input.ExpressionAttributeValues!;
      const all = [...this.rows.values()].filter(row => row.PK === values[":pk"] && (values[":member"]
        ? row.SK.startsWith(values[":member"]) : row.SK >= values[":start"] && row.SK <= values[":end"]))
        .sort((a, b) => a.SK.localeCompare(b.SK));
      const partial = (values[":member"] ? this.partialMemberPage : this.partialDutyPage) || all.length > command.input.Limit!;
      return { Items: all.slice(0, command.input.Limit).map(row => this.projection(row, command.input.ProjectionExpression, command.input.ExpressionAttributeNames)),
        ...(partial ? { LastEvaluatedKey: { PK, SK: "synthetic-more" } } : {}) };
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("Unexpected table command");
    this.transactions += 1; this.lastTransaction = command;
    const hook = this.beforeTransaction; this.beforeTransaction = undefined; hook?.();
    const writes = command.input.TransactItems!;
    expect(writes.length).toBeLessThanOrEqual(100);
    const keys = writes.map(value => { const action = value.Put ?? value.ConditionCheck!; const key = "Item" in action ? action.Item! : action.Key!; return `${key.PK}|${key.SK}`; });
    expect(new Set(keys).size).toBe(keys.length);
    const reasons = writes.map((value, index) => {
      const action = value.Put ?? value.ConditionCheck!, row = this.rows.get(keys[index]!);
      const names = action.ExpressionAttributeNames ?? {}, values = action.ExpressionAttributeValues ?? {};
      const ok = action.ConditionExpression!.split(" AND ").every(expression => {
        const absent = /^attribute_not_exists\(([^)]+)\)$/.exec(expression);
        if (absent) return row?.[names[absent[1]!] ?? absent[1]!] === undefined;
        const equals = /^(#[A-Za-z0-9]+) = (:[A-Za-z0-9]+)$/.exec(expression);
        if (!equals) throw new Error(`Unsupported condition: ${expression}`);
        return row?.[names[equals[1]!]!] === values[equals[2]!];
      });
      return { Code: ok ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some(reason => reason.Code !== "None")) throw Object.assign(new Error("Atomic transaction rejected"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    for (const value of writes) if (value.Put) this.put(value.Put.Item as Row);
    const afterCommit = this.afterCommit; this.afterCommit = undefined; afterCommit?.();
    return {};
  };
  repository() { return new DynamoCareRepository({ client: this, tableName: "synthetic", circleId: "rotation-family", now: () => this.clock }); }
}

describe("Dynamo reviewed duty rotation transactions", () => {
  it("atomically persists all reviewed new days, preserves existing days, and survives a fresh repository", async () => {
    const existing = { ...duty("2026-09-16", "theo"), changedAt: now.toISOString(), changedBy: "organizer" };
    const table = new ConditionalTable([member("maya"), member("theo"), existing]), repository = table.repository();
    const proposal = await repository.proposeDutyRotation();
    expect(table.transactions).toBe(0);
    const result = await repository.acceptDutyRotation(input(proposal));
    expect(result).toMatchObject({ assigned: 6, replayed: false, requestId: "rotation-request-01" });
    expect(table.get(existing.SK)).toEqual(existing);
    expect([...table.rows.values()].filter(row => row.entityType === "DutyAssignment")).toHaveLength(7);
    table.clock = new Date("2026-09-15T15:00:00Z");
    expect((await table.repository().circle()).assignments).toEqual(result.assignments);
    expect(await table.repository().acceptDutyRotation({ ...input(proposal), actor: "Maya Chen" })).toEqual({ ...result, replayed: true });
    expect(table.transactions).toBe(1);
    expect(table.get("DUTY_ROTATION#rotation-request-01")).not.toHaveProperty("expiresAt");
  });

  it.each(["basis-present", "basis-absent", "target-existing", "target-empty", "eligibility", "member-name", "roster-add", "meta-first-add", "duty-audit"])("rejects concurrent %s changes with zero partially saved proposal days", async change => {
    const table = new ConditionalTable([member("maya"), member("theo"), duty("2026-09-08"), duty("2026-09-16", "theo"), ...(change === "meta-first-add" ? [] : [meta()])]);
    const repository = table.repository(), proposal = await repository.proposeDutyRotation();
    table.beforeTransaction = () => {
      if (change === "basis-present") table.put(duty("2026-09-08", "theo"));
      if (change === "basis-absent") table.put(duty("2026-09-01", "theo"));
      if (change === "target-existing") table.put(duty("2026-09-16", "maya"));
      if (change === "target-empty") table.put(duty("2026-09-15", "theo"));
      if (change === "eligibility") table.put(member("maya", false));
      if (change === "member-name") table.put({ ...member("maya"), name: "Maya Chen" });
      if (change === "roster-add" || change === "meta-first-add") { table.put(member("new-person")); table.put(meta(change === "roster-add" ? 2 : 1)); }
      if (change === "duty-audit") table.put({ ...duty("2026-09-08"), changedAt: now.toISOString() });
    };
    await expect(repository.acceptDutyRotation(input(proposal))).rejects.toThrow(DutyRotationConflict);
    expect(table.get("DUTY_ROTATION#rotation-request-01")).toBeUndefined();
    const target = [...table.rows.values()].filter(row => row.SK >= "DUTY#2026-09-15" && row.SK <= "DUTY#2026-09-21");
    expect(target).toHaveLength(change === "target-empty" ? 2 : 1);
    expect(table.get("DUTY#2026-09-17")).toBeUndefined();
  });

  it("allows only one of two different concurrent reviewed requests, without overwriting its week", async () => {
    const table = new ConditionalTable(), repository = table.repository(), proposal = await repository.proposeDutyRotation();
    const outcomes = await Promise.allSettled([repository.acceptDutyRotation(input(proposal)), repository.acceptDutyRotation(input(proposal, "rotation-request-02"))]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect([...table.rows.values()].filter(row => row.entityType === "DutyAssignment")).toHaveLength(7);
    expect([...table.rows.values()].filter(row => row.entityType === "DutyRotation")).toHaveLength(1);
  });

  it("recovers simultaneous copies of the same request through the committed receipt", async () => {
    const table = new ConditionalTable(), repository = table.repository(), proposal = await repository.proposeDutyRotation();
    const results = await Promise.all([repository.acceptDutyRotation(input(proposal)), repository.acceptDutyRotation(input(proposal))]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.assignments).toEqual(results[1]!.assignments);
    expect([...table.rows.values()].filter(row => row.entityType === "DutyAssignment")).toHaveLength(7);
  });

  it("does not double-apply a transaction whose success response was lost", async () => {
    const table = new ConditionalTable(), repository = table.repository(), proposal = await repository.proposeDutyRotation();
    table.afterCommit = () => { throw new Error("Synthetic committed response lost"); };
    await expect(repository.acceptDutyRotation(input(proposal))).rejects.toThrow("response lost");
    expect(await table.repository().acceptDutyRotation(input(proposal))).toMatchObject({ replayed: true, assigned: 7 });
    expect(table.transactions).toBe(1);
  });

  it.each([undefined, "TransactionConflict", "ProvisionedThroughputExceeded", "ThrottlingError", "ValidationError"])("keeps uncertain storage failure %s distinct from a stale review", async code => {
    const table = new ConditionalTable(), repository = table.repository(), proposal = await repository.proposeDutyRotation();
    const failure = Object.assign(new Error("Synthetic uncertain storage failure"), { name: "TransactionCanceledException",
      ...(code ? { CancellationReasons: [{ Code: code }] } : {}) });
    table.beforeTransaction = () => { throw failure; };
    await expect(repository.acceptDutyRotation(input(proposal))).rejects.toBe(failure);
    expect(table.get("DUTY_ROTATION#rotation-request-01")).toBeUndefined();
  });

  it("rejects forged/stale reviews and changed request intent without writing", async () => {
    const table = new ConditionalTable(), repository = table.repository(), proposal = await repository.proposeDutyRotation();
    await expect(repository.acceptDutyRotation({ ...input(proposal), reviewToken: "f".repeat(64) })).rejects.toThrow(DutyRotationConflict);
    await expect(repository.acceptDutyRotation({ ...input(proposal), startDate: "2026-09-16" })).rejects.toThrow(DutyRotationConflict);
    expect(table.transactions).toBe(0);
    await repository.acceptDutyRotation(input(proposal));
    await expect(repository.acceptDutyRotation({ ...input(proposal), reviewToken: "a".repeat(64) })).rejects.toThrow(DutyRotationConflict);
    expect(table.transactions).toBe(1);
  });

  it.each(["member-pagination", "duty-pagination", "51-members", "corrupt-member", "corrupt-duty", "corrupt-meta"])("fails closed on %s instead of proposing from incomplete data", async fault => {
    const table = new ConditionalTable();
    if (fault === "member-pagination") table.partialMemberPage = true;
    if (fault === "duty-pagination") table.partialDutyPage = true;
    if (fault === "51-members") for (let index = 0; index < 48; index += 1) table.put(member(`person-${index}`));
    if (fault === "corrupt-member") table.put({ ...member("maya"), id: "someone-else" });
    if (fault === "corrupt-duty") table.put({ ...duty("2026-09-08"), SK: "DUTY#2026-09-08#ambiguous" });
    if (fault === "corrupt-meta") table.put({ ...meta(), circleId: "other-family" });
    await expect(table.repository().proposeDutyRotation()).rejects.toThrow(DutyRotationConflict);
    expect(table.transactions).toBe(0);
  });

  it("uses at most 73 distinct transaction actions with the maximum supported roster", async () => {
    const table = new ConditionalTable(Array.from({ length: 50 }, (_, index) => member(`person-${index}`)));
    const repository = table.repository(), proposal = await repository.proposeDutyRotation();
    await repository.acceptDutyRotation(input(proposal));
    expect(table.lastTransaction!.input.TransactItems).toHaveLength(73);
    expect([...table.rows.values()].filter(row => row.entityType === "DutyAssignment")).toHaveLength(7);
  });

  it.each([{ PK: "CIRCLE#other-family" }, { SK: "DUTY_ROTATION#other" }, { entityType: "Other" }, { result: { assigned: 99 } }])("rejects corrupt receipt bindings %j", async patch => {
    const table = new ConditionalTable(), repository = table.repository(), proposal = await repository.proposeDutyRotation();
    await repository.acceptDutyRotation(input(proposal));
    // Deliberately corrupt the value under the requested key, including key attributes.
    table.rows.set(`${PK}|DUTY_ROTATION#rotation-request-01`, { ...table.get("DUTY_ROTATION#rotation-request-01")!, ...patch });
    await expect(repository.acceptDutyRotation(input(proposal))).rejects.toThrow(DutyRotationConflict);
    expect(table.transactions).toBe(1);
  });

  it("leaves unrelated circles and duties outside the explicit lookback/next-week window untouched", async () => {
    const outside = [duty("2026-08-31"), duty("2026-09-22"), { ...duty("2026-09-15"), PK: "CIRCLE#another-family" }];
    const table = new ConditionalTable([member("maya"), ...outside]), repository = table.repository(), proposal = await repository.proposeDutyRotation();
    expect(proposal.members[0]!.basisAssignedDays).toBe(0);
    await repository.acceptDutyRotation(input(proposal));
    for (const row of outside) expect(table.rows.get(`${row.PK}|${row.SK}`)).toEqual(row);
  });
});
