import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createECDH } from "node:crypto";
import { InMemoryCareStore } from "../src/domain.js";
import { careLoopTestTitle } from "../src/care-loop-test.js";
const mocks = vi.hoisted(() => ({ db: vi.fn(), secret: vi.fn(), push: vi.fn(), target: vi.fn(), repository: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({ ...await original<object>(),
  DynamoDBDocumentClient: { from: () => ({ send: mocks.db, destroy() {} }) } }));
vi.mock("@aws-sdk/client-secrets-manager", async original => ({ ...await original<object>(),
  SecretsManagerClient: class { send = mocks.secret; destroy() {} } }));
vi.mock("web-push", () => ({ default: { sendNotification: mocks.push } }));
vi.mock("../src/push-subscriptions.js", () => ({ createPushSubscriptions: () => ({ forRecipient: mocks.target }) }));
vi.mock("../src/dynamo-care-repository.js", () => ({ createDynamoCareRepository: mocks.repository }));
import { runConfiguredCareLoopTest } from "../src/care-loop-test-runtime.js";
const point = createECDH("prime256v1"); point.setPrivateKey(Buffer.alloc(32, 1));
const publicKey = point.getPublicKey().toString("base64url");
const approval = { id: "4cde63d4-cfe0-4c06-b60e-7aa31a78ab69", memberId: "maya", taskId: "test-one",
  dueAt: "2026-09-15T17:30:00.000Z", subscriptionId: "a".repeat(64), expiresAt: "2026-09-15T18:10:00.000Z" };
const environment = { KIN_CARE_LOOP_TEST_ENABLED: "true", KIN_ESCALATION_WORKER_ENABLED: "false", KIN_WEB_PUSH_ENABLED: "true",
  KIN_CARE_LOOP_TEST_APPROVAL: JSON.stringify(approval), AWS_REGION: "us-east-1", KIN_DYNAMODB_TABLE: "care",
  KIN_CIRCLE_ID: "circle", KIN_TIME_ZONE: "UTC", KIN_WEB_PUSH_PUBLIC_KEY: publicKey,
  KIN_WEB_PUSH_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:kin/web-push-abc123" };
const event = { source: "kin.care-loop-test", approvalId: approval.id, action: "send", consent: true };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-15T18:00:00Z"));
  const store = new InMemoryCareStore([{ id: approval.taskId, title: careLoopTestTitle, dueAt: approval.dueAt,
    state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null }], () => new Date(),
  { memberId: "maya", memberName: "Maya", startsAt: "2026-09-15T00:00:00Z", endsAt: "2026-09-16T00:00:00Z" });
  mocks.repository.mockReturnValue(store);
  mocks.target.mockResolvedValue({ id: approval.subscriptionId, subscription: {
    endpoint: "https://web.push.apple.com/synthetic", keys: { p256dh: publicKey, auth: Buffer.alloc(16, 1).toString("base64url") } } });
  mocks.secret.mockResolvedValue({ SecretString: JSON.stringify({ publicKey, privateKey: "a".repeat(43), subject: "https://kin.example" }) });
  mocks.db.mockResolvedValue({}); mocks.push.mockResolvedValue({ statusCode: 201 });
});
afterEach(() => vi.useRealTimers());
it("stores a permanent single-use claim and sends the ordinary privacy-safe follow-up", async () => {
  expect(await runConfiguredCareLoopTest(environment, event)).toMatchObject({ status: "provider_accepted", delivered: false });
  const claim = mocks.db.mock.calls[0]![0].input;
  expect(claim).toMatchObject({ ConditionExpression: "attribute_not_exists(PK)",
    Item: { PK: `CARE_LOOP_TEST#${approval.id}`, SK: "RECEIPT", status: "attempted" } });
  expect(claim.Item.expiresAt).toBeUndefined();
  expect(mocks.db.mock.invocationCallOrder[0]).toBeLessThan(mocks.secret.mock.invocationCallOrder[0]!);
  expect(mocks.push).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.push.mock.calls[0]![1])).toMatchObject({ title: "Kin · Family follow-up",
    body: "A check-in needs a follow-up. Open Kin to review it." });
  expect(mocks.push.mock.calls[0]![1]).not.toContain(careLoopTestTitle);
});
it("inspection cannot write or send", async () => {
  expect(await runConfiguredCareLoopTest(environment, { ...event, action: "inspect" })).toEqual({ status: "ready", delivered: false });
  expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.secret).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
});
it.each([
  { KIN_CARE_LOOP_TEST_ENABLED: undefined }, { KIN_ESCALATION_WORKER_ENABLED: "true" }, { KIN_WEB_PUSH_ENABLED: "false" },
])("rejects a disabled or conflicting gate before accessing data: %j", async flags => {
  await expect(runConfiguredCareLoopTest({ ...environment, ...flags }, event)).rejects.toThrow("Care-loop test unavailable");
  expect(mocks.repository).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
});
it("duplicate receipt cannot load the key or send", async () => {
  mocks.db.mockRejectedValue(Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }));
  expect(await runConfiguredCareLoopTest(environment, event)).toEqual({ status: "already_attempted", delivered: false });
  expect(mocks.secret).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
});
it("an uncertain receipt fails closed with a sanitized error", async () => {
  mocks.db.mockRejectedValue(new Error("PRIVATE"));
  await expect(runConfiguredCareLoopTest(environment, event)).rejects.toThrow("Care-loop test unavailable; inspect before retrying");
  expect(mocks.secret).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
});
