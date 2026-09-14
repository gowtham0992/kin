import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoRosterManagement, createMemoryRosterManagement, rosterChangeBody, RosterConflict,
  type RosterChangeInput, type RosterMemberRecord } from "../src/roster-management.js";
import { FamilyAccessDeniedError, membershipKey } from "../src/membership.js";

const issuer = "https://kin.example", circleId = "family-a", PK = `CIRCLE#${circleId}`;
const principal = { subject: "organizer", scopes: new Set(["mcp:tools"]), claims: { iss: issuer } };
const organizer = { circleId, memberId: "maya", name: "Maya", role: "caregiver", status: "active", canInvite: true };
const add: RosterChangeInput = { action: "add", name: "Alex", relationship: "caregiver", requestId: "add-person-001", confirm: true };
const rename: RosterChangeInput = { action: "rename", memberId: "theo", expectedName: "Theo", name: "Theodore", requestId: "rename-person-001", confirm: true };
const initial = (): RosterMemberRecord[] => [
  { id: "maya", name: "Maya", relationship: "daughter", canReceiveAlerts: true },
  { id: "theo", name: "Theo", relationship: "son", canReceiveAlerts: true },
  { id: "evelyn", name: "Evelyn", relationship: "parent", canReceiveAlerts: false },
];
const now = () => new Date("2026-09-06T12:00:00Z");
function memory(record: unknown = organizer, members = initial(), accessMemberIds = new Set(["maya"])) {
  const familyAccess = { circleId, directory: { find: vi.fn(async () => record) } };
  return { members, roster: createMemoryRosterManagement({ familyAccess, members, accessMemberIds, now }) };
}
type Command = GetCommand | QueryCommand | TransactWriteCommand;
const storedPeople = () => initial().map(person => ({ ...person, PK, SK: `MEMBER#${person.id}`, entityType: "CircleMember" }));
function dynamo(options: { record?: unknown; people?: unknown[]; access?: unknown[]; meta?: unknown } = {}) {
  const familyAccess = { circleId, directory: { find: vi.fn(async () => options.record === undefined ? organizer : options.record) } };
  const rows = new Map<string, unknown>();
  if (options.meta) rows.set("ROSTER#META", options.meta);
  const access = options.access ?? [{ ...membershipKey(circleId, issuer, principal.subject), ...organizer }];
  const send = vi.fn<(command: Command) => Promise<unknown>>(async command => {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(command.input.Key!.SK)) };
    if (command instanceof QueryCommand) return { Items: structuredClone(command.input.ExpressionAttributeValues![":prefix"] === "MEMBER#" ? options.people ?? storedPeople() : access) };
    for (const item of command.input.TransactItems ?? []) {
      if (item.Put?.Item?.entityType === "RosterRequest") rows.set(item.Put.Item.SK, structuredClone(item.Put.Item));
    }
    return {};
  });
  return { send, rows, roster: createDynamoRosterManagement({ tableName: "test-care", familyAccess, client: { send }, now }) };
}
const transaction = (send: ReturnType<typeof dynamo>["send"]) => send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)![0] as TransactWriteCommand;
const cancelled = (codes?: string[]) => Object.assign(new Error("transaction unavailable"), { name: "TransactionCanceledException",
  ...(codes ? { CancellationReasons: codes.map(Code => ({ Code })) } : {}) });

describe("roster request boundary", () => {
  it("trims human names without letting clients choose storage fields, alert status, or identities", () => {
    expect(rosterChangeBody.parse({ ...add, name: "  Alex García  " }).name).toBe("Alex García");
    expect(rosterChangeBody.parse({ ...rename, name: "Theodore", expectedName: " Theo " })).toMatchObject({ expectedName: "Theo" });
  });
  it.each([
    { ...add, confirm: false }, { ...add, confirm: undefined }, { ...add, memberId: "forged" },
    { ...add, canReceiveAlerts: true }, { ...add, accountKey: "ACCOUNT" }, { ...add, relationship: "organizer" },
    { ...add, requestId: "short" }, { ...add, requestId: "x".repeat(101) }, { ...rename, memberId: "../../other" },
    { ...rename, expectedName: undefined }, { ...add, name: " " }, { ...add, name: "x".repeat(81) },
    { ...add, name: "\nAlex" }, { ...add, name: "Alex\u0000" }, { ...add, name: "Alex\u202e" }, { ...add, name: "\u2066Alex" },
  ])("rejects unreviewed, forged, oversized, or directional input: %j", body => {
    expect(rosterChangeBody.safeParse(body).success).toBe(false);
  });
});

describe("organizer roster behavior", () => {
  it.each([null, { ...organizer, canInvite: false }, { ...organizer, canInvite: undefined }, { ...organizer, role: "viewer" },
    { ...organizer, role: "care_recipient" }, { ...organizer, status: "revoked" }, { ...organizer, circleId: "another-family" }])(
    "denies both list and mutation outside active organizer authority: %j", async record => {
      const { roster, members } = memory(record);
      await expect(roster.list(principal)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
      await expect(roster.change(principal, add)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
      expect(members).toEqual(initial());
      const remote = dynamo({ record });
      await expect(remote.roster.list(principal)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
      await expect(remote.roster.change(principal, add)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
      expect(remote.send).not.toHaveBeenCalled();
    },
  );
  it("requires an issuer and subject even with a permissive fixture directory", async () => {
    for (const bad of [{ ...principal, claims: {} }, { ...principal, subject: "" }]) {
      await expect(memory().roster.list(bad)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
      await expect(memory().roster.change(bad, add)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    }
  });
  it("adds a shared roster person without alert eligibility or access data", async () => {
    const { roster, members } = memory();
    const result = await roster.change(principal, add);
    expect(result).toEqual({ requestId: add.requestId, action: "add", person: { id: expect.stringMatching(/^person-[a-f0-9]{40}$/), name: "Alex", relationship: "caregiver", canReceiveAlerts: false, canRename: true } });
    expect(members).toHaveLength(4);
    expect(members[3]).toMatchObject({ id: result.person.id, name: "Alex", canReceiveAlerts: false });
    expect(members[3]).not.toHaveProperty("accountKey");
    expect(await roster.list(principal)).toMatchObject({ limit: 50, members: expect.arrayContaining([result.person]) });
  });
  it("renames only the name/audit fields of an unbound person, leaving unrelated data intact", async () => {
    const members = initial().map(person => ({ ...person, privateNote: "unchanged", phone: "+15550000000" }));
    const { roster } = memory(organizer, members);
    const before = { ...members[1] };
    const result = await roster.change(principal, rename);
    expect(members[1]).toEqual({ ...before, name: "Theodore", changedAt: now().toISOString(), changedBy: membershipKey(circleId, issuer, principal.subject).SK });
    expect(result.person).toEqual({ id: "theo", name: "Theodore", relationship: "son", canReceiveAlerts: true, canRename: true });
    expect(JSON.stringify(await roster.list(principal))).not.toContain("privateNote");
    expect(JSON.stringify(await roster.list(principal))).not.toContain("phone");
  });
  it("returns the original receipt after later edits and does not apply the retried add twice", async () => {
    const { roster, members } = memory();
    const first = await roster.change(principal, add);
    await roster.change(principal, { ...rename, memberId: first.person.id, expectedName: "Alex", name: "Alexander" });
    expect(await roster.change(principal, add)).toEqual(first);
    expect(members.filter(member => member.id === first.person.id)).toHaveLength(1);
    expect(members.find(member => member.id === first.person.id)!.name).toBe("Alexander");
    first.person.name = "mutated response";
    expect((await roster.change(principal, add)).person.name).toBe("Alex");
  });
  it("conflicts when a receipt key is reused with changed terms", async () => {
    const { roster } = memory();
    await roster.change(principal, add);
    for (const body of [{ ...add, name: "Other" }, { ...add, relationship: "parent" as const }, { ...rename, requestId: add.requestId }]) {
      await expect(roster.change(principal, body)).rejects.toBeInstanceOf(RosterConflict);
    }
  });
  it("binds deterministic person IDs and receipt keys to the authenticated actor", async () => {
    const { roster } = memory();
    const one = await roster.change(principal, add);
    const two = await roster.change({ ...principal, subject: "another-organizer" }, { ...add, name: "Sam" });
    expect(two.person.id).not.toBe(one.person.id);
    expect((await memory().roster.change(principal, add)).person.id).toBe(one.person.id);
  });
  it.each(["ｍａｙａ", "MAYA", " Maya "])("rejects normalized duplicate names: %s", async name => {
    await expect(memory().roster.change(principal, { ...add, name })).rejects.toBeInstanceOf(RosterConflict);
  });
  it.each([["Straße", "STRASSE"], ["ΟΣ", "ος"]])("rejects Unicode case-fold collisions: %s / %s", async (name, duplicate) => {
    const { roster } = memory();
    await roster.change(principal, { ...add, name });
    await expect(roster.change(principal, { ...add, name: duplicate, requestId: "different-request" })).rejects.toBeInstanceOf(RosterConflict);
  });
  it("rejects rename collisions, stale reviews, and unknown/foreign person IDs", async () => {
    for (const body of [{ ...rename, name: "MAYA" }, { ...rename, expectedName: "Outdated" }, { ...rename, memberId: "foreign-person" }]) {
      await expect(memory().roster.change(principal, body)).rejects.toBeInstanceOf(RosterConflict);
    }
  });
  it.each([{ accountKey: "ACCESS#known" }, { accountKey: null }, { pendingInvitation: "INVITE#known" }, { pendingInvitation: "" }])(
    "locks account/invitation binding by attribute presence: %j", async binding => {
      const members = initial(); Object.assign(members[1]!, binding);
      const { roster } = memory(organizer, members);
      expect((await roster.list(principal)).members.find(person => person.id === "theo")?.canRename).toBe(false);
      await expect(roster.change(principal, rename)).rejects.toBeInstanceOf(RosterConflict);
    },
  );
  it("locks legacy account mappings even when no binding attributes exist on the person", async () => {
    const { roster } = memory(organizer, initial(), new Set(["theo"]));
    expect((await roster.list(principal)).members.find(person => person.id === "theo")?.canRename).toBe(false);
    await expect(roster.change(principal, rename)).rejects.toBeInstanceOf(RosterConflict);
  });
  it("enforces the fifty-person limit but allows a rename at the limit", async () => {
    const members: RosterMemberRecord[] = Array.from({ length: 50 }, (_, i) => ({ id: `member-${i}`, name: `Member ${i}`, relationship: "caregiver", canReceiveAlerts: false }));
    const { roster } = memory(organizer, members);
    expect((await roster.list(principal)).members).toHaveLength(50);
    await expect(roster.change(principal, add)).rejects.toBeInstanceOf(RosterConflict);
    await expect(roster.change(principal, { ...rename, memberId: "member-1", expectedName: "Member 1" })).resolves.toMatchObject({ person: { name: "Theodore" } });
    members.push({ id: "extra", name: "Extra", relationship: "caregiver", canReceiveAlerts: false });
    await expect(roster.list(principal)).rejects.toThrow("exceeds");
  });
  it("serializes simultaneous local changes without duplicate names or double additions", async () => {
    const { roster, members } = memory();
    const results = await Promise.allSettled([roster.change(principal, add), roster.change(principal, { ...add, requestId: "another-request" })]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(members.filter(person => person.name === "Alex")).toHaveLength(1);
    expect(await roster.change(principal, add)).toMatchObject({ person: { name: "Alex" } });
  });
});

describe("DynamoDB roster invariants", () => {
  const targetKey = membershipKey(circleId, issuer, "joined-caregiver");
  const enable = { action: "enable_duty", memberId: "theo", name: "Theo", expectedName: "Theo", requestId: "enable-duty-001", confirm: true } as const;
  const linkedPeople = () => storedPeople().map(p => p.id === "theo" ? { ...p, accountKey: targetKey.SK, canReceiveAlerts: false } : p);
  it("makes a joined caregiver eligible with membership and roster fences, but no shift or subscription", async () => {
    const remote = dynamo({ people: linkedPeople(), access: [{ ...targetKey, ...organizer, memberId: "theo", canInvite: false }] });
    expect((await remote.roster.list(principal)).members.find(p => p.id === "theo")?.canEnableDuty).toBe(true);
    const result = await remote.roster.change(principal, enable);
    expect(result.person).toMatchObject({ id: "theo", canReceiveAlerts: true, canRename: false });
    const items = transaction(remote.send).input.TransactItems!;
    expect(items).toHaveLength(5);
    expect(items[2]!.Update).toMatchObject({ Key: { PK, SK: "MEMBER#theo" },
      ConditionExpression: expect.stringContaining("accountKey = :account AND canReceiveAlerts = :no"),
      UpdateExpression: "SET canReceiveAlerts = :yes, changedAt = :time, changedBy = :actor",
      ExpressionAttributeValues: { ":account": targetKey.SK, ":yes": true, ":no": false } });
    expect(items[3]!.ConditionCheck).toMatchObject({ Key: targetKey,
      ConditionExpression: "#status = :active AND #role = :caregiver AND memberId = :member AND circleId = :circle" });
    expect(items.flatMap(i => [i.Put?.Item?.SK, i.Update?.Key?.SK]).filter(Boolean).some(k => /^(DUTY|PUSH|SMS)#/.test(String(k)))).toBe(false);
    expect(await remote.roster.change(principal, enable)).toEqual(result);
    expect(remote.send.mock.calls.filter(([c]) => c instanceof TransactWriteCommand)).toHaveLength(1);
  });
  it.each([
    { status: "revoked", role: "caregiver" }, { status: "active", role: "viewer" },
    { status: "active", role: "care_recipient" }, { status: "pending", role: "caregiver" },
  ])("rejects duty enablement for ineligible account %j", async state => {
    const remote = dynamo({ people: linkedPeople(), access: [{ ...targetKey, ...organizer, memberId: "theo", ...state }] });
    expect((await remote.roster.list(principal)).members.find(p => p.id === "theo")?.canEnableDuty).toBeUndefined();
    await expect(remote.roster.change(principal, enable)).rejects.toBeInstanceOf(RosterConflict);
    expect(remote.send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(false);
  });
  it("rejects name-only, mismatched account, parent, and stale-name enablement", async () => {
    for (const patch of [{ accountKey: undefined }, { accountKey: "ACCESS#" + "f".repeat(64) }, { relationship: "parent" }, { name: "Changed" }]) {
      const remote = dynamo({ people: linkedPeople().map(p => p.id === "theo" ? { ...p, ...patch } : p),
        access: [{ ...targetKey, ...organizer, memberId: "theo" }] });
      await expect(remote.roster.change(principal, enable)).rejects.toBeInstanceOf(RosterConflict);
    }
  });
  it("does not duplicate a DynamoDB condition when the organizer enables their own linked roster entry", async () => {
    const ownKey = membershipKey(circleId, issuer, principal.subject);
    const remote = dynamo({ people: storedPeople().map(p => p.id === "maya" ? { ...p, accountKey: ownKey.SK, canReceiveAlerts: false } : p) });
    await remote.roster.change(principal, { ...enable, memberId: "maya", name: "Maya", expectedName: "Maya" });
    const items = transaction(remote.send).input.TransactItems!;
    expect(items.filter(i => i.ConditionCheck)).toHaveLength(1);
    expect(items[0]!.ConditionCheck?.Key).toEqual(ownKey);
  });
  it("fails closed if membership is revoked between review and the eligibility transaction", async () => {
    const remote = dynamo({ people: linkedPeople(), access: [{ ...targetKey, ...organizer, memberId: "theo" }] });
    const original = remote.send.getMockImplementation()!;
    remote.send.mockImplementation(async command => {
      if (command instanceof TransactWriteCommand) throw cancelled(["None", "None", "None", "ConditionalCheckFailed", "None"]);
      return original(command);
    });
    await expect(remote.roster.change(principal, enable)).rejects.toBeInstanceOf(RosterConflict);
    expect(remote.rows.size).toBe(0);
  });
  it("requires organizer authority even when the target is a joined caregiver", async () => {
    const remote = dynamo({ record: { ...organizer, canInvite: false }, people: linkedPeople(), access: [{ ...targetKey, ...organizer, memberId: "theo" }] });
    await expect(remote.roster.change(principal, enable)).rejects.toBeInstanceOf(FamilyAccessDeniedError);
    expect(remote.send).not.toHaveBeenCalled();
  });
  it("reads metadata before bounded consistent person/access queries and projects only public fields", async () => {
    const remote = dynamo({ people: storedPeople().map(person => ({ ...person, phone: "+15550000000", privateNote: "no" })) });
    const result = await remote.roster.list(principal);
    expect(result).toEqual({ limit: 50, members: initial().map(person => ({ ...person, canRename: person.id !== "maya" })) });
    expect(remote.send.mock.calls.map(([command]) => command.input)).toEqual([
      { TableName: "test-care", Key: { PK, SK: "ROSTER#META" }, ConsistentRead: true },
      { TableName: "test-care", KeyConditionExpression: "PK = :circle AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":circle": PK, ":prefix": "MEMBER#" }, ConsistentRead: true, Limit: 51 },
      { TableName: "test-care", KeyConditionExpression: "PK = :circle AND begins_with(SK, :prefix)", ExpressionAttributeValues: { ":circle": PK, ":prefix": "ACCESS#" }, ConsistentRead: true, Limit: 101 },
    ]);
  });
  it("creates the person, metadata, and permanent receipt only inside an organizer-checked transaction", async () => {
    const remote = dynamo();
    const result = await remote.roster.change(principal, add);
    const items = transaction(remote.send).input.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items[0]!.ConditionCheck).toEqual({ TableName: "test-care", Key: membershipKey(circleId, issuer, principal.subject),
      ConditionExpression: "#status = :active AND #role = :caregiver AND canInvite = :yes AND memberId = :actor AND circleId = :circle",
      ExpressionAttributeNames: { "#status": "status", "#role": "role" },
      ExpressionAttributeValues: { ":active": "active", ":caregiver": "caregiver", ":yes": true, ":actor": "maya", ":circle": circleId } });
    expect(items[1]!.Update).toMatchObject({ Key: { PK, SK: "ROSTER#META" }, ConditionExpression: "attribute_not_exists(PK)",
      ExpressionAttributeValues: { ":next": 1, ":circle": circleId, ":type": "RosterMetadata" }, UpdateExpression: "SET entityType = :type, circleId = :circle, #version = :next, updatedAt = :time" });
    expect(items[2]!.Put).toEqual({ TableName: "test-care", Item: { PK, SK: `MEMBER#${result.person.id}`, entityType: "CircleMember", id: result.person.id,
      name: "Alex", relationship: "caregiver", canReceiveAlerts: false, createdAt: now().toISOString(), createdBy: membershipKey(circleId, issuer, principal.subject).SK }, ConditionExpression: "attribute_not_exists(PK)" });
    expect(items[3]!.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(PK)", Item: { PK, SK: expect.stringMatching(/^ROSTER_REQUEST#[a-f0-9]{64}$/),
      entityType: "RosterRequest", actorKey: membershipKey(circleId, issuer, principal.subject).SK, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), result } });
    expect(items[3]!.Put!.Item).not.toHaveProperty("expiresAt");
    expect(items.filter(item => item.Put?.Item?.SK.startsWith("ACCESS#"))).toHaveLength(0);
    const before = remote.send.mock.calls.length;
    expect(await remote.roster.change(principal, add)).toEqual(result);
    expect(remote.send.mock.calls.length - before).toBe(1);
    await expect(remote.roster.change(principal, { ...add, name: "Different" })).rejects.toBeInstanceOf(RosterConflict);
  });
  it("renames using a metadata CAS and field Update guarded against stale names and late invitation binding", async () => {
    const remote = dynamo({ meta: { PK, SK: "ROSTER#META", entityType: "RosterMetadata", circleId, version: 7 } });
    await remote.roster.change(principal, rename);
    const items = transaction(remote.send).input.TransactItems!;
    expect(items[1]!.Update).toMatchObject({ ConditionExpression: "entityType = :type AND circleId = :circle AND #version = :expected",
      ExpressionAttributeValues: { ":expected": 7, ":next": 8 } });
    expect(items[2]!.Update).toEqual({ TableName: "test-care", Key: { PK, SK: "MEMBER#theo" },
      ConditionExpression: "entityType = :type AND id = :member AND #name = :expected AND attribute_not_exists(accountKey) AND attribute_not_exists(pendingInvitation)",
      UpdateExpression: "SET #name = :name, changedAt = :time, changedBy = :actor", ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":type": "CircleMember", ":member": "theo", ":expected": "Theo", ":name": "Theodore", ":time": now().toISOString(), ":actor": membershipKey(circleId, issuer, principal.subject).SK } });
    expect(items.filter(item => item.Put)).toHaveLength(1);
  });
  it.each(["active", "revoked"])("does not rename a legacy %s account mapping", async status => {
    const remote = dynamo({ access: [{ ...membershipKey(circleId, issuer, "legacy"), circleId, memberId: "theo", status }] });
    expect((await remote.roster.list(principal)).members.find(person => person.id === "theo")?.canRename).toBe(false);
    await expect(remote.roster.change(principal, rename)).rejects.toBeInstanceOf(RosterConflict);
    expect(remote.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
  it.each([
    { people: [{ ...storedPeople()[0], PK: "CIRCLE#other" }] }, { people: [{ ...storedPeople()[0], SK: "MEMBER#other" }] },
    { people: [{ ...storedPeople()[0], entityType: "Access" }] }, { people: [storedPeople()[0], storedPeople()[0]] },
    { access: [{ ...membershipKey(circleId, issuer, "other"), circleId: "other", memberId: "other" }] },
    { meta: { PK, SK: "ROSTER#META", entityType: "RosterMetadata", circleId: "other", version: 2 } },
  ])("fails closed on foreign or malformed storage: %j", async options => {
    const remote = dynamo(options);
    await expect(remote.roster.change(principal, add)).rejects.toThrow();
    expect(remote.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
  it.each(["MEMBER#", "ACCESS#"])("rejects truncated %s directories before writing", async prefix => {
    const remote = dynamo(), original = remote.send.getMockImplementation()!;
    remote.send.mockImplementation(async command => command instanceof QueryCommand && command.input.ExpressionAttributeValues![":prefix"] === prefix
      ? { Items: [], LastEvaluatedKey: { PK, SK: "more" } } : original(command));
    await expect(remote.roster.change(principal, add)).rejects.toThrow("exceeds");
    expect(remote.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
  it("rejects oversized directories even if a provider omits the pagination marker", async () => {
    await expect(dynamo({ people: Array.from({ length: 51 }, () => storedPeople()[0]) }).roster.list(principal)).rejects.toThrow("exceeds");
    await expect(dynamo({ access: Array.from({ length: 101 }, () => ({})) }).roster.list(principal)).rejects.toThrow("exceeds");
  });
  it("recovers the exact original result when a concurrent committed request cancels a duplicate transaction", async () => {
    const remote = dynamo(), original = remote.send.getMockImplementation()!;
    remote.send.mockImplementation(async command => {
      const response = await original(command);
      if (command instanceof TransactWriteCommand) throw cancelled(["None", "ConditionalCheckFailed", "None", "ConditionalCheckFailed"]);
      return response;
    });
    const result = await remote.roster.change(principal, add);
    expect(result).toMatchObject({ requestId: add.requestId, person: { name: "Alex" } });
    expect(remote.send.mock.calls.at(-1)![0]).toBeInstanceOf(GetCommand);
    expect(remote.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
  });
  it.each([add, rename])("recovers a raced receipt before a snapshot conflict for $action", async body => {
    const completed = dynamo();
    const result = await completed.roster.change(principal, body);
    const storedReceipt = transaction(completed.send).input.TransactItems!.at(-1)!.Put!.Item!;
    const people = body.action === "add" ? [...storedPeople(), { ...result.person, PK, SK: `MEMBER#${result.person.id}`, entityType: "CircleMember" }]
      : storedPeople().map(person => person.id === body.memberId ? { ...person, name: result.person.name } : person);
    const racing = dynamo({ people }), original = racing.send.getMockImplementation()!;
    racing.send.mockImplementation(async command => {
      if (command instanceof QueryCommand) racing.rows.set(storedReceipt.SK, structuredClone(storedReceipt));
      return original(command);
    });
    expect(await racing.roster.change(principal, body)).toEqual(result);
    expect(racing.send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
  it("maps only proven conditional failures to a review conflict and propagates ambiguous infrastructure failures", async () => {
    const cases = [
      { error: cancelled(["None", "ConditionalCheckFailed", "None", "None"]), conflict: true },
      { error: cancelled(["None", "TransactionConflict", "None", "None"]), conflict: false },
      { error: cancelled(["None", "ProvisionedThroughputExceeded", "None", "None"]), conflict: false },
      { error: cancelled(["ConditionalCheckFailed", "ThrottlingError", "None", "None"]), conflict: false },
      { error: cancelled(), conflict: false }, { error: new Error("socket timeout"), conflict: false },
    ];
    for (const { error, conflict } of cases) {
      const remote = dynamo(), original = remote.send.getMockImplementation()!;
      remote.send.mockImplementation(async command => { if (command instanceof TransactWriteCommand) throw error; return original(command); });
      const result = remote.roster.change(principal, add);
      if (conflict) await expect(result).rejects.toBeInstanceOf(RosterConflict);
      else await expect(result).rejects.toBe(error);
      expect(remote.send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
    }
  });
  it.each(["duplicate", "capacity"])("serializes concurrent Dynamo mutations with the metadata guard: %s", async scenario => {
    const people = scenario === "capacity" ? Array.from({ length: 49 }, (_, i) => ({ PK, SK: `MEMBER#member-${i}`, entityType: "CircleMember",
      id: `member-${i}`, name: `Member ${i}`, relationship: "caregiver", canReceiveAlerts: false })) : storedPeople();
    const remote = dynamo({ people });
    // This provider fake implements the metadata compare-and-set and applies writes atomically. It intentionally allows both read snapshots first.
    let waiting = 0, release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    const original = remote.send.getMockImplementation()!;
    remote.send.mockImplementation(async command => {
      if (command instanceof QueryCommand && command.input.ExpressionAttributeValues![":prefix"] === "ACCESS#") {
        if (++waiting === 2) release();
        await bothRead;
      }
      if (!(command instanceof TransactWriteCommand)) return original(command);
      const items = command.input.TransactItems!, check = items[1]!.Update!, existing = remote.rows.get("ROSTER#META") as { version: number } | undefined;
      const valid = check.ConditionExpression === "attribute_not_exists(PK)" ? existing === undefined
        : existing?.version === check.ExpressionAttributeValues![":expected"];
      if (!valid) throw cancelled(["None", "ConditionalCheckFailed", "None", "None"]);
      remote.rows.set("ROSTER#META", { version: check.ExpressionAttributeValues![":next"] });
      people.push(items[2]!.Put!.Item as typeof people[number]);
      return original(command);
    });
    const outcomes = await Promise.allSettled([
      remote.roster.change(principal, add),
      remote.roster.change(principal, { ...add, requestId: "second-concurrent-request", name: scenario === "duplicate" ? "ＡＬＥＸ" : "Sam" }),
    ]);
    expect(outcomes.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: expect.any(RosterConflict) });
    expect(people).toHaveLength(scenario === "capacity" ? 50 : 4);
    expect(remote.rows.get("ROSTER#META")).toEqual({ version: 1 });
  });
});
