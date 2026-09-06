import { AdminGetUserCommand, CognitoIdentityProviderClient, type AdminGetUserCommandOutput } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { AccessPrincipal } from "./auth.js";
import { prepareInvitation } from "./invitations.js";
import { FamilyAccessDeniedError, membershipKey, requireMembership, type FamilyAccess } from "./membership.js";

export const issueInvitationBody = z.object({
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  email: z.email().max(320),
  role: z.enum(["viewer", "care_recipient", "caregiver"]),
}).strict();
export type IssueInvitationInput = z.infer<typeof issueInvitationBody>;
export class InvitationIssueError extends Error {
  constructor() { super("Invitation could not be issued. Check the member and completed account setup."); }
}
export interface InvitationIssuer {
  issue(principal: AccessPrincipal, input: IssueInvitationInput): Promise<{ code: string; expiresAt: number; memberId: string; role: IssueInvitationInput["role"] }>;
}
export interface InvitableAccounts { resolve(email: string): Promise<string> }

export function createCognitoInvitableAccounts(input: {
  userPoolId: string; region?: string;
  client?: { send(command: AdminGetUserCommand): Promise<AdminGetUserCommandOutput> };
}): InvitableAccounts {
  const client = input.client ?? new CognitoIdentityProviderClient({ region: input.region });
  return { async resolve(email) {
    const requested = z.email().max(320).parse(email).trim().toLowerCase();
    let result: AdminGetUserCommandOutput;
    try {
      result = await client.send(new AdminGetUserCommand({ UserPoolId: input.userPoolId, Username: requested }));
    } catch (error) {
      if (error instanceof Error && error.name === "UserNotFoundException") throw new InvitationIssueError();
      throw error;
    }
    const attributes = new Map(result.UserAttributes?.map(attribute => [attribute.Name, attribute.Value]));
    const subject = attributes.get("sub");
    if (!result.Enabled || result.UserStatus !== "CONFIRMED" || attributes.get("email_verified") !== "true" ||
        attributes.get("email")?.toLowerCase() !== requested || !subject) throw new InvitationIssueError();
    return subject;
  } };
}

export function createDynamoInvitationIssuer(input: {
  tableName: string; familyAccess: FamilyAccess; circleName: string; issuer: string; accounts: InvitableAccounts;
  region?: string; now?: () => Date;
  client?: { send(command: GetCommand | TransactWriteCommand): Promise<unknown> };
}): InvitationIssuer {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: input.region }));
  return { async issue(principal, body) {
    const organizer = await requireMembership(input.familyAccess, principal, "invite");
    if (principal.claims.iss !== input.issuer) throw new FamilyAccessDeniedError();
    const valid = issueInvitationBody.parse(body);
    const circleId = input.familyAccess.circleId;
    const rosterKey = { PK: `CIRCLE#${circleId}`, SK: `MEMBER#${valid.memberId}` };
    const result = await client.send(new GetCommand({ TableName: input.tableName, Key: rosterKey, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const name = z.string().trim().min(1).max(80).safeParse(result.Item?.name);
    if (!name.success || result.Item?.entityType !== "CircleMember" || result.Item?.id !== valid.memberId) throw new InvitationIssueError();
    const accountId = await input.accounts.resolve(valid.email);
    if (accountId === principal.subject) throw new InvitationIssueError();
    const draft = prepareInvitation({ circleId, circleName: input.circleName, issuer: input.issuer,
      accountId, memberId: valid.memberId, name: name.data, role: valid.role }, input.now?.());
    const organizerKey = membershipKey(circleId, input.issuer, principal.subject);
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: {
          TableName: input.tableName, Key: organizerKey,
          ConditionExpression: "#status = :active AND #role = :caregiver AND canInvite = :yes AND memberId = :member",
          ExpressionAttributeNames: { "#status": "status", "#role": "role" },
          ExpressionAttributeValues: { ":active": "active", ":caregiver": "caregiver", ":yes": true, ":member": organizer.memberId },
        } },
        { ConditionCheck: { TableName: input.tableName, Key: membershipKey(circleId, input.issuer, accountId), ConditionExpression: "attribute_not_exists(PK)" } },
        { Update: {
          TableName: input.tableName, Key: rosterKey,
          ConditionExpression: "attribute_exists(PK) AND #name = :name AND (attribute_not_exists(accountKey) OR accountKey = :target)",
          UpdateExpression: "SET accountKey = :target, pendingInvitation = :invitation",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: { ":name": name.data, ":target": draft.item.targetKey, ":invitation": draft.item.SK },
        } },
        { Put: { TableName: input.tableName, Item: { ...draft.item, rosterBound: true, issuedBy: organizerKey.SK }, ConditionExpression: "attribute_not_exists(PK)" } },
      ] }));
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") throw new InvitationIssueError();
      throw error;
    }
    return { code: draft.code, expiresAt: draft.item.expiresAt, memberId: valid.memberId, role: valid.role };
  } };
}
