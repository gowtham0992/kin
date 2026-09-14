import {
  GetUserCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type GetUserCommandOutput,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it, vi } from "vitest";
import {
  CognitoAccountAuthenticator,
  InvalidCredentialsError,
  UnsupportedSignInChallengeError,
  NewPasswordRejectedError,
} from "../src/cognito-authenticator.js";

describe("Cognito account authentication", () => {
  it("does not answer incomplete challenges or accept an invalid replacement password", async () => {
    const send = vi.fn(async () => ({ ChallengeName: "NEW_PASSWORD_REQUIRED" as const, $metadata: {} }));
    const auth = new CognitoAccountAuthenticator({ clientId: "test", client: { send } });
    await expect(auth.authenticate("owner@example.com", "Temporary-123!", "short")).rejects.toBeInstanceOf(NewPasswordRejectedError);
    expect(send).not.toHaveBeenCalled();
    await expect(auth.authenticate("owner@example.com", "Temporary-123!", "Permanent-123!")).rejects.toBeInstanceOf(UnsupportedSignInChallengeError);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("completes an initial password challenge using only Cognito's session and verified identity", async () => {
    let now = 1_000;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof InitiateAuthCommand) {
        if (command.input.AuthParameters?.PASSWORD === "Permanent-123!") return { AuthenticationResult: { AccessToken: "fresh-access" }, $metadata: {} };
        return { ChallengeName: "NEW_PASSWORD_REQUIRED" as const, Session: "provider-session", ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user", requiredAttributes: "[]" }, $metadata: {} };
      }
      if (command instanceof RespondToAuthChallengeCommand) { now = 1_200; return { AuthenticationResult: { AccessToken: "new-access" }, $metadata: {} }; }
      expect((command as GetUserCommand).input.AccessToken).toBe("fresh-access");
      return { Username: "canonical-user", UserAttributes: [{ Name: "sub", Value: "verified-sub" }], $metadata: {} };
    });
    const auth = new CognitoAccountAuthenticator({ clientId: "test-client", client: { send }, now: () => now });
    await expect(auth.authenticate("test@example.com", "Temporary-123!", "Permanent-123!"))
      .resolves.toEqual({ accountId: "verified-sub", username: "canonical-user", authenticatedAt: 1_200 });
    expect((send.mock.calls[1]![0] as RespondToAuthChallengeCommand).input).toMatchObject({
      Session: "provider-session", ChallengeName: "NEW_PASSWORD_REQUIRED", ChallengeResponses: { USERNAME: "canonical-user", NEW_PASSWORD: "Permanent-123!" },
    });
    expect((send.mock.calls[2]![0] as InitiateAuthCommand).input).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH", ClientId: "test-client", AuthParameters: { USERNAME: "test@example.com", PASSWORD: "Permanent-123!" },
    });
    expect(send).toHaveBeenCalledTimes(4);
  });
  it("returns Cognito's stable subject after a successful password flow", async () => {
    let now = 1_234;
    const send = vi.fn(async (command: GetUserCommand | InitiateAuthCommand) => {
      if (command instanceof InitiateAuthCommand) {
        now = 2_000;
        return { AuthenticationResult: { AccessToken: "access-token" }, $metadata: {} };
      }
      now = 3_000;
      return {
        Username: "family-owner",
        UserAttributes: [{ Name: "sub", Value: "account-uuid" }],
        $metadata: {},
      };
    });
    const authenticator = new CognitoAccountAuthenticator({
      clientId: "cognito-client",
      client: { send },
      now: () => now,
    });

    await expect(authenticator.authenticate(" owner@example.com ", "correct horse battery staple"))
      .resolves.toEqual({ accountId: "account-uuid", username: "family-owner", authenticatedAt: 1_234 });
    const authCommand = send.mock.calls[0]?.[0];
    expect(authCommand).toBeInstanceOf(InitiateAuthCommand);
    if (!(authCommand instanceof InitiateAuthCommand)) throw new Error("Expected auth command");
    expect(authCommand.input.AuthParameters).toEqual({
      USERNAME: "owner@example.com",
      PASSWORD: "correct horse battery staple",
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetUserCommand);
  });

  it.each(["challenge", "rejected", "missing-token"])("does not use the password-change token if fresh authentication is %s", async failure => {
    const send = vi.fn(async (command: unknown): Promise<InitiateAuthCommandOutput> => {
      if (command instanceof RespondToAuthChallengeCommand) return { AuthenticationResult: { AccessToken: "change-token-must-not-be-used" }, $metadata: {} };
      if (!(command instanceof InitiateAuthCommand)) throw new Error("Must not fetch identity after failed fresh authentication");
      if (command.input.AuthParameters?.PASSWORD === "Temporary-123!") return { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "provider-session", $metadata: {} };
      if (failure === "challenge") return { ChallengeName: "SMS_MFA", $metadata: {} };
      if (failure === "rejected") throw Object.assign(new Error("synthetic credentials rejected"), { name: "NotAuthorizedException" });
      return { $metadata: {} };
    });
    const auth = new CognitoAccountAuthenticator({ clientId: "test-client", client: { send } });
    await expect(auth.authenticate("test@example.com", "Temporary-123!", "Permanent-123!"))
      .rejects.toBeInstanceOf(failure === "challenge" ? UnsupportedSignInChallengeError : InvalidCredentialsError);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("returns one generic failure for invalid, missing, and unconfirmed accounts", async () => {
    for (const name of ["NotAuthorizedException", "UserNotFoundException", "UserNotConfirmedException"]) {
      const error = new Error("provider detail that must not reach the browser");
      error.name = name;
      const send = vi.fn(async (
        _command: GetUserCommand | InitiateAuthCommand,
      ): Promise<GetUserCommandOutput | InitiateAuthCommandOutput> => {
        throw error;
      });
      const authenticator = new CognitoAccountAuthenticator({
        clientId: "cognito-client",
        client: { send },
      });

      await expect(authenticator.authenticate("owner@example.com", "incorrect password"))
        .rejects.toBeInstanceOf(InvalidCredentialsError);
    }
  });

  it("fails closed instead of silently bypassing an MFA or reset challenge", async () => {
    const send = vi.fn(async (
      _command: GetUserCommand | InitiateAuthCommand,
    ): Promise<GetUserCommandOutput | InitiateAuthCommandOutput> => ({
      ChallengeName: "SMS_MFA",
      $metadata: {},
    }));
    const authenticator = new CognitoAccountAuthenticator({
      clientId: "cognito-client",
      client: { send },
    });

    await expect(authenticator.authenticate("owner@example.com", "valid password"))
      .rejects.toBeInstanceOf(UnsupportedSignInChallengeError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized credentials before they reach Cognito", async () => {
    const send = vi.fn();
    const authenticator = new CognitoAccountAuthenticator({
      clientId: "cognito-client",
      client: { send },
    });

    await expect(authenticator.authenticate("owner@example.com", "x".repeat(1_025)))
      .rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(send).not.toHaveBeenCalled();
  });
});
