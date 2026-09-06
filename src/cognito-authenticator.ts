import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type GetUserCommandOutput,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";

type CognitoCommand = GetUserCommand | InitiateAuthCommand | RespondToAuthChallengeCommand;

interface CognitoSender {
  send(command: CognitoCommand): Promise<GetUserCommandOutput | InitiateAuthCommandOutput>;
}

export interface AuthenticatedAccount {
  accountId: string;
  username: string;
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Sign-in was not accepted");
    this.name = "InvalidCredentialsError";
  }
}

export class UnsupportedSignInChallengeError extends Error {
  constructor(readonly challengeName: string) {
    super("This account requires an additional sign-in step");
    this.name = "UnsupportedSignInChallengeError";
  }
}

export class NewPasswordRequiredError extends Error {
  constructor() { super("Choose your own password"); }
}
export class NewPasswordRejectedError extends Error {
  constructor() { super("Choose a different password meeting the requirements"); }
}

export class CognitoAccountAuthenticator {
  readonly #client: CognitoSender;
  readonly #clientId: string;

  constructor(input: { clientId: string; region?: string; client?: CognitoSender }) {
    this.#clientId = input.clientId.trim();
    if (!this.#clientId) throw new Error("Cognito app client ID is required");
    this.#client = input.client ?? new CognitoIdentityProviderClient({ region: input.region });
  }

  async authenticate(usernameInput: string, password: string, newPassword?: string): Promise<AuthenticatedAccount> {
    const username = usernameInput.trim();
    if (username.length < 3 || username.length > 320 || password.length < 8 || password.length > 1_024) {
      throw new InvalidCredentialsError();
    }
    if (newPassword !== undefined && (newPassword.length < 12 || newPassword.length > 256 || /\s/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9\s]/.test(newPassword) || newPassword === password)) {
      throw new NewPasswordRejectedError();
    }

    let auth: InitiateAuthCommandOutput;
    try {
      auth = await this.#client.send(new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: this.#clientId,
        AuthParameters: { USERNAME: username, PASSWORD: password },
      })) as InitiateAuthCommandOutput;
    } catch (error) {
      if (isCredentialFailure(error)) throw new InvalidCredentialsError();
      throw error;
    }

    if (auth.ChallengeName === "NEW_PASSWORD_REQUIRED") {
      if (!newPassword) throw new NewPasswordRequiredError();
      const required = auth.ChallengeParameters?.requiredAttributes;
      if (!auth.Session || (required !== undefined && required !== "[]")) throw new UnsupportedSignInChallengeError("NEW_PASSWORD_REQUIRED_ATTRIBUTES");
      try {
        auth = await this.#client.send(new RespondToAuthChallengeCommand({
          ClientId: this.#clientId, ChallengeName: "NEW_PASSWORD_REQUIRED", Session: auth.Session,
          ChallengeResponses: { USERNAME: auth.ChallengeParameters?.USER_ID_FOR_SRP ?? auth.ChallengeParameters?.USERNAME ?? username, NEW_PASSWORD: newPassword },
        })) as InitiateAuthCommandOutput;
      } catch (error) {
        if (error instanceof Error && ["InvalidPasswordException", "PasswordHistoryPolicyViolationException"].includes(error.name)) throw new NewPasswordRejectedError();
        if (isCredentialFailure(error)) throw new InvalidCredentialsError();
        throw error;
      }
    }
    if (auth.ChallengeName) throw new UnsupportedSignInChallengeError(auth.ChallengeName);
    const accessToken = auth.AuthenticationResult?.AccessToken;
    if (!accessToken) throw new InvalidCredentialsError();

    const identityPromise = this.#client.send(
      new GetUserCommand({ AccessToken: accessToken }),
    ) as Promise<GetUserCommandOutput>;
    const identity = await identityPromise;
    const accountId = identity.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
    if (!accountId || !identity.Username) {
      throw new Error("Cognito returned an authenticated user without a stable identity");
    }
    return { accountId, username: identity.Username };
  }
}

function isCredentialFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  return new Set([
    "NotAuthorizedException",
    "PasswordResetRequiredException",
    "UserNotConfirmedException",
    "UserNotFoundException",
  ]).has(error.name);
}
