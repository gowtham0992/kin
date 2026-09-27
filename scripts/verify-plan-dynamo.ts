/** Isolated real-expression/transaction checks. Never accepts an AWS endpoint or credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CreateTableCommand, DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { authorizeCareWrite } from "../src/care-write-authorization.js";
import { FamilyAccessDeniedError, membershipKey, type Membership } from "../src/membership.js";
import { PlanPauseConflict, type PlanPauseProposal } from "../src/plan-pause.js";
import type { CareTask } from "../src/domain.js";
import { TaskChangeConflict } from "../src/task-change.js";

const directory = process.argv[2];
assert.ok(directory && process.argv.length === 3, "Usage: node --import tsx scripts/verify-plan-dynamo.ts /path/to/verified/DynamoDBLocal");
const jar = path.resolve(directory, "DynamoDBLocal.jar");
await access(jar);
// Reserve an unused local port, then let the owned Java child bind it.
const reservation = createServer();
await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
const address = reservation.address(); assert.ok(address && typeof address !== "string");
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const child = spawn("java", ["-Djava.library.path=" + path.resolve(directory, "DynamoDBLocal_lib"), "-jar", jar,
  "-inMemory", "-sharedDb", "-disableTelemetry", "-port", String(address.port)], {
  cwd: directory, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "", childError: Error | undefined;
child.stdout.on("data", chunk => { childLog = (childLog + chunk).slice(-6000); });
child.stderr.on("data", chunk => { childLog = (childLog + chunk).slice(-6000); });
child.on("error", error => { childError = error; });
const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
// Explicit endpoint and fake credentials prevent default-profile/metadata use.
const raw = new DynamoDBClient({ endpoint: `http://127.0.0.1:${address.port}`, region: "us-east-1",
  credentials: { accessKeyId: "KINLOCALONLY", secretAccessKey: "synthetic-not-an-aws-secret" },
  maxAttempts: 1, requestHandler: { connectionTimeout: 500, requestTimeout: 2000 } });
const db = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
const tableName = `KinLocalPlan${process.pid}`;
const start = Date.parse("2026-09-26T12:00:00.000Z");
const instant = (hours: number) => new Date(start + hours * 3_600_000).toISOString();
const task = (id: string, hours: number): CareTask => ({ id, title: `Synthetic ${id}`, dueAt: instant(hours),
  state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null });
const taskKey = (value: CareTask) => `TASK#${value.dueAt}#${value.id}`;
type Command = GetCommand | PutCommand | QueryCommand | TransactWriteCommand | UpdateCommand;
let caseNumber = 0;

async function fixture() {
  const circleId = `local-${++caseNumber}`, PK = `CIRCLE#${circleId}`;
  const member: Membership = { circleId, memberId: "caregiver", name: "Synthetic caregiver", role: "caregiver", status: "active" };
  const principal = { subject: "local-account", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) };
  const memberKey = membershipKey(circleId, principal.claims.iss, principal.subject);
  await db.send(new PutCommand({ TableName: tableName, Item: { ...memberKey, ...member } }));
  for (const value of [task("one", 1), task("two", 2), task("later", 192)]) {
    await db.send(new PutCommand({ TableName: tableName, Item: { PK, SK: taskKey(value), entityType: "CareTask", ...value } }));
  }
  let beforeCommit: (() => Promise<void>) | undefined, loseResponse = false;
  const sender = { async send(command: Command): Promise<unknown> {
    if (command instanceof TransactWriteCommand) {
      const hook = beforeCommit; beforeCommit = undefined; await hook?.();
      const result = await db.send(command);
      if (loseResponse) { loseResponse = false; throw new Error("Synthetic lost response after real commit"); }
      return result;
    }
    return db.send(command as GetCommand);
  } };
  const options = { client: sender, tableName, circleId, now: () => new Date(start), planPauseEnabled: true };
  const store = new DynamoCareRepository(options);
  const authorization = authorizeCareWrite({ circleId, directory: { async find() {
    return (await db.send(new GetCommand({ TableName: tableName, Key: memberKey, ConsistentRead: true }))).Item;
  } } }, principal, member, "manage_plan");
  const read = async (SK: string) => (await db.send(new GetCommand({ TableName: tableName, Key: { PK, SK }, ConsistentRead: true }))).Item;
  const all = async () => (await db.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": PK }, ConsistentRead: true }))).Items!;
  return { store, authorization, read, all,
    disabled: () => new DynamoCareRepository({ ...options, planPauseEnabled: false }),
    beforeCommit(hook: () => Promise<void>) { beforeCommit = hook; },
    loseResponse() { loseResponse = true; },
    revoke: () => db.send(new UpdateCommand({ TableName: tableName, Key: memberKey,
      UpdateExpression: "SET #status = :revoked", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":revoked": "revoked" } })).then(() => undefined),
  };
}
const move = (requestId = "move") => ({ taskId: "one", action: "reschedule" as const,
  expected: { title: task("one", 1).title, dueAt: instant(1) }, dueAt: instant(3),
  requestId, actor: "Synthetic caregiver", confirm: true as const });
const pauseInput = (proposal: PlanPauseProposal) => ({ startsAt: proposal.startsAt, endsAt: proposal.endsAt,
  reviewToken: proposal.reviewToken, requestId: "pause-local", actor: "Synthetic caregiver", confirm: true as const });
const results: string[] = [];
const failures: Error[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); results.push(name); console.log(`PASS ${name}`); }
  catch (error) { failures.push(new Error(name, { cause: error })); console.error(`FAIL ${name}`, error); }
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (childError || child.exitCode !== null) throw childError ?? new Error(childLog);
    try { await raw.send(new ListTablesCommand({})); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, `DynamoDB Local did not become ready: ${childLog}`);
  await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }, { AttributeName: "SK", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }] }));

  await check("reschedule commits old/new links and replays after a lost response without duplication", async () => {
    const f = await fixture(); f.loseResponse();
    await assert.rejects(f.store.changeTask(move(), f.authorization), /Synthetic lost response/);
    const saved = await f.store.changeTask(move(), f.authorization);
    assert.ok(saved.replacement);
    const old = await f.read(taskKey(task("one", 1)));
    assert.equal(old?.state, "cancelled"); assert.deepEqual(old?.rescheduledTo, saved.replacement);
    const replacement = await f.read(`TASK#${saved.replacement.dueAt}#${saved.replacement.taskId}`);
    assert.equal(replacement?.state, "scheduled");
    assert.deepEqual(replacement?.rescheduledFrom, { taskId: "one", dueAt: instant(1) });
    assert.equal((await f.all()).filter(row => row.entityType === "CareTask").length, 4);
    assert.ok(await f.read("TASK_CHANGE#move"));
  });
  await check("revocation between review and reschedule transaction commits no task or receipt changes", async () => {
    const f = await fixture(), before = await f.all(); f.beforeCommit(f.revoke);
    await assert.rejects(f.store.changeTask(move(), f.authorization), FamilyAccessDeniedError);
    assert.deepEqual((await f.all()).filter(row => !row.SK.startsWith("ACCESS#")), before.filter(row => !row.SK.startsWith("ACCESS#")));
  });
  await check("pause atomically cancels only reviewed tasks and survives lost response", async () => {
    const f = await fixture(), proposal = (await f.store.proposePlanPause())!; f.loseResponse();
    await assert.rejects(f.store.acceptPlanPause(pauseInput(proposal), f.authorization), /Synthetic lost response/);
    const saved = await f.store.acceptPlanPause(pauseInput(proposal), f.authorization);
    assert.equal(saved.replayed, true); assert.deepEqual(saved.cancelledTasks.map(item => item.id), ["one", "two"]);
    assert.equal((await f.read(taskKey(task("one", 1))))?.state, "cancelled");
    assert.equal((await f.read(taskKey(task("two", 2))))?.state, "cancelled");
    assert.equal((await f.read(taskKey(task("later", 192))))?.state, "scheduled");
    assert.equal((await f.read("PLAN_CONTROL"))?.version, 1);
    assert.equal((await f.all()).filter(row => row.entityType === "PlanPause").length, 1);
    const disabled = f.disabled();
    await assert.rejects(disabled.scheduleTask({ id: "blocked", title: "Synthetic blocked", dueAt: instant(4) }), PlanPauseConflict);
    await disabled.scheduleTask({ id: "after", title: "Synthetic after", dueAt: instant(200) });
    assert.equal((await disabled.planControl()).pause?.endsAt, proposal.endsAt);
  });
  await check("revocation during pause commits no cancellation, control or receipt", async () => {
    const f = await fixture(), proposal = (await f.store.proposePlanPause())!, before = await f.all(); f.beforeCommit(f.revoke);
    await assert.rejects(f.store.acceptPlanPause(pauseInput(proposal), f.authorization), FamilyAccessDeniedError);
    assert.deepEqual((await f.all()).filter(row => !row.SK.startsWith("ACCESS#")), before.filter(row => !row.SK.startsWith("ACCESS#")));
  });
  await check("concurrent schedule invalidates a pause review without partially cancelling tasks", async () => {
    const f = await fixture(), proposal = (await f.store.proposePlanPause())!;
    f.beforeCommit(async () => { await f.store.scheduleTask({ id: "concurrent", title: "Synthetic concurrent", dueAt: instant(200) }); });
    await assert.rejects(f.store.acceptPlanPause(pauseInput(proposal), f.authorization), PlanPauseConflict);
    assert.equal((await f.read(taskKey(task("one", 1))))?.state, "scheduled");
    assert.equal((await f.read(taskKey(task("two", 2))))?.state, "scheduled");
    assert.equal(await f.read("PLAN_PAUSE#pause-local"), undefined);
    assert.equal((await f.all()).filter(row => row.entityType === "CareTask").length, 4);
  });
  await check("concurrent pause fences an in-flight reschedule without an orphan replacement", async () => {
    const f = await fixture(), proposal = (await f.store.proposePlanPause())!;
    f.beforeCommit(async () => { await f.store.acceptPlanPause(pauseInput(proposal), f.authorization); });
    await assert.rejects(f.store.changeTask(move(), f.authorization), TaskChangeConflict);
    assert.equal((await f.read(taskKey(task("one", 1))))?.state, "cancelled");
    assert.equal(await f.read("TASK_CHANGE#move"), undefined);
    assert.equal((await f.all()).filter(row => row.entityType === "CareTask").length, 3);
  });
  if (failures.length) throw new AggregateError(failures, `${failures.length} local transaction checks failed`);
  console.log(JSON.stringify({ passed: results.length, engine: "DynamoDB Local", productionEvidence: false, cases: results }, null, 2));
} finally {
  raw.destroy();
  if (child.exitCode === null && !childError) {
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited; clearTimeout(forced);
  }
}
