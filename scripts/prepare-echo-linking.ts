import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { EchoOAuthProvisioningError, inspectEchoOAuthClient, provisionEchoOAuthClient,
  type EchoOAuthSecretSender } from "../src/echo-oauth-provisioning.js";

// This operator tool targets only the already-reviewed, compatible Kin release.
// It is not bundled into a Lambda and never prints secret values.
export const echoSetupTarget = {
  accountId: "954807518512", region: "us-east-1",
  secretArn: "arn:aws:secretsmanager:us-east-1:954807518512:secret:kin/oauth/configuration-XCfEVi",
  functionArn: "arn:aws:lambda:us-east-1:954807518512:function:kin-oauth-api",
  compatibleCodeSha256: "73UxLOC4pRcW2VWBgDEZu1GcEgrJxdI6XJI70BKcBV4=",
} as const;
const bindingSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.string().regex(/^kin-[A-Za-z0-9_-]{1,60}$/),
  operatorRoleName: z.string().regex(/^Kin[A-Za-z0-9_-]{1,60}$/),
  accountId: z.literal(echoSetupTarget.accountId), region: z.literal(echoSetupTarget.region),
  secretArn: z.literal(echoSetupTarget.secretArn),
  expectedOAuthCodeSha256: z.literal(echoSetupTarget.compatibleCodeSha256),
  requestToken: z.string().uuid(),
  expectedCurrentVersionId: z.string().regex(/^[A-Za-z0-9-]{32,64}$/).optional(),
}).strict();
export type EchoSetupBinding = z.infer<typeof bindingSchema>;
export class EchoSetupError extends Error {
  constructor(readonly code: string) { super(code); this.name = "EchoSetupError"; }
}
export function parseEchoSetupBinding(value: unknown): EchoSetupBinding {
  const result = bindingSchema.safeParse(value);
  if (!result.success) throw new EchoSetupError("invalid_echo_setup_binding");
  return result.data;
}
export function planEchoSetup(value: unknown) {
  const binding = parseEchoSetupBinding(value);
  return { bindingDigest: createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
    ...binding, cloudStateChecked: false, writesSecrets: false, enablesCare: false,
    instruction: "Inspect first. Provision requires this exact binding digest and the inspected current version. No secret values are displayed." };
}
export function echoSetupLaunch(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" as const };
  if (!args[0] || !path.isAbsolute(args[0]) || /[\u0000-\u001f\u007f]/.test(args[0])) throw new EchoSetupError("absolute_private_binding_file_required");
  if (args.length === 1) return { mode: "plan" as const, file: args[0] };
  if (args.length === 2 && args[1] === "--inspect") return { mode: "inspect" as const, file: args[0] };
  if (args.length === 3 && args[1] === "--provision" && /^[a-f0-9]{64}$/.test(args[2]!)) {
    return { mode: "provision" as const, file: args[0], approvedDigest: args[2]! };
  }
  throw new EchoSetupError("unsupported_echo_setup_arguments");
}
export async function readEchoSetupBinding(file: string) {
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size < 2 || info.size > 8192 || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error();
    const bytes = Buffer.alloc(8193);
    const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192) throw new Error();
    return parseEchoSetupBinding(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } catch { throw new EchoSetupError("invalid_or_nonprivate_echo_binding"); }
  finally { await descriptor.close(); }
}
export function echoSetupCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"];
  return { ...Object.fromEntries(keep.filter(key => environment[key] !== undefined).map(key => [key, environment[key]])),
    AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" };
}
type AwsRunner = (args: string[], environment: NodeJS.ProcessEnv) => Promise<unknown>;
const executeFile = promisify(execFile);
export const echoSetupAws: AwsRunner = async (args, environment) => {
  try {
    const { stdout } = await executeFile("/usr/local/bin/aws", args, {
      env: environment, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8", killSignal: "SIGKILL",
    });
    return JSON.parse(stdout);
  } catch { throw new EchoSetupError("aws_setup_command_failed_no_automatic_retry"); }
};
const credentialsSchema = z.object({
  Version: z.literal(1), AccessKeyId: z.string().regex(/^ASIA[A-Z0-9]{16}$/),
  SecretAccessKey: z.string().min(32).max(128), SessionToken: z.string().min(1).max(16384),
  Expiration: z.string().datetime({ offset: true }),
});
interface SetupDependencies {
  aws?: AwsRunner;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  secretClient?: (credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }) => EchoOAuthSecretSender & { destroy?: () => void };
}
export async function runEchoSetup(value: unknown, options: { mode: "inspect" | "provision"; approvedDigest?: string }, dependencies: SetupDependencies = {}) {
  const binding = parseEchoSetupBinding(value);
  if (options.mode !== "inspect" && options.mode !== "provision") throw new EchoSetupError("invalid_echo_setup_mode");
  if (options.mode === "provision" && (!binding.expectedCurrentVersionId || binding.expectedCurrentVersionId === binding.requestToken ||
      options.approvedDigest !== planEchoSetup(binding).bindingDigest)) throw new EchoSetupError("exact_version_and_binding_approval_required");
  const aws = dependencies.aws ?? echoSetupAws;
  const environment = echoSetupCliEnvironment(dependencies.environment ?? process.env);
  // Capture one temporary session. STS, Lambda checks and Secrets Manager all
  // use these same credentials, not three independent profile resolutions.
  const exported = credentialsSchema.safeParse(await aws(["configure", "export-credentials", "--profile", binding.profile,
    "--format", "process", "--no-cli-pager", "--no-cli-auto-prompt"], environment));
  const time = (dependencies.now ?? Date.now)();
  if (!exported.success || Date.parse(exported.data.Expiration) < time + 120_000) throw new EchoSetupError("fresh_temporary_credentials_required");
  const credentials = { accessKeyId: exported.data.AccessKeyId, secretAccessKey: exported.data.SecretAccessKey, sessionToken: exported.data.SessionToken };
  const sessionEnvironment = { ...environment, AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_SESSION_TOKEN: credentials.sessionToken };
  const flags = ["--region", binding.region, "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt",
    "--cli-connect-timeout", "3", "--cli-read-timeout", "8"];
  const identity = z.object({ Account: z.string(), Arn: z.string() }).safeParse(await aws([
    "sts", "get-caller-identity", "--endpoint-url", `https://sts.${binding.region}.amazonaws.com`, ...flags,
  ], sessionEnvironment));
  const prefix = `arn:aws:sts::${binding.accountId}:assumed-role/${binding.operatorRoleName}/`;
  if (!identity.success || identity.data.Account !== binding.accountId || !identity.data.Arn.startsWith(prefix) ||
    !/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(identity.data.Arn.slice(prefix.length))) throw new EchoSetupError("exact_non_root_operator_role_required");
  const config = z.object({ FunctionArn: z.string(), CodeSha256: z.string(), State: z.string(), LastUpdateStatus: z.string(),
    Environment: z.object({ Variables: z.record(z.string(), z.string()) }) }).safeParse(await aws([
    "lambda", "get-function-configuration", "--function-name", echoSetupTarget.functionArn,
    "--endpoint-url", `https://lambda.${binding.region}.amazonaws.com`, ...flags,
  ], sessionEnvironment));
  if (!config.success || config.data.FunctionArn !== echoSetupTarget.functionArn || config.data.CodeSha256 !== binding.expectedOAuthCodeSha256 ||
    config.data.State !== "Active" || config.data.LastUpdateStatus !== "Successful" ||
    config.data.Environment.Variables.KIN_OAUTH_SECRET_ID !== binding.secretArn ||
    config.data.Environment.Variables.KIN_ECHO_REDIRECT_URIS !== "") throw new EchoSetupError("compatible_oauth_reader_and_disabled_callbacks_required");
  const client = dependencies.secretClient?.(credentials) ?? (() => {
    const sdk = new SecretsManagerClient({ region: binding.region, credentials, maxAttempts: 1,
      endpoint: `https://secretsmanager.${binding.region}.amazonaws.com` });
    return { send: (command: Parameters<EchoOAuthSecretSender["send"]>[0]) => {
      const options = { abortSignal: AbortSignal.timeout(10_000) };
      if (command instanceof GetSecretValueCommand) return sdk.send(command, options);
      if (command instanceof PutSecretValueCommand) return sdk.send(command, options);
      return sdk.send(command, options);
    },
      destroy: () => sdk.destroy() };
  })();
  try {
    const result = options.mode === "inspect"
      ? await inspectEchoOAuthClient({ secretArn: binding.secretArn, client })
      : await provisionEchoOAuthClient({ secretArn: binding.secretArn, expectedCurrentVersionId: binding.expectedCurrentVersionId!,
        requestToken: binding.requestToken, client });
    return { ...result, mode: options.mode, operatorArn: identity.data.Arn, cloudStateChecked: true,
      enablesCare: false, configuresAlexa: false, next: "Keep callbacks and care disabled until private credential entry in Alexa is complete. Never paste secrets into chat." };
  } finally { client.destroy?.(); }
}
export async function claimEchoSetupIntent(file: string, value: unknown, approvedDigest: string) {
  const binding = parseEchoSetupBinding(value);
  if (!path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) throw new EchoSetupError("absolute_private_binding_file_required");
  if (!binding.expectedCurrentVersionId || binding.expectedCurrentVersionId === binding.requestToken ||
    approvedDigest !== planEchoSetup(binding).bindingDigest) throw new EchoSetupError("exact_version_and_binding_approval_required");
  // A persistent, non-secret intent prevents an accidental second invocation
  // after a timeout. Inspect uncertain outcomes; never remove this to retry.
  const intent = await open(`${file}.${binding.requestToken}.intent.json`, "wx", 0o600);
  try { await intent.writeFile(JSON.stringify({ at: new Date().toISOString(), bindingDigest: approvedDigest,
    requestToken: binding.requestToken, expectedCurrentVersionId: binding.expectedCurrentVersionId })); await intent.sync(); }
  finally { await intent.close(); }
}
export async function executeEchoSetupCommand(options: Exclude<ReturnType<typeof echoSetupLaunch>, { mode: "help" }>, dependencies: SetupDependencies = {}) {
  const binding = await readEchoSetupBinding(options.file);
  if (options.mode === "plan") return planEchoSetup(binding);
  if (options.mode === "provision") await claimEchoSetupIntent(options.file, binding, options.approvedDigest);
  return runEchoSetup(binding, options, dependencies);
}
async function main() {
  process.umask(0o077);
  const options = echoSetupLaunch(process.argv.slice(2));
  if (options.mode === "help") {
    console.log("node --import tsx scripts/prepare-echo-linking.ts /absolute/private-binding.json [--inspect | --provision APPROVED_BINDING_SHA256]");
    console.log("Default: local plan only. Inspect: read-only checks, redacted status. Provision: one approved additive secret version, never replacement credentials; no account linking, care activation or SMS.");
    return;
  }
  console.log(JSON.stringify(await executeEchoSetupCommand(options), null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    const failure = error instanceof EchoOAuthProvisioningError
      ? { code: error.code, phase: error.phase, requestToken: error.requestToken, outcomeUncertain: error.outcomeUncertain }
      : { code: error instanceof EchoSetupError ? error.code : "echo_setup_stopped", outcomeUncertain: true };
    console.error(JSON.stringify({ status: "stopped", ...failure,
      instruction: "Keep Echo callbacks and care disabled. Inspect any uncertain version before further action; do not retry a write or print raw provider errors." }));
    process.exitCode = 1;
  });
}
