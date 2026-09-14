import Provider, { errors } from "oidc-provider";
import { alexaScopes } from "./auth.js";
import { browserAuthConfig } from "./browser-auth-config.js";

interface OAuthClientDefinition {
  clientId: string;
  clientSecret: string;
}

export interface AlexaUserOAuthClient extends OAuthClientDefinition {
  redirectUris: string[];
}

export interface OAuthAccountLookup {
  authTime: unknown;
  source: "session" | "grant";
  invalidateSession?: () => Promise<void>;
}

export interface KinOAuthProviderInput {
  issuer: string;
  resourceUri: string;
  jwks: { keys: Array<Record<string, unknown>> };
  cookieKeys: string[];
  adapter: new (model: string) => object;
  serviceClient: OAuthClientDefinition;
  userClient?: AlexaUserOAuthClient;
  echoClient?: AlexaUserOAuthClient;
  browserClient?: { clientId: string; redirectUri: string };
  findAccount?: (accountId: string, lookup: OAuthAccountLookup) => Promise<object | undefined>;
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
  const userClientId = input.userClient ? requiredSecret(input.userClient.clientId, "User client ID") : undefined;
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

  const echoClientId = input.echoClient ? requiredSecret(input.echoClient.clientId, "Echo client ID") : undefined;
  if (input.echoClient) {
    if (input.echoClient.redirectUris.length === 0) throw new Error("Echo account-linking redirect URIs are required");
    clients.push({
      client_id: echoClientId,
      client_secret: requiredSecret(input.echoClient.clientSecret, "Echo client secret"),
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      redirect_uris: input.echoClient.redirectUris.map(echoRedirectUri),
      token_endpoint_auth_method: "client_secret_basic",
    });
  }

  if (input.browserClient) {
    const browser = browserAuthConfig({ ...input.browserClient, issuer, resource: resourceUri });
    if ([serviceClientId, userClientId, echoClientId].includes(browser.clientId)) throw new Error("Browser client must have a separate identity");
    clients.push({ client_id: browser.clientId, grant_types: ["authorization_code"], response_types: ["code"],
      redirect_uris: [browser.redirectUri], token_endpoint_auth_method: "none" });
  }
  if (new Set(clients.map(client => client.client_id)).size !== clients.length) {
    throw new Error("Each OAuth client must have a separate identity");
  }

  const provider = new Provider(issuer, {
    adapter: input.adapter,
    clients,
    jwks: input.jwks,
    cookies: { keys: input.cookieKeys },
    claims: {},
    responseTypes: ["code"],
    scopes: Object.values(alexaScopes),
    pkce: { required: () => true },
    issueRefreshToken: (_context: unknown, client: { clientId: string }) =>
      client.clientId === userClientId || client.clientId === echoClientId,
    findAccount: async (context: unknown, accountId: string, token?: { authTime?: unknown }) => {
      const session = (context as { oidc?: { session?: { authTime(): unknown; destroy(): Promise<void> } } }).oidc?.session;
      return input.findAccount?.(accountId, token ? {
        source: "grant", authTime: token.authTime,
      } : {
        source: "session", authTime: session?.authTime(),
        invalidateSession: session ? () => session.destroy() : undefined,
      });
    },
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
        defaultResource: (_context: unknown, client: { clientId: string }, oneOf?: string | readonly string[]) => {
          // Classic ASK does not send RFC 8707's resource parameter. Keep this
          // compatibility default scoped to its separately authenticated client.
          if (!oneOf && echoClientId && client.clientId === echoClientId) return resourceUri;
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
          if (echoClientId && client.clientId === echoClientId && (
            requestedScopes.some(scope => scope !== alexaScopes.tools) ||
            (params?.grant_type === undefined && requestedScopes.length === 0)
          )) {
            throw new errors.InvalidScope("Echo authorization permits only mcp:tools", requestedScope);
          }
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
            (
              requestedScopes.includes(alexaScopes.service) ||
              (params?.grant_type === undefined && requestedScopes.length === 0)
            )
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
              : client.clientId === echoClientId ? alexaScopes.tools
              : `${alexaScopes.tools} ${alexaScopes.resources}`,
          };
        },
      },
      revocation: { enabled: true },
    },
    interactions: {
      url: (_context: unknown, interaction: { uid: string }) =>
        `/interaction/${encodeURIComponent(interaction.uid)}`,
    },
  });
  provider.proxy = true;
  return provider;
}

function echoRedirectUri(value: string) {
  const uri = secureUrl(value, "Echo redirect URI");
  const url = new URL(uri);
  if (url.username || url.password || url.hash || uri.includes("*") || url.href !== uri) {
    throw new Error("Echo redirect URI must be an exact canonical HTTPS URL without credentials, fragment or wildcard");
  }
  return uri;
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
