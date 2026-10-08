import { createECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";
import { AccessDeniedError } from "../src/auth.js";
import { authorizeCareWrite } from "../src/care-write-authorization.js";
import { createPushSubscriptions } from "../src/push-subscriptions.js";
import { createWebPushPublisher, pushSubscriptionSchema, pushConsentVersion, subscriptionId } from "../src/web-push.js";
import type { EscalationRecord } from "../src/escalation.js";

const point = createECDH("prime256v1"); point.generateKeys();
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-private-endpoint", expirationTime: null,
  keys: { p256dh: point.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") } };
const member = { circleId: "circle", memberId: "theo", name: "Theo", role: "caregiver" as const, status: "active" as const };
const principal = { subject: "synthetic", scopes: new Set(["mcp:tools"]), claims: { iss: "https://kin.example" } };
const record = { id: "escalation-private", recipientMemberId: "theo", taskTitle: "PRIVATE CARE TEXT" } as EscalationRecord;

describe("private, on-duty Web Push", () => {
  it.each(["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.test/x", "https://127.0.0.1/x",
    "https://169.254.169.254/latest", "https://user@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x",
    "https://web.push.apple.com/x#fragment"])("rejects unsafe endpoint %s", endpoint => {
    expect(pushSubscriptionSchema.safeParse({ ...subscription, endpoint }).success).toBe(false);
  });
  it("requires valid curve and authentication keys", () => {
    expect(pushSubscriptionSchema.safeParse(subscription).success).toBe(true);
    expect(pushSubscriptionSchema.safeParse({ ...subscription, keys: { ...subscription.keys, p256dh: Buffer.alloc(65).toString("base64url") } }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...subscription, keys: { ...subscription.keys, auth: "bad" } }).success).toBe(false);
  });
  it("publishes only to the frozen recipient with no family data and a short expiry", async () => {
    const destinations = { forRecipient: vi.fn(async () => ({ id: subscriptionId(subscription), subscription })), removeExpired: vi.fn() };
    const send = vi.fn(async () => ({ statusCode: 201, body: "", headers: {} }));
    const publisher = createWebPushPublisher({ destinations, send, vapid: { subject: "mailto:test@example.com", publicKey: "public", privateKey: "secret" } });
    const result = await publisher.publish(record);
    expect(destinations.forRecipient).toHaveBeenCalledExactlyOnceWith("theo");
    expect(send).toHaveBeenCalledOnce();
    const args = (send.mock.calls as unknown as unknown[][])[0]!;
    expect(args[0]).toEqual(subscription); expect(String(args[1])).not.toMatch(/PRIVATE|theo|escalation-private/);
    expect(JSON.parse(String(args[1])).title).toBe("Kin · Family follow-up");
    expect(args[2]).toMatchObject({ TTL: 300, timeout: 5000 });
    expect(result.messageId).toMatch(/^webpush:/);
  });
  it.each([404, 410, 429, 503])("sanitizes %s and deletes only expired destinations", async statusCode => {
    const destinations = { forRecipient: vi.fn(async () => ({ id: subscriptionId(subscription), subscription })), removeExpired: vi.fn() };
    const send = vi.fn(async () => { throw Object.assign(new Error("PRIVATE ENDPOINT"), { statusCode }); });
    const publisher = createWebPushPublisher({ destinations, send, vapid: { subject: "mailto:test@example.com", publicKey: "public", privateKey: "secret" } });
    await expect(publisher.publish(record)).rejects.toThrow("Push delivery unavailable");
    expect(destinations.removeExpired).toHaveBeenCalledTimes([404, 410].includes(statusCode) ? 1 : 0);
    expect(send).toHaveBeenCalledOnce();
  });
  it("cannot send when the recipient has no currently authorized destination", async () => {
    const send = vi.fn();
    const publisher = createWebPushPublisher({ destinations: { forRecipient: async () => null, removeExpired: async () => {} }, send,
      vapid: { subject: "mailto:test@example.com", publicKey: "public", privateKey: "secret" } });
    await expect(publisher.publish(record)).rejects.toThrow("Push recipient unavailable");
    expect(send).not.toHaveBeenCalled();
  });
  it("checks current membership before returning a stored destination", async () => {
    const authorization = authorizeCareWrite({ circleId: "circle", directory: { find: async () => member } }, principal, member, "manage_duty");
    const saved = { ...member, accessKey: authorization.key!.SK, id: subscriptionId(subscription), subscription };
    const send = vi.fn().mockResolvedValueOnce({ Item: saved }).mockResolvedValueOnce({ Item: { ...member, status: "revoked" } })
      .mockResolvedValueOnce({ Item: saved }).mockResolvedValueOnce({ Item: member });
    const store = createPushSubscriptions({ tableName: "care", circleId: "circle", client: { send } });
    expect(await store.forRecipient("theo")).toBeNull();
    expect(await store.forRecipient("theo")).toEqual({ id: saved.id, subscription });
    for (const [command] of send.mock.calls) expect(command.input.ConsistentRead).toBe(true);
  });
  it("enrolls with an atomic membership guard and never accepts a body member ID", async () => {
    const enroll = vi.fn(), remove = vi.fn(), find = vi.fn(async (): Promise<unknown> => member);
    const app = createHttpApp(createDemoStore(), undefined, {
      serveFamilyWorkspace: true, serveSimulator: false,
      accessAuthorizer: { async authorize(header) { if (!header) throw new AccessDeniedError(401, "invalid_token"); return principal; } },
      familyAccess: { circleId: "circle", directory: { find } },
      browserAuth: { clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" },
      push: { publicKey: subscription.keys.p256dh, subscriptions: { enroll, remove, status: async () => ({ state: "none", id: null }), forRecipient: async () => null, removeExpired: async () => {} } },
    });
    const body = { consent: true, consentVersion: pushConsentVersion, subscription };
    await request(app).post("/api/push/subscription").send(body).expect(401);
    await request(app).post("/api/push/subscription").set("authorization", "Bearer synthetic").send({ ...body, memberId: "maya" }).expect(400);
    await request(app).post("/api/push/subscription").set("authorization", "Bearer synthetic").send({ ...body, consent: false }).expect(400);
    await request(app).post("/api/push/subscription").set("authorization", "Bearer synthetic").send(body).expect(204);
    expect(enroll.mock.calls[0]![0].member.memberId).toBe("theo");
    const send = vi.fn(async () => ({}));
    const store = createPushSubscriptions({ tableName: "care", circleId: "circle", client: { send } });
    await store.enroll(enroll.mock.calls[0]![0], subscription);
    expect((send.mock.calls as unknown as [{ input: any }][]) [0]![0].input.TransactItems[1].ConditionCheck).toMatchObject({
      Key: { PK: "CIRCLE#circle", SK: expect.stringMatching(/^ACCESS#/) },
      ExpressionAttributeValues: expect.objectContaining({ ":active": "active", ":role": "caregiver", ":member": "theo" }),
    });
    find.mockResolvedValue({ ...member, role: "viewer" });
    await request(app).post("/api/push/subscription").set("authorization", "Bearer synthetic").send(body).expect(403);
    await request(app).get("/api/push/subscription").set("authorization", "Bearer synthetic").expect(403);
    expect(enroll).toHaveBeenCalledOnce();
  });
  it("returns authenticated phone metadata and duty without asserting that automatic delivery is active", async () => {
    const store = createDemoStore(), today = await store.today();
    vi.spyOn(store, "today").mockResolvedValue({ ...today, onDuty: null });
    const status = vi.fn(async () => ({ state: "saved" as const, id: subscriptionId(subscription) }));
    const app = createHttpApp(store, undefined, {
      serveFamilyWorkspace: true, serveSimulator: false,
      accessAuthorizer: { async authorize(header) { if (!header) throw new AccessDeniedError(401, "invalid_token"); return principal; } },
      familyAccess: { circleId: "circle", directory: { find: async () => member } },
      browserAuth: { clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" },
      push: { publicKey: subscription.keys.p256dh, subscriptions: { status, enroll: async () => {}, remove: async () => {}, forRecipient: async () => null, removeExpired: async () => {} } },
    });
    await request(app).get("/api/push/subscription").expect(401);
    const result = await request(app).get("/api/push/subscription").set("authorization", "Bearer synthetic").expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toMatchObject({ enrollment: { state: "saved", id: subscriptionId(subscription) }, duty: { assigned: false, onDuty: false }, delivery: "unverified", automaticFollowUps: { state: "unknown" } });
    expect(result.text).not.toContain(subscription.endpoint);
    expect(result.text).not.toContain(subscription.keys.auth);
    expect((status.mock.calls as unknown as [{ member: typeof member }][])[0]![0].member.memberId).toBe("theo");
  });
});
