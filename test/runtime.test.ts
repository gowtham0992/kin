import { describe, expect, it } from "vitest";
import request from "supertest";
import { createConfiguredApp } from "../src/runtime.js";

describe("Kin runtime configuration", () => {
  it("keeps browser sign-in disabled by default and refuses incomplete configuration", async () => {
    await request(createConfiguredApp({})).get("/family-auth-config").expect(404);
    expect(() => createConfiguredApp({ KIN_BROWSER_AUTH_ENABLED: "true" })).toThrow("Browser sign-in requires");
  });
  it("publishes only public browser configuration behind the existing surface gate", async () => {
    const environment = { KIN_BROWSER_AUTH_ENABLED: "true", KIN_BROWSER_CLIENT_ID: "kin-family-browser",
      KIN_BROWSER_REDIRECT_URI: "https://kin.example/invite.html", KIN_OAUTH_ISSUER: "https://kin.example",
      KIN_OAUTH_JWKS_URI: "https://kin.example/jwks", KIN_MCP_CANONICAL_URI: "https://kin.example/mcp",
      KIN_DYNAMODB_TABLE: "synthetic-test", KIN_SERVE_SIMULATOR: "true" };
    const response = await request(createConfiguredApp(environment)).get("/family-auth-config").expect(200);
    expect(response.body).toEqual({ clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" });
    expect(response.headers["cache-control"]).toBe("no-store");
    await request(createConfiguredApp({ ...environment, KIN_SERVE_SIMULATOR: "false" })).get("/family-auth-config").expect(404);
  });
  it("keeps zero-credential local development available", () => {
    expect(createConfiguredApp({}, { requireOAuth: false })).toBeDefined();
  });

  it("serves only a deliberate 503 while the public rollout gate is closed", async () => {
    const app = createConfiguredApp({ KIN_PUBLIC_API_ENABLED: "false" }, { requireOAuth: true });
    const response = await request(app).get("/health").expect(503);

    expect(response.body).toEqual({ error: "Kin's public API is temporarily unavailable" });
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("fails closed when a public runtime has no OAuth configuration", () => {
    expect(() => createConfiguredApp({}, { requireOAuth: true })).toThrow(
      "OAuth configuration is required on the public Kin runtime",
    );
  });

  it("rejects partially configured OAuth", () => {
    expect(() => createConfiguredApp({
      KIN_MCP_CANONICAL_URI: "https://api.kin.example/mcp",
    })).toThrow("must be configured together");
  });

  it("rejects two competing canonical resource sources", () => {
    expect(() => createConfiguredApp({
      KIN_MCP_CANONICAL_URI: "https://api.kin.example/mcp",
      KIN_MCP_RESOURCE_PARAMETER: "/kin/mcp/canonical-uri",
    })).toThrow("not both");
  });
});
