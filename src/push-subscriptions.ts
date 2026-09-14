import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { careWriteCondition, type CareWriteAuthorization } from "./care-write-authorization.js";
import { FamilyAccessDeniedError } from "./membership.js";
import { pushSubscriptionSchema, subscriptionId, type KinPushSubscription, type PushDestinations } from "./web-push.js";

export interface PushSubscriptions extends PushDestinations {
  status(authorization: CareWriteAuthorization): Promise<{ state: "none" | "saved" | "disabled" | "expired"; id: string | null }>;
  enroll(authorization: CareWriteAuthorization, subscription: KinPushSubscription): Promise<void>;
  remove(authorization: CareWriteAuthorization, endpoint: string): Promise<void>;
}
const savedSchema = z.object({
  memberId: z.string(), circleId: z.string(), accessKey: z.string().regex(/^ACCESS#[a-f0-9]{64}$/),
  id: z.string().regex(/^[a-f0-9]{64}$/), subscription: pushSubscriptionSchema,
});

export function createPushSubscriptions(input: {
  tableName: string; circleId: string; region?: string;
  client?: { send(command: GetCommand | TransactWriteCommand | UpdateCommand): Promise<unknown> };
  now?: () => number;
}): PushSubscriptions {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: input.region }));
  const key = (memberId: string) => ({ PK: `CIRCLE#${input.circleId}`, SK: `PUSH#${memberId}` });
  function guard(authorization: CareWriteAuthorization) {
    if (authorization.member.role !== "caregiver") throw new FamilyAccessDeniedError();
    return careWriteCondition(authorization, input.tableName, input.circleId);
  }
  return {
    async status(authorization) {
      guard(authorization);
      await authorization.assertCurrent();
      const result = await client.send(new GetCommand({ TableName: input.tableName,
        Key: key(authorization.member.memberId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      await authorization.assertCurrent();
      const item = result.Item;
      if (!item || item.accessKey !== authorization.key!.SK) return { state: "none", id: null };
      if (item.disabled === true) return { state: "disabled", id: null };
      const saved = savedSchema.parse(item);
      if (saved.memberId !== authorization.member.memberId || saved.circleId !== input.circleId
        || saved.id !== subscriptionId(saved.subscription)) throw new Error("Push settings could not be read");
      if (saved.subscription.expirationTime != null && saved.subscription.expirationTime <= (input.now?.() ?? Date.now())) {
        return { state: "expired", id: null };
      }
      // Only an opaque fingerprint leaves this boundary, never the endpoint or keys.
      return { state: "saved", id: saved.id };
    },
    async enroll(authorization, value) {
      const condition = guard(authorization), subscription = pushSubscriptionSchema.parse(value);
      if (subscription.expirationTime != null && subscription.expirationTime <= (input.now?.() ?? Date.now())) {
        throw new Error("Push subscription expired");
      }
      // One chosen phone per caregiver. Replacement is explicit in the consent UI.
      await client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: input.tableName, Item: { ...key(authorization.member.memberId),
          memberId: authorization.member.memberId, circleId: input.circleId,
          accessKey: authorization.key!.SK, id: subscriptionId(subscription), subscription } } },
        { ConditionCheck: condition },
      ] }));
    },
    async remove(authorization, endpoint) {
      const condition = guard(authorization);
      // An old browser cannot turn off a newly selected phone.
      try {
        await client.send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: input.tableName, Key: key(authorization.member.memberId),
            UpdateExpression: "SET disabled = :disabled, accessKey = :owner REMOVE #subscription",
            ConditionExpression: "attribute_not_exists(PK) OR (accessKey = :owner AND (#subscription.endpoint = :endpoint OR (disabled = :disabled AND attribute_not_exists(#subscription))))",
            ExpressionAttributeNames: { "#subscription": "subscription" },
            ExpressionAttributeValues: { ":endpoint": endpoint, ":owner": authorization.key!.SK, ":disabled": true } } },
          { ConditionCheck: condition },
        ] }));
      } catch { throw new Error("Push settings could not be changed"); }
    },
    async forRecipient(memberId) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(memberId)) return null;
      const result = await client.send(new GetCommand({ TableName: input.tableName, Key: key(memberId), ConsistentRead: true })) as { Item?: unknown };
      if (!result.Item) return null;
      if ((result.Item as { disabled?: unknown }).disabled === true) return null;
      const saved = savedSchema.parse(result.Item);
      if (saved.memberId !== memberId || saved.circleId !== input.circleId || subscriptionId(saved.subscription) !== saved.id) return null;
      if (saved.subscription.expirationTime != null && saved.subscription.expirationTime <= (input.now?.() ?? Date.now())) return null;
      const membership = await client.send(new GetCommand({ TableName: input.tableName,
        Key: { PK: `CIRCLE#${input.circleId}`, SK: saved.accessKey }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const member = membership.Item;
      if (!member || member.status !== "active" || member.role !== "caregiver"
        || member.circleId !== input.circleId || member.memberId !== memberId) return null;
      return { id: saved.id, subscription: saved.subscription };
    },
    async removeExpired(memberId, id) {
      try {
        await client.send(new UpdateCommand({ TableName: input.tableName, Key: key(memberId),
          UpdateExpression: "SET disabled = :disabled REMOVE #subscription",
          ExpressionAttributeNames: { "#subscription": "subscription" },
          ConditionExpression: "id = :id", ExpressionAttributeValues: { ":id": id, ":disabled": true } }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
      }
    },
  };
}
