import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { startMcpTiming, type McpInitializeTiming } from "./mcp-initialize-timing.js";

export const alexaScopes = {
  service: "mcp:service",
  tools: "mcp:tools",
  resources: "mcp:resources",
} as const;

export type AlexaScope = (typeof alexaScopes)[keyof typeof alexaScopes];
export type McpAuthMode = "alexa" | "standard";

export function parseMcpAuthMode(value: string | undefined): McpAuthMode {
  if (value === undefined) return "alexa";
  if (value === "alexa" || value === "standard") return value;
  throw new Error("KIN_MCP_AUTH_MODE must be alexa or standard");
}

export interface AccessPrincipal {
  subject: string;
  scopes: ReadonlySet<string>;
  claims: Readonly<JWTPayload>;
}

export interface AccessAuthorizer {
  authorize(authorizationHeader: string | undefined, requiredScopes: readonly AlexaScope[], timing?: McpInitializeTiming): Promise<AccessPrincipal>;
}

export interface JwtAccessTokenConfig {
  issuer: string;
  audience: string | (() => Promise<string>);
  jwksUri: string;
}

export class AccessDeniedError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "invalid_token" | "insufficient_scope",
  ) {
    super(code);
    this.name = "AccessDeniedError";
  }
}

function requireHttpsUrl(value: string, name: string): string {
  const normalized = value.trim();
  const url = new URL(normalized);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return normalized;
}

export function createJwtAccessAuthorizer(config: JwtAccessTokenConfig): AccessAuthorizer {
  const issuer = requireHttpsUrl(config.issuer, "OAuth issuer");
  let audiencePromise: Promise<string> | undefined;
  const configuredAudience = config.audience;
  const audience = typeof configuredAudience === "string"
    ? async () => requireHttpsUrl(configuredAudience, "OAuth audience")
    : async () => {
        audiencePromise ??= configuredAudience()
          .then((value) => requireHttpsUrl(value, "OAuth audience"))
          .catch((error) => {
            audiencePromise = undefined;
            throw error;
          });
        return audiencePromise;
      };
  const jwks = createRemoteJWKSet(new URL(requireHttpsUrl(config.jwksUri, "OAuth JWKS URI")));

  return {
    async authorize(authorizationHeader, requiredScopes, timing) {
      const token = /^Bearer ([^\s]+)$/.exec(authorizationHeader ?? "")?.[1];
      if (!token) {
        throw new AccessDeniedError(401, "invalid_token");
      }

      let claims: JWTPayload;
      let expectedAudience: string;
      const endAudience = startMcpTiming(timing, "audience");
      try { expectedAudience = await audience(); } finally { endAudience(); }
      const endJwt = startMcpTiming(timing, "jwt");
      try {
        ({ payload: claims } = await jwtVerify(token, timing ? async (header, token) => {
          const endJwks = startMcpTiming(timing, "jwks");
          try { return await jwks(header, token); } finally { endJwks(); }
        } : jwks, {
          issuer,
          audience: expectedAudience,
          algorithms: ["RS256", "ES256"],
        }));
      } catch {
        throw new AccessDeniedError(401, "invalid_token");
      } finally { endJwt(); }

      const subject = typeof claims.sub === "string" ? claims.sub : undefined;
      const scopes = new Set(
        typeof claims.scope === "string"
          ? claims.scope.split(/\s+/).filter(Boolean)
          : [],
      );
      if (!subject) {
        throw new AccessDeniedError(401, "invalid_token");
      }
      if (!requiredScopes.every((scope) => scopes.has(scope))) {
        throw new AccessDeniedError(403, "insufficient_scope");
      }

      return { subject, scopes, claims };
    },
  };
}

export function requiredScopesForMcpRequest(body: unknown): AlexaScope[] {
  const requests = Array.isArray(body) ? body : [body];
  const required = new Set<AlexaScope>();

  for (const request of requests) {
    const method =
      typeof request === "object" && request !== null && "method" in request
        ? (request as { method?: unknown }).method
        : undefined;

    if (method === "tools/call") {
      required.add(alexaScopes.tools);
    } else if (
      method === "resources/list" ||
      method === "resources/read" ||
      method === "resources/templates/list" ||
      method === "resources/subscribe" ||
      method === "resources/unsubscribe"
    ) {
      required.add(alexaScopes.resources);
    } else {
      required.add(alexaScopes.service);
    }
  }

  return [...required];
}

// Only these methods contain protocol/static tool metadata, never family state.
export function isMcpDiscoveryRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" &&
    ["initialize", "notifications/initialized", "ping", "tools/list"].includes(method);
}

export function hasMcpUserScope(principal: AccessPrincipal): boolean {
  return principal.scopes.has(alexaScopes.tools) || principal.scopes.has(alexaScopes.resources);
}

export async function authorizeMcpRequest(
  authorizer: AccessAuthorizer, header: string | undefined, body: unknown,
  timing?: McpInitializeTiming,
): Promise<AccessPrincipal> {
  if (!isMcpDiscoveryRequest(body)) {
    return authorizer.authorize(header, requiredScopesForMcpRequest(body));
  }
  // Verify the signature, issuer, audience, expiry and subject once, then check
  // this explicit OR policy. An arbitrary signed token is not MCP permission.
  const principal = await (timing ? authorizer.authorize(header, [], timing) : authorizer.authorize(header, []));
  if (!principal.scopes.has(alexaScopes.service) && !hasMcpUserScope(principal)) {
    throw new AccessDeniedError(403, "insufficient_scope");
  }
  return principal;
}

export function standardMcpResource(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || value.includes("#") || value.includes("?") ||
      /[\s\u0000-\u001f\u007f"\\]/.test(value) || (url.href !== value && url.origin !== value)) {
    throw new Error("Standard MCP resource must be a canonical HTTPS URL without credentials, query or fragment");
  }
  return value;
}

export function standardMcpChallenge(resource: string, body: unknown, error?: AccessDeniedError["code"]): string {
  const metadata = new URL("/.well-known/oauth-protected-resource", standardMcpResource(resource));
  const operationScopes = requiredScopesForMcpRequest(body).filter(scope => scope !== alexaScopes.service);
  const scopes = operationScopes.length ? operationScopes : [alexaScopes.tools, alexaScopes.resources];
  return `Bearer resource_metadata="${metadata.href}", scope="${scopes.join(" ")}"${error ? `, error="${error}"` : ""}`;
}
