import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";

export interface CurrentAccountStatus {
  accountId: string;
  /** Cognito's current account-change timestamp, in epoch milliseconds. */
  modifiedAt: number;
}

export interface AccountStatusDirectory {
  find(accountId: string): Promise<CurrentAccountStatus | undefined>;
}

interface AccountStatusSender {
  send(command: AdminGetUserCommand, options: { abortSignal: AbortSignal }): Promise<AdminGetUserCommandOutput>;
}

/** No authority cache: each issuance checks the upstream account afresh. */
export class CognitoAccountStatusDirectory implements AccountStatusDirectory {
  readonly #client: AccountStatusSender;
  readonly #userPoolId: string;

  constructor(input: { userPoolId: string; region?: string; client?: AccountStatusSender }) {
    this.#userPoolId = input.userPoolId.trim();
    if (!this.#userPoolId) throw new Error("Cognito user pool ID is required");
    this.#client = input.client ?? new CognitoIdentityProviderClient({ region: input.region, maxAttempts: 1 });
  }

  async find(accountId: string): Promise<CurrentAccountStatus | undefined> {
    if (!accountId.trim() || accountId.length > 128) return undefined;
    let account: AdminGetUserCommandOutput;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        reject(new Error("Current account status unavailable"));
      }, 3_000);
      deadline.unref();
    });
    try {
      account = await Promise.race([
        this.#client.send(new AdminGetUserCommand({
          UserPoolId: this.#userPoolId, Username: accountId,
        }), { abortSignal: controller.signal }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof Error && error.name === "UserNotFoundException") return undefined;
      throw error;
    } finally {
      clearTimeout(deadline!);
    }
    const subject = account.UserAttributes?.find(attribute => attribute.Name === "sub")?.Value;
    const modifiedAt = account.UserLastModifiedDate?.getTime();
    if (account.Enabled !== true || account.UserStatus !== "CONFIRMED" || subject !== accountId ||
      typeof modifiedAt !== "number" || !Number.isFinite(modifiedAt) || modifiedAt <= 0) return undefined;
    return { accountId, modifiedAt };
  }
}
