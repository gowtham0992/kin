import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const alexaScopes = {
  service: "mcp:service",
  tools: "mcp:tools",
  resources: "mcp:resources",
} as const;

export type AlexaScope = (typeof alexaScopes)[keyof typeof alexaScopes];

export interface AccessPrincipal {
  subject: string;
  scopes: ReadonlySet<string>;
  claims: Readonly<JWTPayload>;
}

export interface AccessAuthorizer {
  authorize(authorizationHeader: string | undefined, requiredScopes: readonly AlexaScope[]): Promise<AccessPrincipal>;
}

export interface JwtAccessTokenConfig {
  issuer: string;
  audience: string;
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
  const audience = requireHttpsUrl(config.audience, "OAuth audience");
  const jwks = createRemoteJWKSet(new URL(requireHttpsUrl(config.jwksUri, "OAuth JWKS URI")));

  return {
    async authorize(authorizationHeader, requiredScopes) {
      const token = /^Bearer ([^\s]+)$/.exec(authorizationHeader ?? "")?.[1];
      if (!token) {
        throw new AccessDeniedError(401, "invalid_token");
      }

      let claims: JWTPayload;
      try {
        ({ payload: claims } = await jwtVerify(token, jwks, {
          issuer,
          audience,
          algorithms: ["RS256", "ES256"],
        }));
      } catch {
        throw new AccessDeniedError(401, "invalid_token");
      }

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
