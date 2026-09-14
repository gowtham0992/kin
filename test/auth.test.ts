import { describe, expect, it, vi } from "vitest";
import {
  alexaScopes,
  createJwtAccessAuthorizer,
  requiredScopesForMcpRequest,
  AccessDeniedError,
  authorizeMcpRequest,
  isMcpDiscoveryRequest,
  parseMcpAuthMode,
  standardMcpChallenge,
} from "../src/auth.js";

describe("Alexa MCP authorization policy", () => {
  it.each([
    ["initialize", alexaScopes.service],
    ["notifications/initialized", alexaScopes.service],
    ["tools/list", alexaScopes.service],
    ["tools/call", alexaScopes.tools],
    ["resources/list", alexaScopes.resources],
    ["resources/read", alexaScopes.resources],
  ])("maps %s to %s", (method, scope) => {
    expect(requiredScopesForMcpRequest({ method })).toEqual([scope]);
  });

  it("requires every access tier represented in a batch", () => {
    expect(requiredScopesForMcpRequest([
      { method: "tools/list" },
      { method: "tools/call" },
      { method: "resources/read" },
    ])).toEqual([
      alexaScopes.service,
      alexaScopes.tools,
      alexaScopes.resources,
    ]);
  });

  it("refuses non-HTTPS token infrastructure", () => {
    expect(() => createJwtAccessAuthorizer({
      issuer: "http://auth.kin.example",
      audience: "https://api.kin.example/mcp",
      jwksUri: "https://auth.kin.example/.well-known/jwks.json",
    })).toThrow("OAuth issuer must use HTTPS");
  });
});

describe("MCP user and service discovery", () => {
  const methods = ["initialize", "notifications/initialized", "ping", "tools/list"];
  it.each(Object.values(alexaScopes))("allows verified %s metadata without requiring another scope", async scope => {
    const principal = { subject: "synthetic-account", scopes: new Set([scope]), claims: {} };
    const authorize = vi.fn(async () => principal);
    for (const method of methods) {
      expect(await authorizeMcpRequest({ authorize }, "Bearer synthetic-token", { method })).toBe(principal);
    }
    expect(authorize.mock.calls).toEqual(methods.map(() => ["Bearer synthetic-token", []]));
  });

  it.each([{ scopes: [] }, { scopes: ["openid"] }, { scopes: ["mcp:tools-extra"] }])("rejects signed metadata tokens with unrecognized scopes $scopes", async ({ scopes }) => {
    for (const method of methods) {
      await expect(authorizeMcpRequest({ async authorize() {
        return { subject: "synthetic-account", scopes: new Set(scopes), claims: {} };
      } }, "Bearer synthetic-token", { method })).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
    }
  });

  it("never falls back after token verification fails", async () => {
    const authorize = vi.fn(async () => { throw new AccessDeniedError(401, "invalid_token"); });
    await expect(authorizeMcpRequest({ authorize }, "Bearer invalid", { method: "initialize" }))
      .rejects.toMatchObject({ status: 401, code: "invalid_token" });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], [{ method: "initialize" }], { method: ["initialize"] }, { method: {} },
    { method: "Initialize" }, { method: "tools/list/extra" }, { method: "unknown" }, { method: "tools/call" }].map(body => ({ body })))(
    "does not grant metadata permission to malformed or other requests $body", ({ body }) => {
      expect(isMcpDiscoveryRequest(body)).toBe(false);
    });

  it("preserves the distinct operation scopes", async () => {
    const authorize = vi.fn(async () => ({ subject: "synthetic-account", scopes: new Set<string>(), claims: {} }));
    await authorizeMcpRequest({ authorize }, "Bearer synthetic-token", { method: "tools/call" });
    await authorizeMcpRequest({ authorize }, "Bearer synthetic-token", { method: "resources/read" });
    expect(authorize.mock.calls).toEqual([
      ["Bearer synthetic-token", [alexaScopes.tools]], ["Bearer synthetic-token", [alexaScopes.resources]],
    ]);
  });

  it("keeps Alexa the default and rejects invalid mode configuration", () => {
    expect(parseMcpAuthMode(undefined)).toBe("alexa");
    expect(parseMcpAuthMode("standard")).toBe("standard");
    for (const value of ["", "Standard", " standard ", "disabled"]) expect(() => parseMcpAuthMode(value)).toThrow("KIN_MCP_AUTH_MODE");
  });

  it("advertises user scopes for connection and only the relevant operation scope for escalation", () => {
    expect(standardMcpChallenge("https://kin.example/mcp", { method: "initialize" }))
      .toBe('Bearer resource_metadata="https://kin.example/.well-known/oauth-protected-resource", scope="mcp:tools mcp:resources"');
    expect(standardMcpChallenge("https://kin.example/mcp", { method: "tools/call" }, "insufficient_scope"))
      .toBe('Bearer resource_metadata="https://kin.example/.well-known/oauth-protected-resource", scope="mcp:tools", error="insufficient_scope"');
    expect(standardMcpChallenge("https://kin.example/mcp", { method: "resources/read" }, "insufficient_scope"))
      .toContain('scope="mcp:resources"');
  });
});
