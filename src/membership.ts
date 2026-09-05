import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { AccessPrincipal } from "./auth.js";

const membershipSchema = z.object({
  circleId: z.string().min(1).max(100),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["viewer", "care_recipient", "caregiver"]),
  status: z.literal("active"),
});
export type Membership = z.infer<typeof membershipSchema>;
export type CarePermission = "read" | "confirm" | "manage_duty";
export interface MembershipDirectory {
  find(principal: AccessPrincipal): Promise<unknown>;
}
export interface FamilyAccess {
  circleId: string;
  directory: MembershipDirectory;
}
export class FamilyAccessDeniedError extends Error {
  constructor() { super("Family access denied"); this.name = "FamilyAccessDeniedError"; }
}

export async function requireMembership(
  access: FamilyAccess | undefined, principal: AccessPrincipal, permission: CarePermission,
): Promise<Membership> {
  if (!access) throw new FamilyAccessDeniedError();
  const parsed = membershipSchema.safeParse(await access.directory.find(principal));
  if (!parsed.success || parsed.data.circleId !== access.circleId) throw new FamilyAccessDeniedError();
  const member = parsed.data;
  if ((permission === "confirm" && member.role === "viewer") ||
      (permission === "manage_duty" && member.role !== "caregiver")) throw new FamilyAccessDeniedError();
  return member;
}

// No care operation is inferred from an unknown or future tool name.
export function mcpCarePermission(body: unknown): CarePermission | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FamilyAccessDeniedError();
  const request = body as { method?: unknown; params?: { name?: unknown } };
  if (request.method === "tools/call") {
    if (request.params?.name === "confirm_care_task") return "confirm";
    if (["show_today", "show_weekly_brief"].includes(String(request.params?.name))) return "read";
    throw new FamilyAccessDeniedError();
  }
  if (["initialize", "notifications/initialized", "ping", "tools/list"].includes(String(request.method))) return null;
  return "read";
}

export function membershipKey(circleId: string, issuer: string, subject: string) {
  const identity = createHash("sha256").update(JSON.stringify([issuer, subject])).digest("hex");
  return { PK: `CIRCLE#${circleId}`, SK: `ACCESS#${identity}` };
}

export function createDynamoMembershipDirectory(input: {
  tableName: string; circleId: string; region?: string;
  client?: { send(command: GetCommand): Promise<unknown> };
}): MembershipDirectory {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: input.region }));
  return {
    async find(principal) {
      if (typeof principal.claims.iss !== "string" || !principal.claims.iss || !principal.subject) return null;
      const result = await client.send(new GetCommand({
        TableName: input.tableName,
        Key: membershipKey(input.circleId, principal.claims.iss, principal.subject),
        ConsistentRead: true,
      })) as { Item?: unknown };
      return result.Item ?? null;
    },
  };
}
