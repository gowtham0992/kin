import {
  GetUserCommand,
  InitiateAuthCommand,
  type GetUserCommandOutput,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it, vi } from "vitest";
import {
  CognitoAccountAuthenticator,
  InvalidCredentialsError,
  UnsupportedSignInChallengeError,
} from "../src/cognito-authenticator.js";

describe("Cognito account authentication", () => {
  it("returns Cognito's stable subject after a successful password flow", async () => {
    const send = vi.fn(async (command: GetUserCommand | InitiateAuthCommand) => {
      if (command instanceof InitiateAuthCommand) {
        return { AuthenticationResult: { AccessToken: "access-token" }, $metadata: {} };
      }
      return {
        Username: "family-owner",
        UserAttributes: [{ Name: "sub", Value: "account-uuid" }],
        $metadata: {},
      };
    });
    const authenticator = new CognitoAccountAuthenticator({
      clientId: "cognito-client",
      client: { send },
    });

    await expect(authenticator.authenticate(" owner@example.com ", "correct horse battery staple"))
      .resolves.toEqual({ accountId: "account-uuid", username: "family-owner" });
    const authCommand = send.mock.calls[0]?.[0];
    expect(authCommand).toBeInstanceOf(InitiateAuthCommand);
    if (!(authCommand instanceof InitiateAuthCommand)) throw new Error("Expected auth command");
    expect(authCommand.input.AuthParameters).toEqual({
      USERNAME: "owner@example.com",
      PASSWORD: "correct horse battery staple",
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetUserCommand);
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
