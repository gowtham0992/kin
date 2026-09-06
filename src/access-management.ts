import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { AccessPrincipal } from "./auth.js";
import { FamilyAccessDeniedError, membershipKey, requireMembership, type FamilyAccess } from "./membership.js";

const record = z.object({ PK: z.string(), SK: z.string().regex(/^ACCESS#[a-f0-9]{64}$/), circleId: z.string(),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), name: z.string().min(1).max(80),
  role: z.enum(["viewer", "care_recipient", "caregiver"]), status: z.enum(["active", "revoked"]), canInvite: z.boolean().optional() });
export const revokeAccessBody = z.object({ memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), confirm: z.literal(true) }).strict();
export interface AccessMember { memberId: string; name: string; role: string; status: string; organizer: boolean; canRevoke: boolean }
export interface AccessManagement {
  list(principal: AccessPrincipal): Promise<AccessMember[]>;
  revoke(principal: AccessPrincipal, memberId: string): Promise<void>;
}
export class AccessChangeConflict extends Error { constructor() { super("Access change unavailable"); } }

export function createDynamoAccessManagement(input: { tableName: string; familyAccess: FamilyAccess; region?: string;
  client?: { send(command: QueryCommand | TransactWriteCommand): Promise<unknown> }; now?: () => Date }): AccessManagement {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: input.region }));
  const circleId = input.familyAccess.circleId;
  async function records() {
    const response = await client.send(new QueryCommand({ TableName: input.tableName,
      KeyConditionExpression: "PK = :circle AND begins_with(SK, :access)",
      ExpressionAttributeValues: { ":circle": `CIRCLE#${circleId}`, ":access": "ACCESS#" }, ConsistentRead: true, Limit: 100,
    })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
if (response.LastEvaluatedKey) throw new Error("Access directory exceeds supported circle size");
    return (response.Items ?? []).map(item => {
      const parsed = record.parse(item);
      if (parsed.circleId !== circleId || parsed.PK !== `CIRCLE#${circleId}`) throw new Error("Invalid access directory");
      return parsed;
    });
  }
  return {
    async list(principal) {
      const organizer = await requireMembership(input.familyAccess, principal, "invite");
      return (await records()).map(member => ({ memberId: member.memberId, name: member.name, role: member.role,
        status: member.status, organizer: member.role === "caregiver" && member.canInvite === true,
        canRevoke: member.status === "active" && member.memberId !== organizer.memberId && member.canInvite !== true,
      }));
    },
    async revoke(principal, memberId) {
      const organizer = await requireMembership(input.familyAccess, principal, "invite");
      if (typeof principal.claims.iss !== "string" || memberId === organizer.memberId) throw new FamilyAccessDeniedError();
      const matches = (await records()).filter(member => member.memberId === memberId);
      if (matches.length !== 1 || matches[0]!.canInvite === true) throw new AccessChangeConflict();
      const target = matches[0]!;
      const actorKey = membershipKey(circleId, principal.claims.iss, principal.subject);
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: input.tableName, Key: actorKey,
            ConditionExpression: "#status = :active AND #role = :caregiver AND canInvite = :yes AND memberId = :actor AND circleId = :circle",
            ExpressionAttributeNames: { "#status": "status", "#role": "role" },
            ExpressionAttributeValues: { ":active": "active", ":caregiver": "caregiver", ":yes": true, ":actor": organizer.memberId, ":circle": circleId } } },
          { Update: { TableName: input.tableName, Key: { PK: target.PK, SK: target.SK },
            ConditionExpression: "memberId = :member AND circleId = :circle AND (#status = :active OR #status = :revoked) AND (attribute_not_exists(canInvite) OR canInvite = :no)",
            UpdateExpression: "SET #status = :revoked, revokedAt = if_not_exists(revokedAt, :time), revokedBy = if_not_exists(revokedBy, :actor)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":member": memberId, ":circle": circleId, ":active": "active", ":revoked": "revoked", ":no": false,
              ":time": (input.now?.() ?? new Date()).toISOString(), ":actor": actorKey.SK } } },
        ] }));
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") throw new AccessChangeConflict();
        throw error;
      }
    },
  };
}
