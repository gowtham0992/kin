import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { authorizeCareWrite } from "../src/care-write-authorization.js";
import { FamilyAccessDeniedError, membershipKey, type Membership } from "../src/membership.js";
import { PlanPauseConflict, type PlanPauseProposal } from "../src/plan-pause.js";
import type { CareTask } from "../src/domain.js";
import { taskReview } from "../src/task-review.js";

const start = Date.parse("2026-09-13T16:00:00.000Z"), PK = "CIRCLE#family";
const instant = (hours: number) => new Date(start + hours * 3_600_000).toISOString();
const task = (id: string, hours: number): CareTask => ({ id, title: `Check-in ${id}`, dueAt: instant(hours), state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null });
const sk = (task: CareTask) => `TASK#${task.dueAt}#${task.id}`;
type Row = Record<string, any>;
const member: Membership = { circleId: "family", memberId: "parent", name: "Parent", role: "care_recipient", status: "active" };
function fixture(tasks = [task("one", 1), task("two", 2), task("later", 192)]) {
  let time = start, beforeCommit: (() => void | Promise<void>) | undefined, afterQuery: (() => void | Promise<void>) | undefined;
  let beforeControlRead: (() => void | Promise<void>) | undefined;
  let incomplete = false, loseResponse = false;
  const principal = { subject: "account", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) };
  const accessKey = membershipKey("family", principal.claims.iss, principal.subject);
  const rows = new Map<string, Row>(tasks.map(task => [sk(task), { ...task, PK, SK: sk(task), entityType: "CareTask" }]));
  rows.set(accessKey.SK, { ...accessKey, ...member });
  const commands: unknown[] = [], transactions: TransactWriteCommand[] = [];
  const matches = (condition: string, row: Row | undefined, names: Row = {}, values: Row = {}) => condition.split(" AND ").every(clause => {
    const exists = /^attribute_(not_)?exists\((\w+)\)$/.exec(clause);
    if (exists) return exists[1] ? row?.[exists[2]!] === undefined : row?.[exists[2]!] !== undefined;
    const match = /^(#?\w+) (=|<>|>) (:\w+)$/.exec(clause);
    if (!match) throw new Error(`Unsupported synthetic condition ${clause}`);
    const left = row?.[names[match[1]!] ?? match[1]!], right = values[match[3]!];
    return match[2] === "=" ? left === right : match[2] === ">" ? left > right : left !== right;
  });
  const client = { async send(command: unknown) {
    commands.push(command);
    if (command instanceof GetCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      if (command.input.Key!.SK === "PLAN_CONTROL") { const hook = beforeControlRead; beforeControlRead = undefined; await hook?.(); }
      return { Item: structuredClone(rows.get(command.input.Key!.SK)) };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      const result = { Items: structuredClone([...rows.values()].filter(row => row.SK >= values[":start"] && row.SK <= values[":end"]).sort((a,b) => a.SK.localeCompare(b.SK))),
        ...(incomplete ? { LastEvaluatedKey: { PK, SK: "truncated" } } : {}) };
      const hook = afterQuery; afterQuery = undefined; await hook?.();
      return result;
    }
    if (!(command instanceof TransactWriteCommand)) throw new Error("Pause must use only atomic transactional writes");
    transactions.push(command);
    const hook = beforeCommit; beforeCommit = undefined; await hook?.();
    const items = command.input.TransactItems!;
    const keys = items.map(item => (item.Put?.Item ?? item.Update?.Key ?? item.ConditionCheck?.Key)!.SK);
    expect(new Set(keys).size).toBe(keys.length);
    const reasons = items.map(item => {
      const operation = item.Put ?? item.Update ?? item.ConditionCheck!;
      const key = "Item" in operation ? operation.Item! : operation.Key!;
      return { Code: !operation.ConditionExpression || matches(operation.ConditionExpression, rows.get(key.SK), operation.ExpressionAttributeNames, operation.ExpressionAttributeValues) ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some(reason => reason.Code !== "None")) throw Object.assign(new Error("Synthetic atomic conflict"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    for (const item of items) {
      if (item.Put) rows.set(item.Put.Item!.SK, structuredClone(item.Put.Item!));
      if (item.Update) for (const assignment of item.Update.UpdateExpression!.replace(/^SET /, "").split(", ")) {
        const [field, value] = assignment.split(" = ");
        rows.get(item.Update.Key!.SK)![item.Update.ExpressionAttributeNames?.[field!] ?? field!] = structuredClone(item.Update.ExpressionAttributeValues![value!]);
      }
    }
    if (loseResponse) { loseResponse = false; throw new Error("Synthetic committed response lost"); }
    return {};
  } };
  const options = { client, tableName: "synthetic", circleId: "family", now: () => new Date(time), completionUndoEnabled: true, planPauseEnabled: true };
  const store = new DynamoCareRepository(options);
  const authorization = authorizeCareWrite({ circleId: "family", directory: { async find() { return rows.get(accessKey.SK); } } }, principal, member, "pause_plan");
  return { store, rows, commands, transactions, authorization, disabled: () => new DynamoCareRepository({ ...options, planPauseEnabled: false }),
    advance: (ms: number) => { time += ms; }, beforeCommit: (hook: () => void | Promise<void>) => { beforeCommit = hook; },
    afterQuery: (hook: () => void | Promise<void>) => { afterQuery = hook; }, incomplete: () => { incomplete = true; },
    beforeControlRead: (hook: () => void | Promise<void>) => { beforeControlRead = hook; },
    loseResponse: () => { loseResponse = true; }, revoke: () => rows.delete(accessKey.SK) };
}
const input = (proposal: PlanPauseProposal) => ({ startsAt: proposal.startsAt, endsAt: proposal.endsAt, reviewToken: proposal.reviewToken,
  requestId: "pause-request", confirm: true as const, actor: member.name });
async function prepare(tasks?: CareTask[]) { const f = fixture(tasks), proposal = (await f.store.proposePlanPause())!; return { ...f, proposal, input: input(proposal) }; }

describe("Dynamo one-week plan pause", () => {
  it("atomically cancels all reviewed occurrences, advances the control and saves an immutable receipt with membership last", async () => {
    const f = await prepare(), saved = await f.store.acceptPlanPause(f.input, f.authorization);
    expect(saved.cancelledTasks.map(task => task.id)).toEqual(["one", "two"]);
    expect(f.rows.get(sk(task("later", 192)))?.state).toBe("scheduled");
    expect(f.rows.get("PLAN_CONTROL")).toMatchObject({ version: 1, pause: { endsAt: instant(168) } });
    expect(f.rows.get("PLAN_PAUSE#pause-request")).not.toHaveProperty("expiresAt");
    expect(f.transactions[0]!.input.TransactItems).toHaveLength(5);
    expect(f.transactions[0]!.input.TransactItems?.at(-1)?.ConditionCheck?.Key?.SK).toMatch(/^ACCESS#/);
    expect(await f.store.proposePlanPause()).toBeNull();
    await f.store.scheduleTask({ id: "after", title: "After pause", dueAt: instant(200) });
    f.advance(300_001);
    expect(await f.store.acceptPlanPause(f.input, f.authorization)).toEqual({ ...saved, replayed: true });
    expect((await f.store.planControl()).version).toBe(2);
    expect(f.transactions).toHaveLength(2);
  });
  it.each(["cursor", "501", "26"])("rejects an incomplete or excessive %s review without a partial write", async kind => {
    const f = fixture(kind === "cursor" ? undefined : Array.from({ length: kind === "501" ? 501 : 26 }, (_, index) => task(`t${index}`, kind === "501" ? 200 : 1)));
    if (kind === "cursor") f.incomplete();
    await expect(f.store.proposePlanPause()).rejects.toBeInstanceOf(PlanPauseConflict);
    expect(f.transactions).toHaveLength(0);
  });
  it("detects a creation during the exhaustive query using the second control read", async () => {
    const f = fixture();
    f.afterQuery(async () => { await f.store.scheduleTask({ id: "new", title: "New", dueAt: instant(240) }); });
    await expect(f.store.proposePlanPause()).rejects.toBeInstanceOf(PlanPauseConflict);
    expect(f.transactions).toHaveLength(1);
  });
  it("recovers an identical request that commits between the receipt and second snapshot-control read", async () => {
    const f = await prepare();
    f.afterQuery(async () => { await f.store.acceptPlanPause(f.input, f.authorization); });
    const result = await f.store.acceptPlanPause(f.input, f.authorization);
    expect(result.replayed).toBe(true);
    expect(result.receipt.requestId).toBe(f.input.requestId);
    expect(f.transactions).toHaveLength(1);
  });
  it("loses the pause CAS to a concurrent creation even outside the paused interval without canceling anything", async () => {
    const f = await prepare();
    f.beforeCommit(async () => { await f.store.scheduleTask({ id: "new", title: "New", dueAt: instant(240) }); });
    await expect(f.store.acceptPlanPause(f.input, f.authorization)).rejects.toBeInstanceOf(PlanPauseConflict);
    expect(f.rows.get(sk(task("one", 1)))?.state).toBe("scheduled");
    expect(f.rows.has("PLAN_PAUSE#pause-request")).toBe(false);
  });
  it.each(["single", "routine", "reschedule", "undo"])("a concurrent pause fences %s creation/reopening even outside its interval", async kind => {
    const later = task("later", kind === "undo" ? -1 : 192);
    const f = fixture([task("one", 1), task("two", 2), later]);
    let saved: Awaited<ReturnType<typeof f.store.confirm>> | undefined;
    if (kind === "undo") saved = await f.store.confirm({ taskId: "later", response: "done", actor: member.name, requestId: "done-receipt" });
    const proposal = (await f.store.proposePlanPause())!;
    f.beforeCommit(async () => { await f.store.acceptPlanPause(input(proposal), f.authorization); });
    const operation = kind === "single" ? () => f.store.scheduleTask({ id: "new", title: "New", dueAt: instant(200) })
      : kind === "routine" ? () => f.store.scheduleRoutine({ id: "routine", title: "Daily", timeZone: "UTC", dueAts: [instant(200), instant(224)] })
      : kind === "reschedule" ? () => f.store.changeTask({ taskId: "later", action: "reschedule", expected: { title: "Check-in later", dueAt: instant(192) }, dueAt: instant(200), requestId: "reschedule", actor: member.name, confirm: true })
      : () => f.store.undoCompletion({ taskId: "later", confirmationRequestId: "done-receipt", requestId: "undo-receipt", actor: member.name,
        confirm: true, expected: taskReview(saved!.task), restore: taskReview(later) });
    await expect(operation()).rejects.toThrow();
    expect(f.rows.get("PLAN_CONTROL")?.pause).toBeDefined();
    expect(f.rows.get(sk(later))?.state).toBe(kind === "undo" ? "done" : "scheduled");
    expect([...f.rows.keys()].some(key => key.startsWith("TASK#") && key.includes(instant(200)))).toBe(false);
  });
  it("rechecks active membership in the same transaction; no task or receipt changes on revocation", async () => {
    const f = await prepare(); f.beforeCommit(() => { f.revoke(); });
    await expect(f.store.acceptPlanPause(f.input, f.authorization)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    expect(f.rows.get(sk(task("one", 1)))?.state).toBe("scheduled");
    expect(f.rows.has("PLAN_CONTROL")).toBe(false);
  });
  it.each(["single", "routine", "reschedule", "undo", "confirm"])("recovers the identical %s winner when a later pause makes the stale writer control check fail", async kind => {
    const f = fixture();
    const saved = kind === "undo" ? await f.store.confirm({ taskId: "one", response: "done", actor: member.name, requestId: "done-receipt" }) : undefined;
    const operation = kind === "single" ? () => f.store.scheduleTask({ id: "new", title: "New", dueAt: instant(3) })
      : kind === "routine" ? () => f.store.scheduleRoutine({ id: "routine", title: "Daily", timeZone: "UTC", dueAts: [instant(3), instant(27)] })
      : kind === "reschedule" ? () => f.store.changeTask({ taskId: "later", action: "reschedule", expected: { title: "Check-in later", dueAt: instant(192) }, dueAt: instant(3), requestId: "reschedule", actor: member.name, confirm: true })
      : kind === "confirm" ? () => f.store.confirm({ taskId: "one", response: "not_yet", requestId: "confirm-duplicate", actor: member.name })
      : () => f.store.undoCompletion({ taskId: "one", confirmationRequestId: "done-receipt", requestId: "undo-receipt", actor: member.name,
        confirm: true, expected: taskReview(saved!.task), restore: taskReview(task("one", 1)) });
    let winner: unknown;
    f.beforeControlRead(async () => {
      winner = await operation();
      await f.store.acceptPlanPause(input((await f.store.proposePlanPause())!), f.authorization);
    });
    const retry = await operation();
    expect(retry).toEqual(["undo", "confirm"].includes(kind) ? { ...winner as object, replayed: true } : winner);
    expect(f.transactions).toHaveLength(kind === "undo" ? 3 : 2);
    expect((await f.store.planControl()).pause).toBeDefined();
  });
  it("honors a stored interval with the feature off, including overdue undo and not-yet reopening", async () => {
    const f = fixture([task("one", 0.01)]);
    const original = await f.store.confirm({ taskId: "one", response: "done", actor: member.name, requestId: "done-receipt" });
    const proposal = (await f.store.proposePlanPause())!;
    await f.store.acceptPlanPause(input(proposal), f.authorization); f.advance(60_000);
    const disabled = f.disabled();
    expect(disabled.planPauseEnabled).toBe(false);
    await expect(disabled.proposePlanPause()).rejects.toBeInstanceOf(PlanPauseConflict);
    await expect(disabled.scheduleTask({ id: "new", title: "New", dueAt: instant(2) })).rejects.toBeInstanceOf(PlanPauseConflict);
    await expect(disabled.scheduleRoutine({ id: "new-routine", title: "Daily", timeZone: "UTC", dueAts: [instant(2), instant(26)] })).rejects.toBeInstanceOf(PlanPauseConflict);
    await expect(disabled.undoCompletion({ taskId: "one", confirmationRequestId: "done-receipt", requestId: "undo-receipt", actor: member.name,
      confirm: true, expected: taskReview(original.task), restore: taskReview(task("one", 0.01)) })).rejects.toBeInstanceOf(PlanPauseConflict);
    await expect(disabled.confirm({ taskId: "one", response: "not_yet", actor: member.name, requestId: "notyet-receipt" })).rejects.toBeInstanceOf(PlanPauseConflict);
    await disabled.scheduleTask({ id: "after", title: "After", dueAt: instant(200) });
    expect((await disabled.planControl()).pause?.endsAt).toBe(instant(168));
    expect(f.rows.get(sk(task("one", 0.01)))?.state).toBe("done");
  });
  it.each(["lost", "expired", "changed"])("handles %s outcomes without guessing a successful pause", async kind => {
    const f = await prepare();
    if (kind === "lost") {
      f.loseResponse(); await expect(f.store.acceptPlanPause(f.input)).rejects.toThrow("response lost");
      expect((await f.store.acceptPlanPause(f.input)).replayed).toBe(true); expect(f.transactions).toHaveLength(1);
    } else {
      if (kind === "expired") f.advance(300_001);
      else await f.store.confirm({ taskId: "one", response: "done", actor: member.name, requestId: "changed-response" });
      await expect(f.store.acceptPlanPause(f.input)).rejects.toBeInstanceOf(PlanPauseConflict);
      expect(f.rows.has("PLAN_PAUSE#pause-request")).toBe(false);
    }
  });
  it("rejects malformed control on all writes rather than treating it as no pause", async () => {
    const f = fixture(); f.rows.set("PLAN_CONTROL", { PK, SK: "PLAN_CONTROL", entityType: "PlanControl", version: -1 });
    await expect(f.store.scheduleTask({ id: "new", title: "New", dueAt: instant(200) })).rejects.toBeInstanceOf(PlanPauseConflict);
    await expect(f.store.proposePlanPause()).rejects.toBeInstanceOf(PlanPauseConflict);
    expect(f.transactions).toHaveLength(0);
  });
});
