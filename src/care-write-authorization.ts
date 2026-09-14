import type { AccessPrincipal } from "./auth.js";
import { FamilyAccessDeniedError, membershipKey, requireMembership, type CarePermission, type FamilyAccess, type Membership } from "./membership.js";

/** Server-owned context, passed separately so it can never enter a saved receipt or JSON body. */
export interface CareWriteAuthorization {
  readonly member: Readonly<Membership>;
  readonly key: { readonly PK: string; readonly SK: string } | null;
  assertCurrent(): Promise<void>;
}

export function authorizeCareWrite(access: FamilyAccess | undefined, principal: AccessPrincipal, member: Membership, permission: CarePermission): CareWriteAuthorization {
  const reviewed = Object.freeze({ ...member });
  const identity = { ...principal, claims: { ...principal.claims } };
  return Object.freeze({
    member: reviewed,
    key: typeof identity.claims.iss === "string" && identity.claims.iss && identity.subject
      ? Object.freeze(membershipKey(reviewed.circleId, identity.claims.iss, identity.subject)) : null,
    async assertCurrent() {
      const current = await requireMembership(access, identity, permission);
      if (current.memberId !== reviewed.memberId || current.name !== reviewed.name || current.role !== reviewed.role ||
          current.canInvite !== reviewed.canInvite) throw new FamilyAccessDeniedError();
    },
  });
}

export function careWriteCondition(authorization: CareWriteAuthorization, tableName: string, circleId: string) {
  const { member, key } = authorization;
  if (!key || key.PK !== `CIRCLE#${circleId}` || member.circleId !== circleId) throw new FamilyAccessDeniedError();
  return {
    TableName: tableName, Key: { ...key },
    ConditionExpression: "#status = :active AND #role = :role AND memberId = :member AND circleId = :circle AND #name = :name AND " +
      (member.canInvite === undefined ? "attribute_not_exists(canInvite)" : "canInvite = :canInvite"),
    ExpressionAttributeNames: { "#status": "status", "#role": "role", "#name": "name" },
    ExpressionAttributeValues: { ":active": "active", ":role": member.role, ":member": member.memberId,
      ":circle": circleId, ":name": member.name, ...(member.canInvite === undefined ? {} : { ":canInvite": member.canInvite }) },
  };
}

/** Authorization is appended last, preserving existing transaction reason indexes. */
export function assertCareWriteCancellation(error: unknown, guardIndex: number) {
  const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
  if (failure?.name === "TransactionCanceledException" && failure.CancellationReasons?.[guardIndex]?.Code === "ConditionalCheckFailed") {
    throw new FamilyAccessDeniedError();
  }
}
