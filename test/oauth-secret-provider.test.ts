import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
  type PutSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { handler, provisionOAuthSecret } from "../infra/oauth-secret-provider.js";

type Output = GetSecretValueCommandOutput | PutSecretValueCommandOutput;

describe("OAuth secret provisioning", () => {
  it("does not treat Lambda's context argument as an AWS client", async () => {
    const send = vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({
      SecretString: '{"schemaVersion":1}', $metadata: {},
    } as never);
    try {
      await expect(Reflect.apply(handler, undefined, [
        { RequestType: "Create", ResourceProperties: { SecretId: "secret-arn" } },
        { awsRequestId: "lambda-request" },
      ])).resolves.toMatchObject({ Data: { Provisioned: "existing" } });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      send.mockRestore();
    }
  });
  it("creates private signing and client material without returning it to CloudFormation", async () => {
    const send = vi.fn(async (command: GetSecretValueCommand | PutSecretValueCommand): Promise<Output> => {
      if (command instanceof GetSecretValueCommand) {
        return { SecretString: '{"schemaVersion":0,"state":"pending-provisioning"}', $metadata: {} };
      }
      return { VersionId: "new-version", $metadata: {} };
    });

    const result = await provisionOAuthSecret({
      RequestType: "Create",
      ResourceProperties: { SecretId: "secret-arn" },
    }, { send });

    const put = send.mock.calls[1]?.[0];
    expect(put).toBeInstanceOf(PutSecretValueCommand);
    if (!(put instanceof PutSecretValueCommand)) throw new Error("Expected secret put");
    const material = JSON.parse(put.input.SecretString ?? "null") as Record<string, any>;
    expect(material).toMatchObject({
      schemaVersion: 1,
      jwks: { keys: [{ kty: "RSA", use: "sig", alg: "RS256" }] },
    });
    expect(material.jwks.keys[0].d.length).toBeGreaterThan(100);
    expect(material.cookieKeys).toHaveLength(2);
    expect(material.csrfSecret.length).toBeGreaterThanOrEqual(32);
    expect(material.serviceClient.clientSecret.length).toBeGreaterThanOrEqual(32);
    expect(material.userClient.clientSecret.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(result)).not.toContain(material.jwks.keys[0].d);
    expect(JSON.stringify(result)).not.toContain(material.serviceClient.clientSecret);
  });

  it("preserves an existing version-one secret during stack updates", async () => {
    const send = vi.fn(async (): Promise<Output> => ({
      SecretString: JSON.stringify({ schemaVersion: 1, material: "preserve-me" }),
      $metadata: {},
    }));

    const result = await provisionOAuthSecret({
      RequestType: "Update",
      PhysicalResourceId: "existing-id",
      ResourceProperties: { SecretId: "secret-arn" },
    }, { send });

    expect(send).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ PhysicalResourceId: "existing-id", Data: { Provisioned: "existing" } });
  });

  it("does not delete retained key material during stack deletion", async () => {
    const send = vi.fn();

    await expect(provisionOAuthSecret({
      RequestType: "Delete",
      PhysicalResourceId: "existing-id",
      ResourceProperties: { SecretId: "secret-arn" },
    }, { send })).resolves.toEqual({ PhysicalResourceId: "existing-id" });
    expect(send).not.toHaveBeenCalled();
  });
});
