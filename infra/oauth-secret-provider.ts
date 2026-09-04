import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
  type PutSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";

type SecretCommand = GetSecretValueCommand | PutSecretValueCommand;
interface SecretSender {
  send(command: SecretCommand): Promise<GetSecretValueCommandOutput | PutSecretValueCommandOutput>;
}

interface ProvisionEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: { SecretId?: unknown };
}

export async function provisionOAuthSecret(
  event: ProvisionEvent,
  client: SecretSender = new SecretsManagerClient({}),
) {
  const secretId = typeof event.ResourceProperties.SecretId === "string"
    ? event.ResourceProperties.SecretId.trim()
    : "";
  if (!secretId) throw new Error("SecretId is required");
  const physicalResourceId = event.PhysicalResourceId ?? `kin-oauth-secret:${secretId}`;
  if (event.RequestType === "Delete") return { PhysicalResourceId: physicalResourceId };

  let existing: string | undefined;
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    existing = (response as GetSecretValueCommandOutput).SecretString;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") throw error;
  }
  if (existing) {
    let parsed: { schemaVersion?: unknown };
    try {
      parsed = JSON.parse(existing) as { schemaVersion?: unknown };
    } catch {
      throw new Error("Existing OAuth secret is not valid JSON; refusing to overwrite it");
    }
    if (parsed.schemaVersion !== 1) {
      throw new Error("Existing OAuth secret has an unknown schema; refusing to overwrite it");
    }
    return { PhysicalResourceId: physicalResourceId, Data: { Provisioned: "existing" } };
  }

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const jwk = privateKey.export({ format: "jwk" });
  const value = {
    schemaVersion: 1,
    jwks: {
      keys: [{
        ...jwk,
        kid: `kin-${randomValue(12)}`,
        use: "sig",
        alg: "RS256",
      }],
    },
    cookieKeys: [randomValue(48), randomValue(48)],
    csrfSecret: randomValue(48),
    serviceClient: credentials("service"),
    userClient: credentials("alexa"),
  };
  await client.send(new PutSecretValueCommand({
    SecretId: secretId,
    SecretString: JSON.stringify(value),
  }));
  return { PhysicalResourceId: physicalResourceId, Data: { Provisioned: "new" } };
}

export const handler = provisionOAuthSecret;

function credentials(kind: string) {
  return {
    clientId: `kin-${kind}-${randomValue(12)}`,
    clientSecret: randomValue(48),
  };
}

function randomValue(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}
