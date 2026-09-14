import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { authorizeCareWrite, careWriteCondition } from "../src/care-write-authorization.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { FamilyAccessDeniedError, membershipKey, type CarePermission, type Membership } from "../src/membership.js";
import { taskReview } from "../src/task-review.js";
import { calendarDayBounds } from "../src/calendar.js";
import type { CareTask } from "../src/domain.js";

const now = new Date("2026-09-11T15:00:00.000Z"), circleId = "synthetic", PK = `CIRCLE#${circleId}`;
const principal = { subject: "subject", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) };
const member: Membership = { circleId, memberId: "maya", name: "Maya", role: "caregiver", status: "active" };
const task: CareTask = { id: "water", title: "Water", dueAt: "2026-09-11T16:00:00.000Z", state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
const routineId = `care-${"a".repeat(40)}`, routineTask = { ...task, id: "routine-water", routineId };
const alertId = `missed_${task.id}_${task.dueAt}`;
type Row = Record<string, any>;

// This emulator evaluates the real membership condition at commit time. Other
// task/rotation conditions have independent repository tests; no AWS is used.
function fixture(permission: CarePermission) {
  let access: Membership | null = { ...member }, beforeCommit: (() => void) | undefined;
  let savedWrites = 0;
  const transactions: NonNullable<TransactWriteCommandInput["TransactItems"]>[] = [];
  const key = membershipKey(circleId, principal.claims.iss, principal.subject);
  const alert: Row = { PK, SK: `ESCALATION#${task.dueAt}#${task.id}`, entityType: "Escalation", id: alertId,
    taskId: task.id, taskTitle: task.title, dueAt: task.dueAt, status: "queued", recipientMemberId: "maya", recipientMemberName: "Maya",
    createdAt: now.toISOString(), updatedAt: now.toISOString(), attemptCount: 0, attemptId: null, leaseUntil: null, providerMessageId: null, lastErrorCode: null };
  const rows: Row[] = [task, routineTask].map(value => ({ ...value, PK, SK: `TASK#${value.dueAt}#${value.id}`, entityType: "CareTask" }));
  rows.push(alert, { PK, SK: `ROUTINE_REQUEST#${routineId}`, input: {}, tasks: [routineTask] },
    ...["maya", "theo"].map(id => ({ PK, SK: `MEMBER#${id}`, id, name: id === "maya" ? "Maya" : "Theo", relationship: "caregiver", canReceiveAlerts: true, entityType: "CircleMember" })),
    { PK, SK: "DUTY#2026-09-11", memberId: "theo", memberName: "Theo", ...calendarDayBounds("2026-09-11", "UTC"), entityType: "DutyAssignment" });
  const client = { async send(command: unknown): Promise<unknown> {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.find(row => row.SK === command.input.Key?.SK)) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      const prefix = values[":member"] ?? values[":prefix"];
      return { Items: structuredClone(rows.filter(row => prefix ? row.SK.startsWith(prefix) : row.SK >= values[":start"] && row.SK <= values[":end"])) };
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("Authenticated care writes must use a transaction");
    beforeCommit?.(); beforeCommit = undefined;
    const items = command.input.TransactItems!; transactions.push(items);
    const reasons = items.map(item => {
      const condition = item.ConditionCheck;
      if (!condition || condition.Key?.SK !== key.SK) return { Code: "None" };
      const names = condition.ExpressionAttributeNames!, values = condition.ExpressionAttributeValues!;
      const valid = condition.ConditionExpression!.split(" AND ").every(clause => {
        const absent = /^attribute_not_exists\(([^)]+)\)$/.exec(clause);
        if (absent) return (access as Row | null)?.[absent[1]!] === undefined;
        const equals = /^(#[a-zA-Z]+|[a-zA-Z]+) = (:[a-zA-Z]+)$/.exec(clause);
        if (!equals) throw new Error(`Unexpected guard condition: ${clause}`);
        return (access as Row | null)?.[names[equals[1]!] ?? equals[1]!] === values[equals[2]!];
      });
      return { Code: valid ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some(reason => reason.Code !== "None")) throw Object.assign(new Error("Atomic authorization rejected"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    savedWrites += items.filter(item => item.Put || item.Update).length;
    for (const item of items) if (item.Update?.ExpressionAttributeValues?.[":ack"]) alert.acknowledgment = item.Update.ExpressionAttributeValues[":ack"];
    return {};
  } };
  const repository = new DynamoCareRepository({ client, tableName: "synthetic-only", circleId, now: () => now });
  const authorization = authorizeCareWrite({ circleId, directory: { async find() { return access; } } }, principal, member, permission);
  return { repository, authorization, transactions, key, get savedWrites() { return savedWrites; },
    beforeCommit(change: () => void) { beforeCommit = change; }, revoke() { access = null; },
    changeAccess(patch: Partial<Membership>) { access = { ...member, ...patch }; } };
}

const operations = [
  { name: "confirm", permission: "confirm", run: (f: ReturnType<typeof fixture>) => f.repository.confirm({ taskId: task.id, expected: taskReview(task), response: "done", requestId: "confirm-request", actor: member.name }, f.authorization) },
  { name: "schedule task", permission: "manage_plan", run: (f: ReturnType<typeof fixture>) => f.repository.scheduleTask({ id: "new-task", title: "Walk", dueAt: task.dueAt }, f.authorization) },
  { name: "schedule routine", permission: "manage_plan", run: (f: ReturnType<typeof fixture>) => f.repository.scheduleRoutine({ id: "new-routine", title: "Walk", timeZone: "UTC", dueAts: [task.dueAt, "2026-09-12T16:00:00.000Z"] }, f.authorization) },
  { name: "change task", permission: "manage_plan", run: (f: ReturnType<typeof fixture>) => f.repository.changeTask({ taskId: task.id, action: "cancel", expected: { title: task.title, dueAt: task.dueAt }, actor: member.name, requestId: "change-task", confirm: true }, f.authorization) },
  { name: "change routine", permission: "manage_plan", run: (f: ReturnType<typeof fixture>) => f.repository.changeRoutine({ routineId, action: "cancel", expected: [{ id: routineTask.id, title: routineTask.title, dueAt: routineTask.dueAt }], actor: member.name, requestId: "change-routine", confirm: true }, f.authorization) },
  { name: "acknowledge", permission: "manage_duty", run: (f: ReturnType<typeof fixture>) => f.repository.acknowledgeEscalation({ id: alertId, memberId: member.memberId, name: member.name }, f.authorization) },
  { name: "reviewed duty", permission: "manage_duty", run: (f: ReturnType<typeof fixture>) => f.repository.assignDuty({ date: "2026-09-11", memberId: "maya", expectedMemberId: "theo", requestId: "duty-request", actor: member.name }, f.authorization) },
  { name: "legacy duty", permission: "manage_duty", run: (f: ReturnType<typeof fixture>) => f.repository.assignDuty({ date: "2026-09-11", memberId: "maya" }, f.authorization) },
  { name: "whole-week rotation", permission: "manage_duty", run: async (f: ReturnType<typeof fixture>) => {
    const proposal = await f.repository.proposeDutyRotation();
    return f.repository.acceptDutyRotation({ startDate: proposal.startDate, reviewToken: proposal.reviewToken, requestId: "rotation-request", actor: member.name, confirm: true }, f.authorization);
  } },
] satisfies { name: string; permission: CarePermission; run: (f: ReturnType<typeof fixture>) => Promise<unknown> }[];

describe("atomic care authorization", () => {
  it.each(operations)("denies $name when revocation commits after the initial access check", async operation => {
    const f = fixture(operation.permission);
    f.beforeCommit(() => f.revoke());
    await expect(operation.run(f)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    expect(f.transactions).toHaveLength(1);
    expect(f.savedWrites).toBe(0);
  });
  it.each(operations)("allows $name with the exact access condition in the same transaction", async operation => {
    const f = fixture(operation.permission);
    await operation.run(f);
    expect(f.savedWrites).toBeGreaterThan(0);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]!.at(-1)).toEqual({ ConditionCheck: careWriteCondition(f.authorization, "synthetic-only", circleId) });
    expect(f.transactions[0]!.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(f.transactions)).not.toContain("assertCurrent");
  });
  it("rejects a foreign-circle guard before any mutation", async () => {
    const f = fixture("confirm");
    expect(() => careWriteCondition(f.authorization, "synthetic-only", "other-circle")).toThrow(FamilyAccessDeniedError);
    expect(f.savedWrites).toBe(0);
  });
  it.each([{ memberId: "replacement" }, { role: "viewer" as const }, { name: "Changed identity" }, { circleId: "foreign" }, { canInvite: true }])(
    "rejects an access identity/permission change at commit: %j", async patch => {
      const f = fixture("confirm");
      f.beforeCommit(() => f.changeAccess(patch));
      await expect(operations[0]!.run(f)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
      expect(f.savedWrites).toBe(0);
    });
});
