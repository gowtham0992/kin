import { createHash, randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { membershipKey, type Membership } from "./membership.js";

export const familyConsentVersion = "kin-family-v1";
const invitationSchema = z.object({
  circleId: z.string().min(1).max(100),
  circleName: z.string().trim().min(1).max(80),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["viewer", "care_recipient", "caregiver"]),
  targetKey: z.string().regex(/^ACCESS#[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
  status: z.enum(["pending", "accepted", "revoked"]),
  rosterBound: z.boolean().optional(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export interface FamilyEnrollment {
  review(accountId: string, code: string): Promise<Invitation>;
  accept(accountId: string, code: string, consent: string, reviewed: Invitation): Promise<void>;
}
export class InvitationUnavailableError extends Error {
  constructor() { super("This invitation is unavailable. Ask your organizer for a new invitation."); }
}

export function invitationKey(circleId: string, code: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new InvitationUnavailableError();
  return { PK: `CIRCLE#${circleId}`, SK: `INVITE#${createHash("sha256").update(code).digest("hex")}` };
}

// Administrative draft only: the issuer must atomically bind it to the roster before it can be accepted.
// This helper creates no access grant and performs no write.
export function prepareInvitation(input: {
  circleId: string; circleName: string; issuer: string; accountId: string;
  memberId: string; name: string; role: Membership["role"];
}, now: Date = new Date()) {
  if (!input.accountId || new URL(input.issuer).protocol !== "https:") throw new Error("A verified account and HTTPS issuer are required");
  const code = randomBytes(32).toString("base64url");
  const record = invitationSchema.parse({ ...input,
    targetKey: membershipKey(input.circleId, input.issuer, input.accountId).SK,
    expiresAt: Math.floor(now.getTime() / 1000) + 86400, status: "pending",
  });
  return { code, item: { ...invitationKey(input.circleId, code), ...record } };
}

export function createDynamoFamilyEnrollment(input: {
  tableName: string; circleId: string; issuer: string; region?: string; now?: () => Date;
  client?: { send(command: GetCommand | TransactWriteCommand): Promise<unknown> };
}): FamilyEnrollment {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: input.region }));
  const now = input.now ?? (() => new Date());
  const get = async (Key: { PK: string; SK: string }) => {
    const result = await client.send(new GetCommand({ TableName: input.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
    return result.Item;
  };
  const review = async (accountId: string, code: string) => {
    const parsed = invitationSchema.safeParse(await get(invitationKey(input.circleId, code)));
    if (!accountId || !parsed.success || parsed.data.circleId !== input.circleId ||
        parsed.data.targetKey !== membershipKey(input.circleId, input.issuer, accountId).SK ||
        parsed.data.status === "revoked" ||
        (parsed.data.status === "pending" && (parsed.data.rosterBound !== true ||
          parsed.data.expiresAt <= Math.floor(now().getTime() / 1000)))) {
      throw new InvitationUnavailableError();
    }
    if (parsed.data.status === "accepted") {
      const access = await get(membershipKey(input.circleId, input.issuer, accountId)) as Record<string, unknown> | undefined;
      if (access?.status !== "active" || access.acceptedInvitation !== invitationKey(input.circleId, code).SK ||
          access.consentVersion !== familyConsentVersion || access.role !== parsed.data.role || access.memberId !== parsed.data.memberId) {
        throw new InvitationUnavailableError();
      }
    }
    if (parsed.data.status === "pending") {
      const roster = await get({ PK: `CIRCLE#${input.circleId}`, SK: `MEMBER#${parsed.data.memberId}` }) as Record<string, unknown> | undefined;
      if (roster?.accountKey !== parsed.data.targetKey || roster.pendingInvitation !== invitationKey(input.circleId, code).SK) throw new InvitationUnavailableError();
    }
    return parsed.data;
  };
  return {
    review,
    async accept(accountId, code, consent, reviewed) {
      if (consent !== familyConsentVersion) throw new InvitationUnavailableError();
      const invitation = await review(accountId, code);
      if (invitationFingerprint(invitation) !== invitationFingerprint(reviewed)) throw new InvitationUnavailableError();
      if (invitation.status === "accepted") return;
      const acceptedAt = now().toISOString();
      const accessKey = membershipKey(input.circleId, input.issuer, accountId);
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: {
            TableName: input.tableName, Key: { PK: `CIRCLE#${input.circleId}`, SK: `MEMBER#${invitation.memberId}` },
            ConditionExpression: "accountKey = :target AND pendingInvitation = :invitation",
            ExpressionAttributeValues: { ":target": accessKey.SK, ":invitation": invitationKey(input.circleId, code).SK },
          } },
          { Update: {
            TableName: input.tableName, Key: invitationKey(input.circleId, code),
            UpdateExpression: "SET #status = :accepted, acceptedAt = :acceptedAt, consentVersion = :consent",
            ConditionExpression: "#status = :pending AND rosterBound = :bound AND expiresAt > :now AND targetKey = :target AND #role = :role AND memberId = :member AND #name = :name AND circleName = :circleName",
            ExpressionAttributeNames: { "#status": "status", "#role": "role", "#name": "name" },
            ExpressionAttributeValues: {
              ":accepted": "accepted", ":pending": "pending", ":bound": true, ":acceptedAt": acceptedAt,
              ":consent": consent, ":now": Math.floor(now().getTime() / 1000), ":target": accessKey.SK,
              ":role": invitation.role, ":member": invitation.memberId, ":name": invitation.name, ":circleName": invitation.circleName,
            },
          } },
          { Put: {
            TableName: input.tableName,
            Item: { ...accessKey, circleId: input.circleId, memberId: invitation.memberId,
              name: invitation.name, role: invitation.role, status: "active", acceptedAt, consentVersion: consent,
              acceptedInvitation: invitationKey(input.circleId, code).SK },
            ConditionExpression: "attribute_not_exists(PK)",
          } },
        ] }));
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") throw new InvitationUnavailableError();
        throw error;
      }
    },
  };
}

export function invitationFingerprint(invitation: Invitation) {
  const { status: _status, ...terms } = invitation;
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}
