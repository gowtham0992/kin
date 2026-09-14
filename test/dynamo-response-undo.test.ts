import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { authorizeCareWrite } from "../src/care-write-authorization.js";
import { FamilyAccessDeniedError, membershipKey, type Membership } from "../src/membership.js";
import { CompletionUndoConflict } from "../src/response-undo.js";
import { taskReview } from "../src/task-review.js";
import type { CareTask } from "../src/domain.js";

const now = new Date("2026-09-13T16:00:00.000Z"), PK = "CIRCLE#family";
const task: CareTask = { id: "water", title: "Water", dueAt: "2026-09-13T15:00:00.000Z", state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null };
const taskSK = `TASK#${task.dueAt}#${task.id}`;
type Row = Record<string, any>;
const principal = { subject: "account", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) };
const member: Membership = { circleId: "family", memberId: "parent", name: "Parent", role: "care_recipient", status: "active" };

function fixture(completionUndoEnabled = true) {
  const accessKey = membershipKey("family", principal.claims.iss, principal.subject);
  const rows = new Map<string, Row>([[taskSK, { ...task, PK, SK: taskSK, entityType: "CareTask" }], [accessKey.SK, { ...member, ...accessKey }]]);
  const transactions: TransactWriteCommand[] = [];
  let beforeCommit: (() => void) | undefined, loseResponse = false;
  function matches(condition: string, row: Row | undefined, names: Row = {}, values: Row = {}) {
    return condition.split(" AND ").every(clause => {
      const exists = /^attribute_(not_)?exists\((\w+)\)$/.exec(clause);
      if (exists) return exists[1] ? row?.[exists[2]!] === undefined : row?.[exists[2]!] !== undefined;
      const match = /^(#?\w+) (=|<>) (:\w+)$/.exec(clause);
      if (!match || !Object.hasOwn(values, match[3]!)) throw new Error(`Unsupported synthetic condition: ${clause}`);
      const equal = row?.[names[match[1]!] ?? match[1]!] === values[match[3]!];
      return match[2] === "=" ? equal : !equal;
    });
  }
  const client = { async send(command: unknown) {
    if (command instanceof GetCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      expect(command.input.Key?.PK).toBe(PK);
      return { Item: structuredClone(rows.get(command.input.Key!.SK)) };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      return { Items: structuredClone([...rows.values()].filter(row => row.SK >= values[":start"] && row.SK <= values[":end"])) };
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("Only transactional writes are supported");
    transactions.push(command);
    beforeCommit?.(); beforeCommit = undefined;
    const items = command.input.TransactItems!;
    const reasons = items.map(item => {
      const operation = item.Put ?? item.Update ?? item.ConditionCheck!;
      const key = "Item" in operation ? operation.Item! : operation.Key!;
      const valid = !operation.ConditionExpression || matches(operation.ConditionExpression, rows.get(key.SK), operation.ExpressionAttributeNames, operation.ExpressionAttributeValues);
      return { Code: valid ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some(reason => reason.Code !== "None")) throw Object.assign(new Error("Synthetic atomic conflict"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    for (const item of items) {
      if (item.Put) rows.set(item.Put.Item!.SK, structuredClone(item.Put.Item!));
      if (item.Update) {
        const operation = item.Update, row = rows.get(operation.Key!.SK)!;
        for (const assignment of operation.UpdateExpression!.replace(/^SET /, "").split(", ")) {
          const [field, value] = assignment.split(" = ");
          row[operation.ExpressionAttributeNames?.[field!] ?? field!] = structuredClone(operation.ExpressionAttributeValues![value!]);
        }
      }
    }
    if (loseResponse) { loseResponse = false; throw new Error("Synthetic committed response lost"); }
    return {};
  } };
  const authorization = authorizeCareWrite({ circleId: "family", directory: { async find() { return rows.get(accessKey.SK) ?? null; } } }, principal, member, "confirm");
  const store = new DynamoCareRepository({ client, tableName: "synthetic-only", circleId: "family", now: () => now, completionUndoEnabled });
  return { store, rows, transactions, authorization, beforeCommit: (action: () => void) => { beforeCommit = action; },
    revoke: () => rows.delete(accessKey.SK), loseResponse: () => { loseResponse = true; } };
}
async function prepare() {
  const f = fixture();
  const saved = await f.store.confirm({ taskId: task.id, response: "done", actor: member.name, requestId: "original-completion", expected: taskReview(task) }, f.authorization);
  const input = { taskId: task.id, confirmationRequestId: "original-completion", requestId: "undo-completion", actor: member.name,
    confirm: true as const, expected: taskReview(saved.task), restore: taskReview(task) };
  return { ...f, saved, input };
}

describe("Dynamo completion undo transactions", () => {
  it("keeps metadata writes and undo off until the compatible reader rollout is activated", async () => {
    const f = fixture(false);
    const saved = await f.store.confirm({ taskId: task.id, response: "done", actor: member.name, requestId: "original-completion", expected: taskReview(task) }, f.authorization);
    expect(f.store.completionUndoEnabled).toBe(false);
    expect(f.rows.get(taskSK)).not.toHaveProperty("responseVersion");
    expect(f.rows.get("CONFIRMATION#original-completion")).not.toHaveProperty("before");
    await expect(f.store.undoCompletion({ taskId: task.id, confirmationRequestId: "original-completion", requestId: "undo-completion", actor: member.name,
      confirm: true, expected: taskReview(saved.task), restore: taskReview(task) }, f.authorization)).rejects.toBeInstanceOf(CompletionUndoConflict);
    expect(f.transactions).toHaveLength(1);
  });
  it("atomically restores the prior response and records undo while preserving private original audit metadata", async () => {
    const f = await prepare();
    expect(f.rows.get("CONFIRMATION#original-completion")?.before).toEqual(taskReview(task));
    const undone = await f.store.undoCompletion(f.input, f.authorization);
    expect(undone.task).toEqual(task);
    expect(f.rows.get("CONFIRMATION#original-completion")?.response).toBe("done");
    expect(f.rows.get("COMPLETION_UNDO#undo-completion")?.result.undo.restored).toEqual(taskReview(task));
    expect(f.rows.get("COMPLETION_UNDO#undo-completion")).not.toHaveProperty("expiresAt");
    expect(f.rows.get(taskSK)?.responseVersion).toBe(undone.undo.id);
    expect((await f.store.today()).tasks).toEqual([task]);
    expect((await f.store.escalationSnapshot(now)).tasks).toEqual([task]);
    expect((await f.store.activityBetween({ startDate: "2026-09-13", endDate: "2026-09-13" })).tasks).toEqual([task]);
    const replay = await f.store.confirm({ taskId: task.id, response: "done", actor: member.name, requestId: "original-completion", expected: taskReview(task) }, f.authorization);
    expect(replay.task).toEqual(task);
    expect(replay.confirmation).not.toHaveProperty("before");
    expect(f.transactions[1]!.input.TransactItems).toHaveLength(4);
    expect(f.transactions[1]!.input.TransactItems?.[2]?.Put?.Item).toMatchObject({ SK: "PLAN_CONTROL", version: 2 });
  });
  it.each(["state", "title", "responseVersion"])("rejects a concurrent %s change without partial undo or receipt", async field => {
    const f = await prepare();
    f.beforeCommit(() => { f.rows.get(taskSK)![field] = field === "state" ? "skipped" : "another-value"; });
    await expect(f.store.undoCompletion(f.input, f.authorization)).rejects.toBeInstanceOf(CompletionUndoConflict);
    expect(f.rows.has("COMPLETION_UNDO#undo-completion")).toBe(false);
    expect(f.rows.get(taskSK)?.lastResponse).toBe("done");
  });
  it("rejects membership revoked after reads in the same write transaction", async () => {
    const f = await prepare(); f.beforeCommit(f.revoke);
    await expect(f.store.undoCompletion(f.input, f.authorization)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    expect(f.rows.has("COMPLETION_UNDO#undo-completion")).toBe(false);
    expect(f.rows.get(taskSK)?.state).toBe("done");
  });
  it("recovers a lost committed response with one permanent receipt and no second write", async () => {
    const f = await prepare(); f.loseResponse();
    await expect(f.store.undoCompletion(f.input, f.authorization)).rejects.toThrow("response lost");
    expect((await f.store.undoCompletion(f.input, f.authorization)).replayed).toBe(true);
    expect(f.transactions).toHaveLength(2);
    expect((await f.store.today()).tasks).toEqual([task]);
  });
  it.each(["before", "responseVersion"])("fails closed for a legacy completion missing %s", async field => {
    const f = await prepare();
    delete f.rows.get(field === "before" ? "CONFIRMATION#original-completion" : taskSK)![field];
    await expect(f.store.undoCompletion(f.input, f.authorization)).rejects.toBeInstanceOf(CompletionUndoConflict);
    expect(f.transactions).toHaveLength(1);
  });
  it("rejects a changed desired restoration without replacing it with a new not-yet response", async () => {
    const f = await prepare();
    await expect(f.store.undoCompletion({ ...f.input, restore: { ...f.input.restore, lastResponse: "not_yet", confirmedAt: now.toISOString(), confirmedBy: "Parent" } }, f.authorization)).rejects.toBeInstanceOf(CompletionUndoConflict);
    expect(f.transactions).toHaveLength(1);
  });
  it("rejects a corrupt replay receipt instead of declaring the task restored", async () => {
    const f = await prepare(); await f.store.undoCompletion(f.input, f.authorization);
    f.rows.get("COMPLETION_UNDO#undo-completion")!.result.undo.taskId = "another-task";
    await expect(f.store.undoCompletion(f.input, f.authorization)).rejects.toBeInstanceOf(CompletionUndoConflict);
    expect(f.transactions).toHaveLength(2);
  });
});
