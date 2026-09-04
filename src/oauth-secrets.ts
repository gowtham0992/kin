import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

interface SecretSender {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
}

const clientSchema = z.object({
  clientId: z.string().min(16),
  clientSecret: z.string().min(32),
}).strict();

const oauthSecretsSchema = z.object({
  schemaVersion: z.literal(1),
  jwks: z.object({
    keys: z.array(z.object({
      kty: z.string().min(1),
      kid: z.string().min(1),
      use: z.literal("sig"),
      alg: z.literal("RS256"),
    }).loose()).min(1),
  }).strict(),
  cookieKeys: z.array(z.string().min(32)).min(2),
  csrfSecret: z.string().min(32),
  serviceClient: clientSchema,
  userClient: clientSchema,
}).strict();

export type OAuthSecrets = z.infer<typeof oauthSecretsSchema>;

export async function loadOAuthSecrets(input: {
  secretId: string;
  region?: string;
  client?: SecretSender;
}): Promise<OAuthSecrets> {
  const secretId = input.secretId.trim();
  if (!secretId) throw new Error("OAuth secret ID is required");
  const client = input.client ?? new SecretsManagerClient({ region: input.region });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!response.SecretString) throw new Error("OAuth secret has no string value");
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    throw new Error("OAuth secret is not valid JSON");
  }
  const result = oauthSecretsSchema.safeParse(parsed);
  if (!result.success) throw new Error("OAuth secret does not match schema version 1");
  return result.data;
}
