import { describe, expect, it } from "vitest";
import {
  alexaScopes,
  createJwtAccessAuthorizer,
  requiredScopesForMcpRequest,
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
