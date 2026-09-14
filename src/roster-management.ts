import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { AccessPrincipal } from "./auth.js";
import { FamilyAccessDeniedError, membershipKey, requireMembership, type FamilyAccess, type Membership } from "./membership.js";

export const rosterLimit = 50;
const accessLimit = 100;
const memberId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
// Reject control and directional characters before trimming, including at the edges.
const personName = z.string().refine(value => !/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value))
  .transform(value => value.trim()).pipe(z.string().min(1).max(80));
export const rosterChangeBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), name: personName, relationship: z.enum(["parent", "caregiver"]), requestId, confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("rename"), memberId, name: personName, expectedName: personName, requestId, confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("connect_self"), memberId, name: personName, expectedName: personName, requestId, confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("enable_duty"), memberId, name: personName, expectedName: personName, requestId, confirm: z.literal(true) }).strict(),
]);
export type RosterChangeInput = z.infer<typeof rosterChangeBody>;
export interface RosterPerson { id: string; name: string; relationship: string; canReceiveAlerts: boolean; canRename: boolean; canConnectSelf?: boolean; canEnableDuty?: boolean }
export interface RosterChangeResult { requestId: string; action: RosterChangeInput["action"]; person: RosterPerson }
export interface RosterManagement {
  list(principal: AccessPrincipal): Promise<{ members: RosterPerson[]; limit: number }>;
  change(principal: AccessPrincipal, input: RosterChangeInput): Promise<RosterChangeResult>;
}
export class RosterConflict extends Error {
  constructor() { super("The roster could not be changed. Refresh the people list and review again."); this.name = "RosterConflict"; }
}
const personRecord = z.object({
  id: memberId, name: personName, relationship: z.enum(["parent", "daughter", "son", "caregiver"]), canReceiveAlerts: z.boolean(),
}).passthrough();
export interface RosterMemberRecord {
  id: string; name: string; relationship: "parent" | "daughter" | "son" | "caregiver"; canReceiveAlerts: boolean;
  accountKey?: unknown; pendingInvitation?: unknown; createdAt?: string; createdBy?: string; changedAt?: string; changedBy?: string;
}
const storedPerson = personRecord.extend({ PK: z.string(), SK: z.string(), entityType: z.literal("CircleMember") });
const accessRecord = z.object({ PK: z.string(), SK: z.string().regex(/^ACCESS#[a-f0-9]{64}$/), circleId: z.string(), memberId,
  status: z.string().optional(), role: z.string().optional() });
const metadata = z.object({ PK: z.string(), SK: z.literal("ROSTER#META"), entityType: z.literal("RosterMetadata"), circleId: z.string(),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) });
const receiptRecord = z.object({ PK: z.string(), SK: z.string(), entityType: z.literal("RosterRequest"), fingerprint: z.string(), actorKey: z.string(),
  result: z.object({ requestId, action: z.enum(["add", "rename", "connect_self", "enable_duty"]), person: z.object({ id: memberId, name: personName, relationship: z.string(), canReceiveAlerts: z.boolean(), canRename: z.boolean() }).strict() }).strict() });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Upper/lower folding also treats sharp-s and final-sigma spellings conservatively as duplicates.
const normalizedName = (name: string) => name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
const fingerprint = (body: RosterChangeInput) => hash(body.action === "add"
  ? [body.action, body.name, body.relationship, body.requestId]
  : [body.action, body.memberId, body.name, body.expectedName, body.requestId]);

function actorIdentity(principal: AccessPrincipal) {
  if (typeof principal.claims.iss !== "string" || !principal.claims.iss || !principal.subject) throw new FamilyAccessDeniedError();
  return [principal.claims.iss, principal.subject] as const;
}
function project(person: RosterMemberRecord, accessIds: ReadonlySet<string>): RosterPerson {
  return { id: person.id, name: person.name, relationship: person.relationship, canReceiveAlerts: person.canReceiveAlerts,
    canRename: !Object.hasOwn(person, "accountKey") && !Object.hasOwn(person, "pendingInvitation") && !accessIds.has(person.id) };
}
function canConnect(person: RosterMemberRecord, people: RosterMemberRecord[], accessIds: ReadonlySet<string>, organizer: Membership, actorKey: string) {
  return /^person-[a-f0-9]{40}$/.test(person.id) && person.createdBy === actorKey && person.relationship === "caregiver" &&
    person.canReceiveAlerts === false && project(person, accessIds).canRename &&
    normalizedName(person.name) === normalizedName(organizer.name) && !people.some(p => p.id === organizer.memberId);
}
function canEnableDuty(person: RosterMemberRecord, caregivers: ReadonlyMap<string, string>) {
  return person.relationship !== "parent" && !person.canReceiveAlerts && typeof person.accountKey === "string"
    && caregivers.get(person.accountKey) === person.id;
}
function nextPerson(body: RosterChangeInput, people: RosterMemberRecord[], accessIds: ReadonlySet<string>, identity: readonly string[], organizer: Membership, actorKey: string, caregivers: ReadonlyMap<string, string>): RosterPerson {
  if (body.action === "enable_duty") {
    const found = people.find(person => person.id === body.memberId);
    if (!found || found.name !== body.expectedName || body.name !== found.name || !canEnableDuty(found, caregivers)) throw new RosterConflict();
    return { ...project(found, accessIds), canReceiveAlerts: true };
  }
  if (body.action === "connect_self") {
    const found = people.find(person => person.id === body.memberId);
    if (!found || found.name !== body.expectedName || body.name !== found.name || !canConnect(found, people, accessIds, organizer, actorKey)) throw new RosterConflict();
    return { id: organizer.memberId, name: found.name, relationship: "caregiver", canReceiveAlerts: true, canRename: false };
  }
  if (people.some(person => (body.action === "add" || person.id !== body.memberId) && normalizedName(person.name) === normalizedName(body.name))) throw new RosterConflict();
  if (body.action === "add") {
    if (people.length >= rosterLimit) throw new RosterConflict();
    return { id: `person-${hash([...identity, body.requestId]).slice(0, 40)}`, name: body.name, relationship: body.relationship, canReceiveAlerts: false, canRename: true };
  }
  const found = people.find(person => person.id === body.memberId);
  if (!found || found.name !== body.expectedName || !project(found, accessIds).canRename) throw new RosterConflict();
  return { ...project(found, accessIds), name: body.name };
}
function replay(raw: unknown, expected: { PK: string; SK: string; actorKey: string; fingerprint: string }): RosterChangeResult | undefined {
  if (raw === undefined) return undefined;
  const item = receiptRecord.parse(raw);
  if (item.PK !== expected.PK || item.SK !== expected.SK || item.actorKey !== expected.actorKey || item.fingerprint !== expected.fingerprint) throw new RosterConflict();
  return structuredClone(item.result);
}
function provenConditionalFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return Array.isArray(reasons) && reasons.some(reason => reason.Code === "ConditionalCheckFailed") &&
    reasons.every(reason => reason.Code === "None" || reason.Code === "ConditionalCheckFailed");
}

export function createDynamoRosterManagement(input: { tableName: string; familyAccess: FamilyAccess; region?: string;
  client?: { send(command: GetCommand | QueryCommand | TransactWriteCommand): Promise<unknown> }; now?: () => Date }): RosterManagement {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: input.region, maxAttempts: 1,
    requestHandler: { connectionTimeout: 500, requestTimeout: 2_000, throwOnRequestTimeout: true } }));
  const circleId = input.familyAccess.circleId, PK = `CIRCLE#${circleId}`;
  const get = async (SK: string) => (await client.send(new GetCommand({ TableName: input.tableName, Key: { PK, SK }, ConsistentRead: true })) as { Item?: unknown }).Item;
  async function query(prefix: string, limit: number) {
    const result = await client.send(new QueryCommand({ TableName: input.tableName,
      KeyConditionExpression: "PK = :circle AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":circle": PK, ":prefix": prefix }, ConsistentRead: true, Limit: limit + 1,
    })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
    if (result.LastEvaluatedKey || (result.Items?.length ?? 0) > limit) throw new Error("Roster directory exceeds supported circle size");
    return result.Items ?? [];
  }
  async function snapshot() {
    // The version must precede both queries: a managed mutation anywhere in these reads then fails the commit CAS.
    const rawMeta = await get("ROSTER#META");
    const meta = rawMeta === undefined ? undefined : metadata.parse(rawMeta);
    if (meta && (meta.PK !== PK || meta.circleId !== circleId)) throw new Error("Invalid roster metadata");
    const people = (await query("MEMBER#", rosterLimit)).map(raw => {
      const person = storedPerson.parse(raw);
      if (person.PK !== PK || person.SK !== `MEMBER#${person.id}`) throw new Error("Invalid roster directory");
      return person;
    });
    if (new Set(people.map(person => person.id)).size !== people.length) throw new Error("Invalid roster directory");
    const caregivers = new Map<string, string>();
    const accessIds = new Set((await query("ACCESS#", accessLimit)).map(raw => {
      const access = accessRecord.parse(raw);
      if (access.PK !== PK || access.circleId !== circleId) throw new Error("Invalid access directory");
      if (access.status === "active" && access.role === "caregiver") caregivers.set(access.SK, access.memberId);
      return access.memberId;
    }));
    return { meta, people, accessIds, caregivers };
  }
  return {
    async list(principal) {
      const organizer = await requireMembership(input.familyAccess, principal, "invite");
      const actorKey = membershipKey(circleId, ...actorIdentity(principal)).SK;
      const { people, accessIds, caregivers } = await snapshot();
      return { members: people.map(person => ({ ...project(person, accessIds), ...(canConnect(person, people, accessIds, organizer, actorKey) ? { canConnectSelf: true } : {}), ...(canEnableDuty(person, caregivers) ? { canEnableDuty: true } : {}) })), limit: rosterLimit };
    },
    async change(principal, rawBody) {
      const organizer = await requireMembership(input.familyAccess, principal, "invite");
      const identity = actorIdentity(principal), body = rosterChangeBody.parse(rawBody);
      const actorKey = membershipKey(circleId, ...identity);
      const receipt = { PK, SK: `ROSTER_REQUEST#${hash([...identity, body.requestId])}`, actorKey: actorKey.SK, fingerprint: fingerprint(body) };
      const original = replay(await get(receipt.SK), receipt);
      if (original) return original;
      const { meta, people, accessIds, caregivers } = await snapshot();
      let person: RosterPerson;
      try { person = nextPerson(body, people, accessIds, identity, organizer, actorKey.SK, caregivers); }
      catch (error) {
        if (error instanceof RosterConflict) {
          // Another copy of this request can commit after the initial receipt read but before the list queries.
          const completed = replay(await get(receipt.SK), receipt);
          if (completed) return completed;
        }
        throw error;
      }
      const result: RosterChangeResult = { requestId: body.requestId, action: body.action, person };
      const at = (input.now?.() ?? new Date()).toISOString();
      const targetKey = { PK, SK: `MEMBER#${person.id}` };
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: input.tableName, Key: actorKey,
            ConditionExpression: "#status = :active AND #role = :caregiver AND canInvite = :yes AND memberId = :actor AND circleId = :circle",
            ExpressionAttributeNames: { "#status": "status", "#role": "role" },
            ExpressionAttributeValues: { ":active": "active", ":caregiver": "caregiver", ":yes": true, ":actor": organizer.memberId, ":circle": circleId } } },
          { Update: { TableName: input.tableName, Key: { PK, SK: "ROSTER#META" },
            ConditionExpression: meta ? "entityType = :type AND circleId = :circle AND #version = :expected" : "attribute_not_exists(PK)",
            UpdateExpression: "SET entityType = :type, circleId = :circle, #version = :next, updatedAt = :time",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":type": "RosterMetadata", ":circle": circleId, ":next": (meta?.version ?? 0) + 1, ":time": at, ...(meta ? { ":expected": meta.version } : {}) } } },
          ...(body.action === "enable_duty" ? [
            { Update: { TableName: input.tableName, Key: targetKey,
              ConditionExpression: "entityType = :type AND id = :member AND #name = :expected AND accountKey = :account AND canReceiveAlerts = :no AND relationship <> :parent",
              UpdateExpression: "SET canReceiveAlerts = :yes, changedAt = :time, changedBy = :actor",
              ExpressionAttributeNames: { "#name": "name" },
              ExpressionAttributeValues: { ":type": "CircleMember", ":member": person.id, ":expected": body.expectedName,
                ":account": people.find(p => p.id === person.id)!.accountKey, ":no": false, ":yes": true,
                ":parent": "parent", ":time": at, ":actor": actorKey.SK } } },
            // DynamoDB cannot check the same item twice. Self-enablement is already
            // fenced by the organizer condition above; other caregivers need their own fence.
            ...(people.find(p => p.id === person.id)!.accountKey === actorKey.SK ? [] : [
              { ConditionCheck: { TableName: input.tableName, Key: { PK, SK: people.find(p => p.id === person.id)!.accountKey as string },
                ConditionExpression: "#status = :active AND #role = :caregiver AND memberId = :member AND circleId = :circle",
                ExpressionAttributeNames: { "#status": "status", "#role": "role" },
                ExpressionAttributeValues: { ":active": "active", ":caregiver": "caregiver", ":member": person.id, ":circle": circleId } } },
            ]),
          ] : body.action === "connect_self" ? [
            { Delete: { TableName: input.tableName, Key: { PK, SK: `MEMBER#${body.memberId}` },
              ConditionExpression: "entityType = :type AND id = :source AND #name = :expected AND createdBy = :actor AND canReceiveAlerts = :no AND relationship = :caregiver AND attribute_not_exists(accountKey) AND attribute_not_exists(pendingInvitation)",
              ExpressionAttributeNames: { "#name": "name" },
              ExpressionAttributeValues: { ":type": "CircleMember", ":source": body.memberId, ":expected": body.expectedName, ":actor": actorKey.SK, ":no": false, ":caregiver": "caregiver" } } },
            { Put: { TableName: input.tableName, Item: { ...targetKey, entityType: "CircleMember", id: person.id, name: person.name,
              relationship: "caregiver", canReceiveAlerts: true, accountKey: actorKey.SK, createdAt: at, createdBy: actorKey.SK },
              ConditionExpression: "attribute_not_exists(PK)" } },
          ] : body.action === "add" ? [{ Put: { TableName: input.tableName,
            Item: { ...targetKey, entityType: "CircleMember", id: person.id, name: person.name, relationship: person.relationship,
              canReceiveAlerts: false, createdAt: at, createdBy: actorKey.SK }, ConditionExpression: "attribute_not_exists(PK)" } }]
            : [{ Update: { TableName: input.tableName, Key: targetKey,
              ConditionExpression: "entityType = :type AND id = :member AND #name = :expected AND attribute_not_exists(accountKey) AND attribute_not_exists(pendingInvitation)",
              UpdateExpression: "SET #name = :name, changedAt = :time, changedBy = :actor",
              ExpressionAttributeNames: { "#name": "name" },
              ExpressionAttributeValues: { ":type": "CircleMember", ":member": person.id, ":expected": body.expectedName,
                ":name": body.name, ":time": at, ":actor": actorKey.SK } } }]),
          { Put: { TableName: input.tableName, Item: { ...receipt, entityType: "RosterRequest", result, createdAt: at,
            ...(body.action === "connect_self" ? { previousPerson: people.find(p => p.id === body.memberId) } : {}) }, ConditionExpression: "attribute_not_exists(PK)" } },
        ] }));
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") {
          const completed = replay(await get(receipt.SK), receipt);
          if (completed) return completed;
          if (provenConditionalFailure(error)) throw new RosterConflict();
        }
        throw error;
      }
      return result;
    },
  };
}

// Local fixtures share this array with the care store; no account creation or messaging is simulated.
export function createMemoryRosterManagement(input: { familyAccess: FamilyAccess; members: RosterMemberRecord[];
  accessMemberIds?: ReadonlySet<string>; activeCaregiverAccounts?: ReadonlyMap<string, string>; now?: () => Date }): RosterManagement {
  const receipts = new Map<string, { fingerprint: string; result: RosterChangeResult }>();
  const accessIds = input.accessMemberIds ?? new Set<string>();
  const caregivers = input.activeCaregiverAccounts ?? new Map<string, string>();
  function people() {
    if (input.members.length > rosterLimit) throw new Error("Roster directory exceeds supported circle size");
    const parsed = input.members.map(person => personRecord.parse(person));
    if (new Set(parsed.map(person => person.id)).size !== parsed.length) throw new Error("Invalid roster directory");
    return parsed;
  }
  return {
    async list(principal) {
      const organizer = await requireMembership(input.familyAccess, principal, "invite");
      const actorKey = membershipKey(input.familyAccess.circleId, ...actorIdentity(principal)).SK;
      const all = people();
      return { members: all.map(person => ({ ...project(person, accessIds), ...(canConnect(person, all, accessIds, organizer, actorKey) ? { canConnectSelf: true } : {}), ...(canEnableDuty(person, caregivers) ? { canEnableDuty: true } : {}) })), limit: rosterLimit };
    },
    async change(principal, rawBody) {
      const organizer = await requireMembership(input.familyAccess, principal, "invite");
      const identity = actorIdentity(principal), body = rosterChangeBody.parse(rawBody);
      const key = hash([...identity, body.requestId]), content = fingerprint(body);
      const original = receipts.get(key);
      if (original) {
        if (original.fingerprint !== content) throw new RosterConflict();
        return structuredClone(original.result);
      }
      const actor = membershipKey(input.familyAccess.circleId, ...identity).SK;
      const person = nextPerson(body, people(), accessIds, identity, organizer, actor, caregivers);
      const at = (input.now?.() ?? new Date()).toISOString();
      if (body.action === "enable_duty") {
        Object.assign(input.members.find(member => member.id === body.memberId)!, { canReceiveAlerts: true, changedAt: at, changedBy: actor });
      } else if (body.action === "connect_self") {
        input.members.splice(input.members.findIndex(p => p.id === body.memberId), 1, { id: person.id, name: person.name, relationship: "caregiver", canReceiveAlerts: true, accountKey: actor, createdAt: at, createdBy: actor });
      } else if (body.action === "add") {
        const { canRename: _canRename, ...record } = person;
        input.members.push({ ...record, relationship: body.relationship, createdAt: at, createdBy: actor });
      } else Object.assign(input.members.find(member => member.id === body.memberId)!, { name: person.name, changedAt: at, changedBy: actor });
      const result: RosterChangeResult = { requestId: body.requestId, action: body.action, person };
      receipts.set(key, { fingerprint: content, result: structuredClone(result) });
      return result;
    },
  };
}
