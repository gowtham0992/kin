import { GetSecretValueCommand, PutSecretValueCommand, UpdateSecretVersionStageCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import {
  EchoOAuthProvisioningError, inspectEchoOAuthClient, provisionEchoOAuthClient,
  type EchoOAuthSecretCommand, type EchoOAuthSecretSender,
} from "../src/echo-oauth-provisioning.js";

const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:kin/oauth/configuration-AbCd12";
const previous = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
const concurrent = "33333333-3333-4333-8333-333333333333";
const credentials = { clientId: "kin-echo-synthetic-client", clientSecret: "synthetic-echo-secret-".repeat(3) };
const original = {
  schemaVersion: 1,
  jwks: { keys: [{ kty: "RSA", n: "synthetic-modulus", e: "AQAB", d: "synthetic-private-key", kid: "synthetic-key",
    use: "sig", alg: "RS256", retainedExtension: { nested: ["one", "two"] } }] },
  cookieKeys: ["synthetic-cookie-first-".repeat(3), "synthetic-cookie-second-".repeat(3)],
  csrfSecret: "synthetic-csrf-secret-".repeat(3),
  serviceClient: { clientId: "kin-service-synthetic-client", clientSecret: "synthetic-service-secret-".repeat(3) },
  userClient: { clientId: "kin-alexa-synthetic-client", clientSecret: "synthetic-alexa-secret-".repeat(3) },
};

type Output = Awaited<ReturnType<EchoOAuthSecretSender["send"]>>;
type Fault = (command: EchoOAuthSecretCommand, output: Output) => Output | void;
function fixture(secret = JSON.stringify(original), fault?: Fault) {
  const versions = new Map([[previous, { value: secret, stages: ["AWSCURRENT", "retained-label"] }]]);
  const calls: EchoOAuthSecretCommand[] = [];
  const client: EchoOAuthSecretSender = {
    async send(command) {
      calls.push(command);
      if (command.input.SecretId !== secretArn) throw new Error("Synthetic wrong secret");
      let output: Output;
      if (command instanceof GetSecretValueCommand) {
        const version = command.input.VersionId ?? [...versions].find(([, value]) => value.stages.includes(command.input.VersionStage!))?.[0];
        const row = versions.get(version!);
        if (!row || (command.input.VersionStage && !row.stages.includes(command.input.VersionStage))) throw new Error("Synthetic version-stage mismatch");
        output = { ARN: secretArn, VersionId: version, VersionStages: [...row.stages], SecretString: row.value, $metadata: {} };
      } else if (command instanceof PutSecretValueCommand) {
        const id = command.input.ClientRequestToken!;
        const existing = versions.get(id);
        if (existing && existing.value !== command.input.SecretString) throw new Error("Synthetic immutable version conflict");
        if (!existing) versions.set(id, { value: command.input.SecretString!, stages: [...(command.input.VersionStages ?? ["AWSCURRENT"])] });
        output = { ARN: secretArn, VersionId: id, VersionStages: [...versions.get(id)!.stages], $metadata: {} };
      } else {
        const active = [...versions].find(([, row]) => row.stages.includes(command.input.VersionStage!));
        // Models the service's conditional stage move, not application behavior.
        if (!active || active[0] !== command.input.RemoveFromVersionId) throw new Error("Synthetic concurrent current change");
        active[1].stages = active[1].stages.filter(stage => stage !== command.input.VersionStage);
        active[1].stages.push("AWSPREVIOUS");
        versions.get(command.input.MoveToVersionId!)!.stages.push(command.input.VersionStage!);
        output = { ARN: secretArn, $metadata: {} };
      }
      return fault?.(command, output) ?? output;
    },
  };
  const provision = (overrides: Partial<Parameters<typeof provisionEchoOAuthClient>[0]> = {}) => provisionEchoOAuthClient({
    secretArn, expectedCurrentVersionId: previous, requestToken: token, client, generateCredentials: () => ({ ...credentials }), ...overrides,
  });
  return { client, calls, versions, provision };
}

async function expectSafeError(action: Promise<unknown>, code: string, phase: string, uncertain = false) {
  const error = await action.then(() => { throw new Error("Expected provisioning to stop"); }, reason => reason);
  expect(error).toBeInstanceOf(EchoOAuthProvisioningError);
  expect(error).toMatchObject({ code, phase, outcomeUncertain: uncertain });
  expect(error.cause).toBeUndefined();
  const shown = `${String(error)} ${JSON.stringify(error)}`;
  for (const secret of [original.jwks.keys[0]!.d, original.csrfSecret, ...original.cookieKeys,
    original.serviceClient.clientSecret, original.userClient.clientSecret, credentials.clientSecret, "sensitive SDK request"]) {
    expect(shown).not.toContain(secret);
  }
  return error;
}

describe("additive Echo OAuth client provisioning", () => {
  it("preserves all existing fields and versions, stages privately, verifies before conditional promotion, and returns no secret", async () => {
    const f = fixture();
    const receipt = await f.provision();
    const current = f.versions.get(token)!;
    const { echoClient, ...preserved } = JSON.parse(current.value);
    expect(preserved).toEqual(original);
    expect(echoClient).toEqual(credentials);
    expect(f.versions.get(previous)!.value).toBe(JSON.stringify(original));
    expect(f.versions.get(previous)!.stages).toEqual(["retained-label", "AWSPREVIOUS"]);
    expect(current.stages).toEqual([`kin-echo-provision-${token}`, "AWSCURRENT"]);
    expect(receipt).toEqual({ schemaVersion: 1, previousVersionId: previous, currentVersionId: token, requestToken: token,
      stagingLabel: `kin-echo-provision-${token}`, clientId: credentials.clientId });
    expect(JSON.stringify(receipt)).not.toContain(credentials.clientSecret);
    expect(f.calls.map(command => command.constructor.name)).toEqual([
      "GetSecretValueCommand", "PutSecretValueCommand", "GetSecretValueCommand", "UpdateSecretVersionStageCommand", "GetSecretValueCommand",
    ]);
    expect(f.calls[0]!.input).toEqual({ SecretId: secretArn, VersionId: previous, VersionStage: "AWSCURRENT" });
    expect(f.calls[1]!.input).toMatchObject({ ClientRequestToken: token, VersionStages: [`kin-echo-provision-${token}`] });
    expect(f.calls[3]!.input).toEqual({ SecretId: secretArn, VersionStage: "AWSCURRENT", MoveToVersionId: token, RemoveFromVersionId: previous });
    expect(f.calls[4]!.input).toEqual({ SecretId: secretArn, VersionId: token, VersionStage: "AWSCURRENT" });
  });

  it.each([
    "kin/oauth/configuration", "arn:aws:secretsmanager:us-east-1:123456789012:secret:kin/oauth/configuration",
    `${secretArn}*`, ` ${secretArn}`, secretArn.replace("secretsmanager", "s3"), secretArn.replace("123456789012", "1234"),
  ])("rejects nonexact secret identifier %s before any read or write", async arn => {
    const f = fixture();
    await expectSafeError(f.provision({ secretArn: arn }), "INVALID_INPUT", "input");
    expect(f.calls).toEqual([]);
  });

  it.each([
    { requestToken: "short" }, { requestToken: `${token}\nsecret` }, { requestToken: previous },
    { expectedCurrentVersionId: "latest" }, { expectedCurrentVersionId: "x".repeat(65) },
  ])("rejects invalid version or request identity %j before touching the secret", async overrides => {
    const f = fixture();
    const error = await expectSafeError(f.provision(overrides), "INVALID_INPUT", "input");
    if (overrides.requestToken && !/^[a-f0-9-]{36}$/.test(overrides.requestToken)) expect(error.requestToken).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it.each(["arn", "version", "stage"]) ("refuses wrong current %s response without writing", async field => {
    const f = fixture(undefined, (command, output) => command instanceof GetSecretValueCommand ? {
      ...output, ...(field === "arn" ? { ARN: secretArn.replace("123456789012", "999999999999") } :
        field === "version" ? { VersionId: concurrent } : { VersionStages: ["AWSPREVIOUS"] }),
    } : undefined);
    await expectSafeError(f.provision(), "CURRENT_VERSION_MISMATCH", "read-current");
    expect(f.calls).toHaveLength(1);
  });

  it.each(["{sensitive SDK request", "null", JSON.stringify({ ...original, schemaVersion: 2 }),
    JSON.stringify({ ...original, unexpected: "sensitive SDK request" }), JSON.stringify({ ...original, cookieKeys: [] }),
    JSON.stringify({ ...original, echoClient: { clientId: credentials.clientId, clientSecret: "short" } }),
  ])("refuses malformed current secret without changing a version", async value => {
    const f = fixture(value);
    await expectSafeError(f.provision(), "INVALID_SECRET", "read-current");
    expect(f.calls).toHaveLength(1); expect(f.versions.size).toBe(1);
  });

  it("refuses to replace existing Echo credentials even when they match the supplied generator", async () => {
    const f = fixture(JSON.stringify({ ...original, echoClient: credentials }));
    await expectSafeError(f.provision(), "ECHO_CLIENT_EXISTS", "prepare");
    expect(f.calls).toHaveLength(1); expect(f.versions.size).toBe(1);
  });

  it.each([
    { ...credentials, clientId: original.serviceClient.clientId }, { ...credentials, clientId: original.userClient.clientId },
    { ...credentials, clientSecret: original.serviceClient.clientSecret }, { ...credentials, clientSecret: original.userClient.clientSecret },
    { ...credentials, clientId: "short" }, { ...credentials, clientSecret: "short" },
    { ...credentials, clientId: ` ${credentials.clientId}` }, { ...credentials, clientSecret: "a".repeat(257) },
  ])("rejects invalid or reused generated credentials without writing", async invalid => {
    const f = fixture();
    await expectSafeError(f.provision({ generateCredentials: () => invalid }), "INVALID_CREDENTIALS", "prepare");
    expect(f.calls).toHaveLength(1);
  });

  it("sanitizes generator errors before any write", async () => {
    const f = fixture();
    await expectSafeError(f.provision({ generateCredentials: () => { throw new Error(`sensitive SDK request ${credentials.clientSecret}`); } }),
      "INVALID_CREDENTIALS", "prepare");
    expect(f.calls).toHaveLength(1);
  });

  it("sanitizes a failed initial read and performs no retry", async () => {
    const f = fixture(undefined, () => { throw new Error(`sensitive SDK request ${original.csrfSecret}`); });
    await expectSafeError(f.provision(), "READ_CURRENT_FAILED", "read-current");
    expect(f.calls).toHaveLength(1);
  });

  it("reports uncertain candidate writes and never promotes or retries after losing the response", async () => {
    const f = fixture(undefined, command => { if (command instanceof PutSecretValueCommand) throw new Error(`sensitive SDK request ${credentials.clientSecret}`); });
    const error = await expectSafeError(f.provision(), "WRITE_OUTCOME_UNCERTAIN", "write-candidate", true);
    expect(error.requestToken).toBe(token);
    expect(f.calls).toHaveLength(2);
    expect(f.versions.get(previous)!.stages).toContain("AWSCURRENT");
    expect(f.versions.get(token)!.stages).not.toContain("AWSCURRENT");
  });

  it.each(["arn", "version", "stage", "missing"]) ("stops after an unexpected candidate write %s receipt", async field => {
    const f = fixture(undefined, (command, output) => command instanceof PutSecretValueCommand ?
      (field === "missing" ? { $metadata: {} } : { ...output, ...(field === "arn" ? { ARN: "wrong" } :
        field === "version" ? { VersionId: concurrent } : { VersionStages: ["AWSCURRENT"] }) }) : undefined);
    await expectSafeError(f.provision(), "CANDIDATE_VERIFICATION_FAILED", "write-candidate", true);
    expect(f.calls).toHaveLength(2);
  });

  it.each(["value", "version", "arn", "stage", "current-stage", "unavailable"]) ("does not promote when candidate readback has wrong %s", async field => {
    const f = fixture(undefined, (command, output) => {
      if (!(command instanceof GetSecretValueCommand) || command.input.VersionId !== token) return;
      if (field === "unavailable") throw new Error("sensitive SDK request");
      return { ...output, ...(field === "value" ? { SecretString: JSON.stringify(original) } :
        field === "version" ? { VersionId: concurrent } : field === "arn" ? { ARN: "wrong" } :
          { VersionStages: field === "current-stage" ? [`kin-echo-provision-${token}`, "AWSCURRENT"] : ["wrong-stage"] }) };
    });
    await expectSafeError(f.provision(), "CANDIDATE_VERIFICATION_FAILED", "verify-candidate", true);
    expect(f.calls).toHaveLength(3); expect(f.versions.get(previous)!.stages).toContain("AWSCURRENT");
  });

  it("does not replace a concurrent current version and leaves only its isolated candidate", async () => {
    const f = fixture(undefined, command => {
      if (command instanceof GetSecretValueCommand && command.input.VersionId === token) {
        f.versions.get(previous)!.stages = ["AWSPREVIOUS"];
        f.versions.set(concurrent, { value: JSON.stringify({ ...original, csrfSecret: "concurrent-new-csrf-".repeat(3) }), stages: ["AWSCURRENT"] });
      }
    });
    await expectSafeError(f.provision(), "PROMOTION_OUTCOME_UNCERTAIN", "promote", true);
    expect(f.calls).toHaveLength(4);
    expect(f.versions.get(concurrent)!.stages).toEqual(["AWSCURRENT"]);
    expect(f.versions.get(token)!.stages).toEqual([`kin-echo-provision-${token}`]);
  });

  it("reports uncertain promotion without repeating it or rolling back a potentially active client", async () => {
    const f = fixture(undefined, command => { if (command instanceof UpdateSecretVersionStageCommand) throw new Error(`sensitive SDK request ${credentials.clientSecret}`); });
    await expectSafeError(f.provision(), "PROMOTION_OUTCOME_UNCERTAIN", "promote", true);
    expect(f.calls).toHaveLength(4); expect(f.versions.get(token)!.stages).toContain("AWSCURRENT");
  });

  it.each(["value", "version", "stage", "unavailable"]) ("does not claim completion when current verification has wrong %s", async field => {
    const f = fixture(undefined, (command, output) => {
      if (!(command instanceof GetSecretValueCommand) || command.input.VersionId !== token || command.input.VersionStage !== "AWSCURRENT") return;
      if (field === "unavailable") throw new Error("sensitive SDK request");
      return { ...output, ...(field === "value" ? { SecretString: JSON.stringify(original) } :
        field === "version" ? { VersionId: previous } : { VersionStages: [`kin-echo-provision-${token}`] }) };
    });
    await expectSafeError(f.provision(), "CURRENT_VERIFICATION_FAILED", "verify-current", true);
    expect(f.calls).toHaveLength(5); expect(f.versions.get(token)!.stages).toContain("AWSCURRENT");
  });

  it("rejects a repeated completed operation before generating or changing credentials", async () => {
    const f = fixture(); await f.provision(); const callsBefore = f.calls.length;
    await expectSafeError(f.provision(), "READ_CURRENT_FAILED", "read-current");
    expect(f.calls).toHaveLength(callsBefore + 1); expect(f.versions.size).toBe(2);
    await expectSafeError(f.provision({ expectedCurrentVersionId: token, requestToken: concurrent }), "ECHO_CLIENT_EXISTS", "prepare");
    expect(f.versions.size).toBe(2);
  });

  it.each([false, true])("inspection exposes only version, schema and Echo presence (%s)", async hasEcho => {
    const f = fixture(JSON.stringify({ ...original, ...(hasEcho ? { echoClient: credentials } : {}) }));
    expect(await inspectEchoOAuthClient({ secretArn, client: f.client })).toEqual({ schemaVersion: 1, currentVersionId: previous, hasEchoClient: hasEcho });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.input).toEqual({ SecretId: secretArn, VersionStage: "AWSCURRENT" });
  });
});
