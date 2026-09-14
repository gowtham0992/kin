import { createECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPushSubscriptions } from "../src/push-subscriptions.js";
import { authorizeCareWrite } from "../src/care-write-authorization.js";
import { subscriptionId } from "../src/web-push.js";

const curve = createECDH("prime256v1"); curve.setPrivateKey(Buffer.alloc(32, 1));
const subscription = { endpoint: "https://web.push.apple.com/synthetic", expirationTime: null,
  keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
const member = { memberId: "caregiver", name: "Caregiver", circleId: "test", role: "caregiver" as const, status: "active" as const };
const authorization = () => authorizeCareWrite({ circleId: "test", directory: { find: async () => member } },
  { subject: "account", claims: { iss: "https://kin.example" }, scopes: new Set(["mcp:tools"]) }, member, "manage_duty");

describe("notification destination lifecycle", () => {
  it("keeps an owner-bound disabled tombstone that permits a retry without permitting replacement-phone deletion", async () => {
    const send = vi.fn(async () => ({})), auth = authorization();
    const store = createPushSubscriptions({ tableName: "test", circleId: "test", client: { send } });
    await store.remove(auth, subscription.endpoint);
    const command = (send.mock.calls as unknown as [{ input: any }][]) [0]![0].input;
    const update = command.TransactItems[0].Update;
    expect(update.UpdateExpression).toBe("SET disabled = :disabled, accessKey = :owner REMOVE #subscription");
    expect(update.ConditionExpression).toBe("attribute_not_exists(PK) OR (accessKey = :owner AND (#subscription.endpoint = :endpoint OR (disabled = :disabled AND attribute_not_exists(#subscription))))");
    expect(update.ExpressionAttributeValues).toEqual({ ":disabled": true, ":owner": auth.key!.SK, ":endpoint": subscription.endpoint });
    expect(command.TransactItems[1].ConditionCheck.ExpressionAttributeValues[":active"]).toBe("active");
  });
  it("returns only connection metadata for the authenticated owner", async () => {
    const auth = authorization(), saved = { ...member, accessKey: auth.key!.SK, id: subscriptionId(subscription), subscription };
    const send = vi.fn(async () => ({ Item: saved }));
    const store = createPushSubscriptions({ tableName: "test", circleId: "test", client: { send } });
    expect(await store.status(auth)).toEqual({ state: "saved", id: saved.id });
    expect((send.mock.calls as unknown as [{ input: any }][]) [0]![0].input).toMatchObject({
      Key: { PK: "CIRCLE#test", SK: "PUSH#caregiver" }, ConsistentRead: true,
    });
    saved.accessKey = `ACCESS#${"f".repeat(64)}`;
    expect(await store.status(auth)).toEqual({ state: "none", id: null });
  });
  it.each(["none", "disabled", "expired"])("distinguishes %s without exposing subscription keys", async state => {
    const auth = authorization();
    const item = state === "none" ? undefined : { ...member, accessKey: auth.key!.SK, id: subscriptionId(subscription),
      ...(state === "disabled" ? { disabled: true } : { subscription: { ...subscription, expirationTime: 1 } }) };
    const store = createPushSubscriptions({ tableName: "test", circleId: "test", client: { send: async () => ({ Item: item }) }, now: () => 2 });
    expect(await store.status(auth)).toEqual({ state, id: null });
  });
});
