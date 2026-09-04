import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createKinOAuthProvider } from "../src/oauth-provider.js";

const issuer = "https://auth.kin.example";
const resourceUri = "https://kin.execute-api.us-east-1.amazonaws.com/mcp";
const serviceClient = {
  clientId: "alexa-service-client",
  clientSecret: "service-client-secret-value",
};

describe("Kin OAuth provider contract", () => {
  let app: ReturnType<ReturnType<typeof createKinOAuthProvider>["callback"]>;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    publicKey = pair.publicKey;
    const privateJwk = await exportJWK(pair.privateKey);
    privateJwk.use = "sig";
    privateJwk.alg = "RS256";
    privateJwk.kid = "test-signing-key";
    const provider = createKinOAuthProvider({
      issuer,
      resourceUri,
      jwks: { keys: [privateJwk] },
      cookieKeys: ["a".repeat(32), "b".repeat(32)],
      adapter: class TestAdapter {},
      serviceClient,
    });
    app = provider.callback();
  });

  it("advertises only the grants, PKCE method, and scopes Alexa uses", async () => {
    const response = await request(app).get("/.well-known/oauth-authorization-server");

    expect(response.status).toBe(200);
    expect(response.body.issuer).toBe(issuer);
    expect(response.body.grant_types_supported).toEqual(expect.arrayContaining([
      "authorization_code",
      "client_credentials",
      "refresh_token",
    ]));
    expect(response.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(response.body.scopes_supported).toEqual(expect.arrayContaining([
      "mcp:service",
      "mcp:tools",
      "mcp:resources",
    ]));
  });

  it("issues a one-hour resource-bound service JWT", async () => {
    const response = await request(app)
      .post("/token")
      .auth(serviceClient.clientId, serviceClient.clientSecret)
      .type("form")
      .send({
        grant_type: "client_credentials",
        scope: "mcp:service",
        resource: resourceUri,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "mcp:service",
    });
    expect(response.body.refresh_token).toBeUndefined();
    const verified = await jwtVerify(response.body.access_token, publicKey, {
      issuer,
      audience: resourceUri,
      algorithms: ["RS256"],
    });
    expect(verified.payload.scope).toBe("mcp:service");
  });

  it("rejects a missing or foreign resource and user scopes on service credentials", async () => {
    const token = (input: Record<string, string>) => request(app)
      .post("/token")
      .auth(serviceClient.clientId, serviceClient.clientSecret)
      .type("form")
      .send({ grant_type: "client_credentials", ...input });

    const missing = await token({ scope: "mcp:service" });
    const foreign = await token({ scope: "mcp:service", resource: "https://attacker.example/mcp" });
    const elevated = await token({ scope: "mcp:tools", resource: resourceUri });

    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("invalid_target");
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("invalid_target");
    expect(elevated.status).toBe(400);
    expect(elevated.body.error).toBe("invalid_scope");
  });
});
