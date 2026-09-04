import Provider, { errors } from "oidc-provider";
import { alexaScopes } from "./auth.js";

interface OAuthClientDefinition {
  clientId: string;
  clientSecret: string;
}

export interface AlexaUserOAuthClient extends OAuthClientDefinition {
  redirectUris: string[];
}

export interface KinOAuthProviderInput {
  issuer: string;
  resourceUri: string;
  jwks: { keys: Array<Record<string, unknown>> };
  cookieKeys: string[];
  adapter: (model: string) => object;
  serviceClient: OAuthClientDefinition;
  userClient?: AlexaUserOAuthClient;
  findAccount?: (accountId: string) => Promise<object | undefined>;
}

export function createKinOAuthProvider(input: KinOAuthProviderInput): Provider {
  const issuer = secureUrl(input.issuer, "OAuth issuer");
  const resourceUri = secureUrl(input.resourceUri, "MCP resource URI");
  if (input.cookieKeys.length < 2 || input.cookieKeys.some((key) => key.length < 32)) {
    throw new Error("At least two 32-character OAuth cookie keys are required");
  }
  if (input.jwks.keys.length === 0) throw new Error("OAuth signing keys are required");

  const serviceClientId = requiredSecret(input.serviceClient.clientId, "Service client ID");
  const clients: Array<Record<string, unknown>> = [{
    client_id: serviceClientId,
    client_secret: requiredSecret(input.serviceClient.clientSecret, "Service client secret"),
    grant_types: ["client_credentials"],
    response_types: [],
    token_endpoint_auth_method: "client_secret_basic",
  }];
  const userClientId = input.userClient?.clientId;
  if (input.userClient) {
    if (input.userClient.redirectUris.length === 0) {
      throw new Error("Alexa account-linking redirect URIs are required");
    }
    clients.push({
      client_id: requiredSecret(input.userClient.clientId, "User client ID"),
      client_secret: requiredSecret(input.userClient.clientSecret, "User client secret"),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: input.userClient.redirectUris.map((uri) => secureUrl(uri, "Alexa redirect URI")),
      token_endpoint_auth_method: "client_secret_basic",
    });
  }

  return new Provider(issuer, {
    adapter: input.adapter,
    clients,
    jwks: input.jwks,
    cookies: { keys: input.cookieKeys },
    claims: {},
    responseTypes: ["code"],
    scopes: Object.values(alexaScopes),
    pkce: { required: () => true },
    issueRefreshToken: (_context: unknown, client: { clientId: string }) =>
      client.clientId === userClientId,
    findAccount: async (_context: unknown, accountId: string) =>
      input.findAccount?.(accountId),
    ttl: {
      AccessToken: 3_600,
      AuthorizationCode: 60,
      ClientCredentials: 3_600,
      Grant: 30 * 24 * 60 * 60,
      Interaction: 10 * 60,
      RefreshToken: 30 * 24 * 60 * 60,
      Session: 30 * 24 * 60 * 60,
    },
    features: {
      clientCredentials: { enabled: true },
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_context: unknown, _client: unknown, oneOf?: string) => {
          if (!oneOf) throw new errors.InvalidTarget("resource is required");
          return oneOf;
        },
        useGrantedResource: () => true,
        getResourceServerInfo: (
          context: unknown,
          resourceIndicator: string,
          client: { clientId: string },
        ) => {
          if (resourceIndicator !== resourceUri) throw new errors.InvalidTarget();
          const params = (context as {
            oidc?: { params?: { grant_type?: unknown; scope?: unknown } };
          }).oidc?.params;
          const requestedScope = typeof params?.scope === "string" ? params.scope : "";
          const requestedScopes = requestedScope.split(/\s+/).filter(Boolean);
          if (
            client.clientId === serviceClientId &&
            (requestedScopes.length !== 1 || requestedScopes[0] !== alexaScopes.service)
          ) {
            throw new errors.InvalidScope(
              "service credentials may request only mcp:service",
              requestedScope,
            );
          }
          if (
            client.clientId !== serviceClientId &&
            params?.grant_type !== "refresh_token" &&
            (requestedScopes.length === 0 || requestedScopes.includes(alexaScopes.service))
          ) {
            throw new errors.InvalidScope(
              "user authorization requires user-level MCP scopes",
              requestedScope,
            );
          }
          return {
            audience: resourceUri,
            accessTokenFormat: "jwt",
            accessTokenTTL: 3_600,
            scope: client.clientId === serviceClientId
              ? alexaScopes.service
              : `${alexaScopes.tools} ${alexaScopes.resources}`,
          };
        },
      },
      revocation: { enabled: true },
    },
  });
}

function secureUrl(value: string, name: string) {
  const trimmed = value.trim();
  const url = new URL(trimmed);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return trimmed;
}

function requiredSecret(value: string, name: string) {
  const trimmed = value.trim();
  if (trimmed.length < 16) throw new Error(`${name} must be at least 16 characters`);
  return trimmed;
}
