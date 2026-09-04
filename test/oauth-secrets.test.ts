import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { loadOAuthSecrets } from "../src/oauth-secrets.js";

const validSecret = {
  schemaVersion: 1,
  jwks: { keys: [{ kty: "RSA", n: "public", e: "AQAB", d: "private", kid: "key-1", use: "sig", alg: "RS256" }] },
  cookieKeys: ["a".repeat(32), "b".repeat(32)],
  csrfSecret: "c".repeat(32),
  serviceClient: { clientId: "kin-service-client", clientSecret: "d".repeat(32) },
  userClient: { clientId: "kin-alexa-client-1", clientSecret: "e".repeat(32) },
};

describe("OAuth secret loading", () => {
  it("loads and validates the versioned secret from Secrets Manager", async () => {
    const send = vi.fn(async (_command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput> => ({
      SecretString: JSON.stringify(validSecret),
      $metadata: {},
    }));

    await expect(loadOAuthSecrets({ secretId: "kin/oauth/configuration", client: { send } }))
      .resolves.toEqual(validSecret);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetSecretValueCommand);
  });

  it("rejects malformed JSON and incomplete key material without leaking it", async () => {
    const malformed = vi.fn(async (): Promise<GetSecretValueCommandOutput> => ({
      SecretString: "{private material",
      $metadata: {},
    }));
    const incomplete = vi.fn(async (): Promise<GetSecretValueCommandOutput> => ({
      SecretString: JSON.stringify({ ...validSecret, csrfSecret: "short" }),
      $metadata: {},
    }));

    await expect(loadOAuthSecrets({ secretId: "secret", client: { send: malformed } }))
      .rejects.toThrow("not valid JSON");
    await expect(loadOAuthSecrets({ secretId: "secret", client: { send: incomplete } }))
      .rejects.toThrow("does not match schema");
  });
});
