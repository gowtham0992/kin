import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStoryBedrockClient } from "../src/local-story-bedrock.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "kin-story-profile-test-"));
  directories.push(directory);
  const configFile = path.join(directory, "config"), credentialsFile = path.join(directory, "credentials");
  await writeFile(configFile, "", { flag: "wx" });
  await writeFile(credentialsFile, [
    "[synthetic-kin]", "aws_access_key_id=KIN_SYNTHETIC_ONLY", "aws_secret_access_key=synthetic-secret-only",
    "[default]", "aws_access_key_id=OTHER_SYNTHETIC_ONLY", "aws_secret_access_key=other-synthetic-secret-only",
  ].join("\n"), { flag: "wx" });
  vi.stubEnv("AWS_CONFIG_FILE", configFile);
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
  vi.stubEnv("AWS_PROFILE", "default");
  return directory;
}

describe("local story profile isolation", () => {
  it("resolves the exact selected profile rather than an ambient default", async () => {
    await fixture();
    const client = createLocalStoryBedrockClient({ profile: "synthetic-kin", region: "us-east-1" });
    try {
      expect((await client.config.credentials()).accessKeyId).toBe("KIN_SYNTHETIC_ONLY");
      expect(await client.config.region()).toBe("us-east-1");
      expect(await client.config.maxAttempts()).toBe(1);
    } finally { client.destroy(); }
  });

  it("fails on a missing profile without falling through to ambient web identity", async () => {
    const directory = await fixture();
    // A default-chain regression tries to read this absent token and fails with
    // ENOENT; this proves fallback without making a real STS or model request.
    vi.stubEnv("AWS_WEB_IDENTITY_TOKEN_FILE", path.join(directory, "must-not-read-ambient-token"));
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/unrelated-synthetic");
    const client = createLocalStoryBedrockClient({ profile: "missing-kin-profile", region: "us-east-1" });
    try {
      await expect(client.config.credentials()).rejects.toThrow("Could not resolve credentials using profile: [missing-kin-profile]");
    } finally { client.destroy(); }
  });

  it("signs with the profile even if ambient bearer settings appear after launch", async () => {
    await fixture();
    const client = createLocalStoryBedrockClient({ profile: "synthetic-kin", region: "us-east-1" });
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "ambient-synthetic-token");
    vi.stubEnv("AWS_AUTH_SCHEME_PREFERENCE", "httpBearerAuth");
    const authorizations: string[] = [];
    const handle = vi.fn(async request => {
      const entry = Object.entries(request.headers as Record<string, string>).find(([name]) => name.toLowerCase() === "authorization");
      authorizations.push(entry?.[1] ?? "");
      return { response: { statusCode: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({
        stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: '{"action":"today"}' }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 },
      })) } };
    });
    client.config.requestHandler.handle = handle;
    try {
      const response = await client.send(new ConverseCommand({ modelId: "amazon.nova-micro-v1:0", messages: [] }));
      expect(response.stopReason).toBe("end_turn");
      expect(authorizations).toHaveLength(1);
      expect(authorizations[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=KIN_SYNTHETIC_ONLY\//);
      expect(authorizations[0]).not.toContain("ambient-synthetic-token");
      await expect(client.config.token!()).rejects.toThrow("does not use bearer-token authentication");
    } finally { client.destroy(); }
  });
});
