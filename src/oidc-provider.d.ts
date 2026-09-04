declare module "oidc-provider" {
  import type { RequestListener } from "node:http";

  export interface OAuthProviderConfiguration {
    [key: string]: unknown;
  }

  export class Provider {
    constructor(issuer: string, configuration?: OAuthProviderConfiguration);
    callback(): RequestListener;
  }

  export const errors: {
    InvalidTarget: new (message?: string) => Error;
    InvalidScope: new (description?: string, scope?: string) => Error;
  };

  export default Provider;
}
