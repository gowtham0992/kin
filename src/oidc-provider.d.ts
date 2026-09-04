declare module "oidc-provider" {
  import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

  export interface OAuthProviderConfiguration {
    [key: string]: unknown;
  }

  export class Provider {
    constructor(issuer: string, configuration?: OAuthProviderConfiguration);
    callback(): RequestListener;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<InteractionDetails>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: Record<string, unknown>,
      options?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
    Grant: GrantConstructor;
  }

  export interface InteractionDetails {
    uid: string;
    prompt: {
      name: string;
      details: {
        missingOIDCScope?: string[];
        missingOIDCClaims?: string[];
        missingResourceScopes?: Record<string, string[]>;
      };
    };
    params: { client_id?: string; scope?: string; resource?: string };
    session?: { accountId?: string };
    grantId?: string;
  }

  export interface GrantInstance {
    addOIDCScope(scope: string): void;
    addOIDCClaims(claims: string[]): void;
    addResourceScope(resource: string, scope: string): void;
    save(): Promise<string>;
  }

  export interface GrantConstructor {
    new (input: { accountId: string; clientId: string }): GrantInstance;
    find(id: string): Promise<GrantInstance | undefined>;
  }

  export const errors: {
    InvalidTarget: new (message?: string) => Error;
    InvalidScope: new (description?: string, scope?: string) => Error;
  };

  export default Provider;
}
