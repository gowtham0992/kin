import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: vi.fn(), secret: vi.fn(), push: vi.fn(), target: vi.fn(), today: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({ ...await original<object>(),
  DynamoDBDocumentClient: { from: () => ({ send: mocks.db, destroy() {} }) } }));
vi.mock("@aws-sdk/client-secrets-manager", async original => ({ ...await original<object>(),
  SecretsManagerClient: class { send = mocks.secret; destroy() {} } }));
vi.mock("web-push", () => ({ default: { sendNotification: mocks.push } }));
vi.mock("../src/push-subscriptions.js", () => ({ createPushSubscriptions: () => ({ forRecipient: mocks.target }) }));
vi.mock("../src/dynamo-care-repository.js", () => ({ createDynamoCareRepository: () => ({ today: mocks.today }) }));
import { createECDH } from "node:crypto";
import { runConfiguredPushTest } from "../src/push-test-runtime.js";
const point = createECDH("prime256v1"); point.setPrivateKey(Buffer.alloc(32, 1));
const publicKey = point.getPublicKey().toString("base64url");
const approval = { id: "4cde63d4-cfe0-4c06-b60e-7aa31a78ab69", memberId: "caregiver",
  subscriptionId: "a".repeat(64), expiresAt: "2026-09-15T03:10:00.000Z" };
const environment = { KIN_PUSH_TEST_ENABLED: "true", KIN_ESCALATION_WORKER_ENABLED: "false", KIN_WEB_PUSH_ENABLED: "true",
  KIN_PUSH_TEST_APPROVAL: JSON.stringify(approval), AWS_REGION: "us-east-1", KIN_DYNAMODB_TABLE: "care",
  KIN_CIRCLE_ID: "circle", KIN_TIME_ZONE: "UTC", KIN_WEB_PUSH_PUBLIC_KEY: publicKey,
  KIN_WEB_PUSH_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:kin/web-push-abc123" };
const event = { source: "kin.push-test", approvalId: approval.id, action: "send", consent: true };
beforeEach(() => {
  vi.resetAllMocks(); vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-15T03:00:00Z"));
  mocks.today.mockResolvedValue({ onDuty: { memberId: "caregiver" } });
  mocks.target.mockResolvedValue({ id: approval.subscriptionId, subscription: {
    endpoint: "https://web.push.apple.com/synthetic", keys: { p256dh: publicKey, auth: Buffer.alloc(16, 1).toString("base64url") } } });
  mocks.secret.mockResolvedValue({ SecretString: JSON.stringify({ publicKey, privateKey: "a".repeat(43), subject: "https://kin.example" }) });
  mocks.db.mockResolvedValue({}); mocks.push.mockResolvedValue({ statusCode: 201 });
});
it("claims a permanent receipt before using the secret and sends one fixed short-lived payload", async () => {
  expect(await runConfiguredPushTest(environment, event)).toEqual({ status: "provider_accepted", delivered: false });
  const claim = mocks.db.mock.calls[0]![0].input;
  expect(claim).toMatchObject({ ConditionExpression: "attribute_not_exists(PK)",
    Item: { PK: `PUSH_TEST#${approval.id}`, SK: "RECEIPT", status: "attempted" } });
  expect(claim.Item.expiresAt).toBeUndefined();
  expect(mocks.db.mock.invocationCallOrder[0]).toBeLessThan(mocks.secret.mock.invocationCallOrder[0]!);
  expect(mocks.push).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.push.mock.calls[0]![1])).toMatchObject({ kind: "connection_test", title: "Kin · Test notification" });
  expect(mocks.push.mock.calls[0]![2]).toMatchObject({ TTL: 60, timeout: 5000 });
});
it("a duplicate durable receipt prevents secret retrieval and publication", async () => {
  mocks.db.mockRejectedValue(Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }));
  expect((await runConfiguredPushTest(environment, event)).status).toBe("already_attempted");
  expect(mocks.secret).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
});
it("unknown claim outcome fails closed without exposing transport details", async () => {
  mocks.db.mockRejectedValue(new Error("PRIVATE"));
  await expect(runConfiguredPushTest(environment, event)).rejects.toThrow("Push test unavailable; inspect before retrying");
  expect(mocks.push).not.toHaveBeenCalled();
});
it("inspection cannot write a receipt or load a signing key", async () => {
  expect((await runConfiguredPushTest(environment, { ...event, action: "inspect" })).status).toBe("ready");
  expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.secret).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
});
