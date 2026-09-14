import request from "supertest";
import { describe, expect, it } from "vitest";
import { AccessDeniedError, type AccessAuthorizer } from "../src/auth.js";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";

const denied: AccessAuthorizer = { async authorize(header) {
  throw new AccessDeniedError(header ? 403 : 401, header ? "insufficient_scope" : "invalid_token");
} };
const configuration: HttpAppOptions = {
  mcpAuthMode: "standard", canonicalMcpUri: "https://kin.example/mcp",
  authorizationServer: "https://kin.example", accessAuthorizer: denied, serveSimulator: false,
};
const app = (overrides: Partial<HttpAppOptions> = {}) => createHttpApp(createDemoStore(), undefined, { ...configuration, ...overrides });

describe("standard MCP OAuth discovery boundary", () => {
  it("publishes user-only scopes on both well-known paths, without trusting request hosts", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await request(app()).get(path).set("host", "attacker.example").set("x-forwarded-host", "attacker.example").expect(200);
      expect(response.body).toEqual({ resource: "https://kin.example/mcp", authorization_servers: ["https://kin.example"],
        bearer_methods_supported: ["header"], scopes_supported: ["mcp:tools", "mcp:resources"] });
    }
  });

  it("supplies a trusted user-scope challenge for initial connection", async () => {
    const response = await request(app()).post("/mcp").set("host", "attacker.example")
      .set("x-forwarded-host", "attacker.example").send({ jsonrpc: "2.0", id: 1, method: "initialize" }).expect(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer resource_metadata="https://kin.example/.well-known/oauth-protected-resource", scope="mcp:tools mcp:resources"');
    expect(response.body).toEqual({ error: "invalid_token" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it.each([["tools/call", "mcp:tools"], ["resources/read", "mcp:resources"]])(
    "advertises the required user scope for %s", async (method, scope) => {
      const response = await request(app()).post("/mcp").set("authorization", "Bearer synthetic")
        .send({ jsonrpc: "2.0", id: 2, method }).expect(403);
      expect(response.headers["www-authenticate"]).toBe(`Bearer resource_metadata="https://kin.example/.well-known/oauth-protected-resource", scope="${scope}", error="insufficient_scope"`);
    });

  it("does not suggest scope escalation for revoked or absent family membership", async () => {
    const accessAuthorizer: AccessAuthorizer = { async authorize() {
      return { subject: "synthetic-user", scopes: new Set(["mcp:tools"]), claims: {} };
    } };
    const response = await request(app({ accessAuthorizer })).post("/mcp").set("authorization", "Bearer synthetic")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" }).expect(403);
    expect(response.body).toEqual({ error: "family_access_denied" });
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("keeps Alexa metadata and its no-challenge contract available explicitly", async () => {
    const alexa = app({ mcpAuthMode: "alexa" });
    const metadata = await request(alexa).get("/.well-known/oauth-protected-resource").expect(200);
    expect(metadata.body.scopes_supported).toEqual(["mcp:service", "mcp:tools", "mcp:resources"]);
    const response = await request(alexa).post("/mcp").send({ method: "initialize" }).expect(401);
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it.each(["accessAuthorizer", "canonicalMcpUri", "authorizationServer"] as const)(
    "rejects standard mode without %s instead of silently serving an open demo", key => {
      expect(() => app({ [key]: undefined })).toThrow("Standard MCP auth requires");
    });

  it.each(["http://kin.example/mcp", "https://user:synthetic-password@kin.example/mcp", "https://kin.example/mcp#fragment",
    "https://kin.example/mcp#", "https://kin.example/mcp?",
    "https://kin.example/mcp?secret=synthetic", "https://kin.example/mcp\r\nInjected: value", 'https://kin.example/mcp"',
    "https://KIN.example/mcp", "https://kin.example:443/mcp"])("rejects unsafe or noncanonical metadata configuration %s", value => {
      expect(() => app({ canonicalMcpUri: value })).toThrow();
    });

  it.each([async () => "https://user:synthetic-password@kin.example/mcp", async () => { throw new Error("synthetic private resolver failure"); }])(
    "fails closed when dynamic resource resolution is unsafe or unavailable", async canonicalMcpUri => {
      const service = app({ canonicalMcpUri });
      const responses = [await request(service).get("/.well-known/oauth-protected-resource"),
        await request(service).post("/mcp").send({ method: "initialize" })];
      for (const response of responses) {
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: "Internal server error" });
        expect(response.headers["www-authenticate"]).toBeUndefined();
      }
    });
});
