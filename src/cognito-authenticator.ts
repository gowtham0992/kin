import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  type GetUserCommandOutput,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";

type CognitoCommand = GetUserCommand | InitiateAuthCommand;

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

export class CognitoAccountAuthenticator {
  readonly #client: CognitoSender;
  readonly #clientId: string;

  constructor(input: { clientId: string; region?: string; client?: CognitoSender }) {
    this.#clientId = input.clientId.trim();
    if (!this.#clientId) throw new Error("Cognito app client ID is required");
    this.#client = input.client ?? new CognitoIdentityProviderClient({ region: input.region });
  }

  async authenticate(usernameInput: string, password: string): Promise<AuthenticatedAccount> {
    const username = usernameInput.trim();
    if (username.length < 3 || username.length > 320 || password.length < 8 || password.length > 1_024) {
      throw new InvalidCredentialsError();
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
