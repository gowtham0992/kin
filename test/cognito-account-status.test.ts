import { AdminGetUserCommand, type AdminGetUserCommandOutput } from "@aws-sdk/client-cognito-identity-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CognitoAccountStatusDirectory } from "../src/cognito-account-status.js";

const subject = "synthetic-stable-sub", poolId = "us-east-1_synthetic";
const modifiedAt = Date.parse("2026-09-11T20:00:00.789Z");
const active = (): AdminGetUserCommandOutput => ({ $metadata: {}, Username: "synthetic-canonical-name",
  Enabled: true, UserStatus: "CONFIRMED", UserAttributes: [{ Name: "sub", Value: subject }], UserLastModifiedDate: new Date(modifiedAt) });

describe("current Cognito account authority", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the stable subject from the configured pool without caching previous authority", async () => {
    let account = active();
    const send = vi.fn(async (_command: AdminGetUserCommand, _options: { abortSignal: AbortSignal }) => account);
    const directory = new CognitoAccountStatusDirectory({ userPoolId: poolId, client: { send } });
    await expect(directory.find(subject)).resolves.toEqual({ accountId: subject, modifiedAt });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(AdminGetUserCommand);
    expect(send.mock.calls[0]?.[0].input).toEqual({ UserPoolId: poolId, Username: subject });
    expect(send.mock.calls[0]?.[1].abortSignal).toBeInstanceOf(AbortSignal);
    account = { ...active(), Enabled: false };
    await expect(directory.find(subject)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["disabled", { Enabled: false }], ["missing enabled state", { Enabled: undefined }],
    ["reset required", { UserStatus: "RESET_REQUIRED" }], ["initial password pending", { UserStatus: "FORCE_CHANGE_PASSWORD" }],
    ["MFA/account confirmation incomplete", { UserStatus: "UNCONFIRMED" }], ["missing status", { UserStatus: undefined }],
    ["different subject", { UserAttributes: [{ Name: "sub", Value: "another-sub" }] }],
    ["missing subject", { UserAttributes: [] }], ["missing change time", { UserLastModifiedDate: undefined }],
    ["invalid change time", { UserLastModifiedDate: new Date(NaN) }],
  ] as const)("does not authorize an account with %s", async (_label, change) => {
    const send = vi.fn(async () => ({ ...active(), ...change }) as AdminGetUserCommandOutput);
    const directory = new CognitoAccountStatusDirectory({ userPoolId: poolId, client: { send } });
    await expect(directory.find(subject)).resolves.toBeUndefined();
  });

  it("treats deletion as no account, and propagates throttling, denied IAM, and upstream failures for fail-closed issuance", async () => {
    for (const name of ["UserNotFoundException", "TooManyRequestsException", "NotAuthorizedException", "InternalErrorException"]) {
      const error = Object.assign(new Error("synthetic-provider-detail"), { name });
      const directory = new CognitoAccountStatusDirectory({ userPoolId: poolId, client: { send: vi.fn(async () => { throw error; }) } });
      if (name === "UserNotFoundException") await expect(directory.find(subject)).resolves.toBeUndefined();
      else await expect(directory.find(subject)).rejects.toBe(error);
    }
  });

  it("bounds the entire read even when credential resolution does not observe request cancellation", async () => {
    vi.useFakeTimers();
    const send = vi.fn((_command: AdminGetUserCommand, _options: { abortSignal: AbortSignal }) => new Promise<AdminGetUserCommandOutput>(() => {}));
    const directory = new CognitoAccountStatusDirectory({ userPoolId: poolId, client: { send } });
    const rejection = expect(directory.find(subject)).rejects.toThrow("Current account status unavailable");
    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;
    expect(send.mock.calls[0]?.[1].abortSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its deadline after a successful read and rejects unusable identity input without any upstream call", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => active());
    const directory = new CognitoAccountStatusDirectory({ userPoolId: poolId, client: { send } });
    await expect(directory.find(subject)).resolves.toEqual({ accountId: subject, modifiedAt });
    expect(vi.getTimerCount()).toBe(0);
    await expect(directory.find(" ")).resolves.toBeUndefined();
    await expect(directory.find("x".repeat(129))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(() => new CognitoAccountStatusDirectory({ userPoolId: " " })).toThrow("Cognito user pool ID is required");
  });
});
