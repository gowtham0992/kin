import { randomBytes } from "node:crypto";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
  type GetSecretValueCommandOutput,
  type PutSecretValueCommandOutput,
  type UpdateSecretVersionStageCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { parseOAuthSecrets, type OAuthSecrets } from "./oauth-secrets.js";

export type EchoOAuthSecretCommand = GetSecretValueCommand | PutSecretValueCommand | UpdateSecretVersionStageCommand;
type SecretOutput = GetSecretValueCommandOutput | PutSecretValueCommandOutput | UpdateSecretVersionStageCommandOutput;
export interface EchoOAuthSecretSender {
  // The caller must disable SDK retries, use a bounded transport, and never log commands.
  send(command: EchoOAuthSecretCommand): Promise<SecretOutput>;
}

export type EchoOAuthProvisioningPhase = "input" | "read-current" | "prepare" | "write-candidate" |
  "verify-candidate" | "promote" | "verify-current";
export type EchoOAuthProvisioningCode = "INVALID_INPUT" | "READ_CURRENT_FAILED" | "CURRENT_VERSION_MISMATCH" |
  "INVALID_SECRET" | "ECHO_CLIENT_EXISTS" | "INVALID_CREDENTIALS" | "WRITE_OUTCOME_UNCERTAIN" |
  "CANDIDATE_VERIFICATION_FAILED" | "PROMOTION_OUTCOME_UNCERTAIN" | "CURRENT_VERIFICATION_FAILED";

export class EchoOAuthProvisioningError extends Error {
  constructor(
    readonly code: EchoOAuthProvisioningCode,
    readonly phase: EchoOAuthProvisioningPhase,
    readonly requestToken?: string,
    readonly outcomeUncertain = false,
  ) {
    super(`Echo OAuth provisioning stopped (${code}, ${phase}). Inspect the recorded operation before another attempt.`);
    this.name = "EchoOAuthProvisioningError";
  }
}

interface SecretIdentity { secretArn: string; client: EchoOAuthSecretSender }
export interface ProvisionEchoOAuthClientInput extends SecretIdentity {
  expectedCurrentVersionId: string;
  requestToken: string;
  generateCredentials?: () => { clientId: string; clientSecret: string };
}

export interface EchoOAuthProvisioningReceipt {
  schemaVersion: 1;
  previousVersionId: string;
  currentVersionId: string;
  requestToken: string;
  stagingLabel: string;
  clientId: string;
}

const versionPattern = /^[A-Za-z0-9-]{32,64}$/;
const requestPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Require a full commercial-partition ARN, including the generated six-character suffix.
const arnPattern = /^arn:aws:secretsmanager:[a-z]{2}(?:-[a-z0-9]+)+-\d:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$/;

/** Returns metadata only. The secret value never leaves this module. */
export async function inspectEchoOAuthClient(input: SecretIdentity): Promise<{
  schemaVersion: 1; currentVersionId: string; hasEchoClient: boolean;
}> {
  validateArn(input.secretArn);
  const response = await send(input.client, new GetSecretValueCommand({
    SecretId: input.secretArn, VersionStage: "AWSCURRENT",
  }), "READ_CURRENT_FAILED", "read-current") as GetSecretValueCommandOutput;
  verifyReadIdentity(response, input.secretArn, "AWSCURRENT", undefined, "CURRENT_VERSION_MISMATCH", "read-current");
  const secret = parseSecret(response, "read-current");
  return { schemaVersion: 1, currentVersionId: response.VersionId!, hasEchoClient: !!secret.echoClient };
}

/**
 * Add the dedicated Echo identity without rotating any existing material.
 * A custom-labelled version is read back before AWSCURRENT moves. The explicit
 * RemoveFromVersionId makes a concurrent current-version change fail closed.
 * There is deliberately no automatic retry, rotation, cleanup, or rollback.
 */
export async function provisionEchoOAuthClient(input: ProvisionEchoOAuthClientInput): Promise<EchoOAuthProvisioningReceipt> {
  const token = requestPattern.test(input.requestToken) ? input.requestToken : undefined;
  validateArn(input.secretArn, token);
  if (!token || !versionPattern.test(input.expectedCurrentVersionId) || token === input.expectedCurrentVersionId) {
    throw new EchoOAuthProvisioningError("INVALID_INPUT", "input", token);
  }
  const current = await send(input.client, new GetSecretValueCommand({
    SecretId: input.secretArn, VersionId: input.expectedCurrentVersionId, VersionStage: "AWSCURRENT",
  }), "READ_CURRENT_FAILED", "read-current", token) as GetSecretValueCommandOutput;
  verifyReadIdentity(current, input.secretArn, "AWSCURRENT", input.expectedCurrentVersionId,
    "CURRENT_VERSION_MISMATCH", "read-current", token);
  const original = parseSecret(current, "read-current", token);
  if (original.echoClient) throw new EchoOAuthProvisioningError("ECHO_CLIENT_EXISTS", "prepare", token);

  let credentials: { clientId: string; clientSecret: string };
  let candidateString: string;
  try {
    const generated = (input.generateCredentials ?? generateCredentials)();
    // Copy only the two primitive fields. Never retain getters, extra keys or a
    // generator-supplied toJSON method in the value sent across the boundary.
    credentials = { clientId: generated.clientId, clientSecret: generated.clientSecret };
    if (typeof credentials.clientId !== "string" || typeof credentials.clientSecret !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(credentials.clientId) ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(credentials.clientSecret) ||
      [original.serviceClient.clientId.trim(), original.userClient.clientId.trim()].includes(credentials.clientId) ||
      [original.serviceClient.clientSecret.trim(), original.userClient.clientSecret.trim()].includes(credentials.clientSecret)) {
      throw new Error("Invalid generated credentials");
    }
    // Use the validated original document; do not rebuild signing keys or other clients.
    candidateString = JSON.stringify({ ...original, echoClient: credentials });
    parseOAuthSecrets(candidateString);
  } catch {
    throw new EchoOAuthProvisioningError("INVALID_CREDENTIALS", "prepare", token);
  }
  if (Buffer.byteLength(candidateString, "utf8") > 65_536) {
    throw new EchoOAuthProvisioningError("INVALID_SECRET", "prepare", token);
  }
  const stagingLabel = `kin-echo-provision-${token}`;
  const written = await send(input.client, new PutSecretValueCommand({
    SecretId: input.secretArn, ClientRequestToken: token, SecretString: candidateString,
    VersionStages: [stagingLabel],
  }), "WRITE_OUTCOME_UNCERTAIN", "write-candidate", token, true) as PutSecretValueCommandOutput;
  if (written.ARN !== input.secretArn || written.VersionId !== token ||
    !Array.isArray(written.VersionStages) || written.VersionStages.length !== 1 || written.VersionStages[0] !== stagingLabel) {
    throw new EchoOAuthProvisioningError("CANDIDATE_VERIFICATION_FAILED", "write-candidate", token, true);
  }
  const staged = await send(input.client, new GetSecretValueCommand({
    SecretId: input.secretArn, VersionId: token, VersionStage: stagingLabel,
  }), "CANDIDATE_VERIFICATION_FAILED", "verify-candidate", token, true) as GetSecretValueCommandOutput;
  verifyReadIdentity(staged, input.secretArn, stagingLabel, token,
    "CANDIDATE_VERIFICATION_FAILED", "verify-candidate", token, true);
  if (staged.SecretString !== candidateString || staged.SecretBinary || staged.VersionStages?.length !== 1) {
    throw new EchoOAuthProvisioningError("CANDIDATE_VERIFICATION_FAILED", "verify-candidate", token, true);
  }

  const promoted = await send(input.client, new UpdateSecretVersionStageCommand({
    SecretId: input.secretArn, VersionStage: "AWSCURRENT", MoveToVersionId: token,
    RemoveFromVersionId: input.expectedCurrentVersionId,
  }), "PROMOTION_OUTCOME_UNCERTAIN", "promote", token, true);
  if (promoted.ARN !== input.secretArn) {
    throw new EchoOAuthProvisioningError("PROMOTION_OUTCOME_UNCERTAIN", "promote", token, true);
  }
  const activated = await send(input.client, new GetSecretValueCommand({
    SecretId: input.secretArn, VersionId: token, VersionStage: "AWSCURRENT",
  }), "CURRENT_VERIFICATION_FAILED", "verify-current", token, true) as GetSecretValueCommandOutput;
  verifyReadIdentity(activated, input.secretArn, "AWSCURRENT", token,
    "CURRENT_VERIFICATION_FAILED", "verify-current", token, true);
  if (activated.SecretString !== candidateString || activated.SecretBinary || !activated.VersionStages?.includes(stagingLabel)) {
    throw new EchoOAuthProvisioningError("CURRENT_VERIFICATION_FAILED", "verify-current", token, true);
  }
  return { schemaVersion: 1, previousVersionId: input.expectedCurrentVersionId, currentVersionId: token,
    requestToken: token, stagingLabel, clientId: credentials.clientId };
}

function generateCredentials() {
  return { clientId: `kin-echo-${randomBytes(18).toString("base64url")}`, clientSecret: randomBytes(48).toString("base64url") };
}

function validateArn(arn: string, token?: string) {
  if (!arnPattern.test(arn)) throw new EchoOAuthProvisioningError("INVALID_INPUT", "input", token);
}

function parseSecret(response: GetSecretValueCommandOutput, phase: EchoOAuthProvisioningPhase, token?: string): OAuthSecrets {
  try {
    if (!response.SecretString || response.SecretBinary || Buffer.byteLength(response.SecretString, "utf8") > 65_536) throw new Error();
    return parseOAuthSecrets(response.SecretString);
  } catch {
    throw new EchoOAuthProvisioningError("INVALID_SECRET", phase, token);
  }
}

function verifyReadIdentity(
  response: GetSecretValueCommandOutput, arn: string, stage: string, version: string | undefined,
  code: EchoOAuthProvisioningCode, phase: EchoOAuthProvisioningPhase, token?: string, uncertain = false,
) {
  if (response.ARN !== arn || !response.VersionId || !versionPattern.test(response.VersionId) ||
    (version && response.VersionId !== version) || !Array.isArray(response.VersionStages) ||
    !response.VersionStages.every(value => typeof value === "string") || !response.VersionStages.includes(stage)) {
    throw new EchoOAuthProvisioningError(code, phase, token, uncertain);
  }
}

async function send(
  client: EchoOAuthSecretSender, command: EchoOAuthSecretCommand, code: EchoOAuthProvisioningCode,
  phase: EchoOAuthProvisioningPhase, token?: string, uncertain = false,
) {
  try {
    const output = await client.send(command);
    if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error();
    return output;
  } catch {
    // Raw SDK exceptions can include request bodies, secret values, and private details.
    throw new EchoOAuthProvisioningError(code, phase, token, uncertain);
  }
}
