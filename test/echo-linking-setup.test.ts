import { mkdtemp, chmod, writeFile, readFile, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as provisioning from "../src/echo-oauth-provisioning.js";
import { echoSetupTarget, echoSetupLaunch, echoSetupCliEnvironment, parseEchoSetupBinding, planEchoSetup,
  readEchoSetupBinding, runEchoSetup, claimEchoSetupIntent, executeEchoSetupCommand, type EchoSetupBinding } from "../scripts/prepare-echo-linking.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn(() => { throw new Error("AWS CLI forbidden in these tests"); }) }));
vi.mock("@aws-sdk/client-secrets-manager", async importOriginal => ({
  ...await importOriginal<typeof import("@aws-sdk/client-secrets-manager")>(),
  SecretsManagerClient: vi.fn(() => { throw new Error("Real AWS SDK forbidden in these tests"); }),
}));
vi.mock("../src/echo-oauth-provisioning.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/echo-oauth-provisioning.js")>(),
  inspectEchoOAuthClient: vi.fn(), provisionEchoOAuthClient: vi.fn(),
}));
const now = Date.parse("2026-09-11T19:00:00Z");
const binding: EchoSetupBinding = { schemaVersion: 1, profile: "kin-echo-setup", operatorRoleName: "KinEchoOAuthSetup",
  accountId: echoSetupTarget.accountId, region: echoSetupTarget.region, secretArn: echoSetupTarget.secretArn,
  expectedOAuthCodeSha256: echoSetupTarget.compatibleCodeSha256,
  requestToken: "02868b01-7a52-4848-a6e6-a413c899fd8c", expectedCurrentVersionId: "ea022898-dd7e-47f0-b97a-72ba9f626c89" };
const credentials = { Version: 1, AccessKeyId: `ASIA${"A".repeat(16)}`, SecretAccessKey: "synthetic-secret-key-".repeat(3),
  SessionToken: "synthetic-session-token", Expiration: "2026-09-11T19:15:00Z" };
const identity = { Account: binding.accountId, Arn: `arn:aws:sts::${binding.accountId}:assumed-role/${binding.operatorRoleName}/synthetic` };
const config = { FunctionArn: echoSetupTarget.functionArn, CodeSha256: binding.expectedOAuthCodeSha256,
  State: "Active", LastUpdateStatus: "Successful", Environment: { Variables: {
    KIN_OAUTH_SECRET_ID: binding.secretArn, KIN_ECHO_REDIRECT_URIS: "",
  } } };
const directories: string[] = [];
beforeEach(() => {
  vi.mocked(provisioning.inspectEchoOAuthClient).mockReset().mockResolvedValue({ schemaVersion: 1,
    currentVersionId: binding.expectedCurrentVersionId!, hasEchoClient: false });
  vi.mocked(provisioning.provisionEchoOAuthClient).mockReset().mockResolvedValue({ schemaVersion: 1,
    previousVersionId: binding.expectedCurrentVersionId!, currentVersionId: binding.requestToken,
    requestToken: binding.requestToken, stagingLabel: "synthetic-label", clientId: "kin-echo-synthetic-client" });
});
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
function fixture(overrides: Partial<Record<"credentials" | "identity" | "config", unknown>> = {}) {
  const values = { credentials, identity, config, ...overrides };
  const aws = vi.fn(async (args: string[], _env: NodeJS.ProcessEnv) => {
    if (args[0] === "configure") return values.credentials;
    if (args[0] === "sts") return values.identity;
    if (args[0] === "lambda") return values.config;
    throw new Error("Unexpected AWS operation");
  });
  const client = { send: vi.fn(), destroy: vi.fn() };
  const secretClient = vi.fn(() => client);
  const dependencies = { aws, secretClient, now: () => now, environment: { HOME: "/synthetic/home" } };
  return { aws, client, secretClient, dependencies, provision: () => runEchoSetup(binding,
    { mode: "provision", approvedDigest: planEchoSetup(binding).bindingDigest }, dependencies) };
}
describe("private Echo account-linking setup boundary", () => {
  it("defaults to an offline plan and binds approval to the full target and version", () => {
    expect(echoSetupLaunch(["/private/binding.json"])).toEqual({ mode: "plan", file: "/private/binding.json" });
    expect(echoSetupLaunch(["--help"])).toEqual({ mode: "help" });
    expect(planEchoSetup(binding)).toMatchObject({ cloudStateChecked: false, writesSecrets: false, enablesCare: false });
    expect(planEchoSetup({ ...binding, expectedCurrentVersionId: "e0f47ff7-9c5a-4df7-9e98-4968d2d8e0ac" }).bindingDigest)
      .not.toBe(planEchoSetup(binding).bindingDigest);
    expect(provisioning.provisionEchoOAuthClient).not.toHaveBeenCalled();
  });
  it.each([[], ["relative.json"], ["/private/binding.json", "--provision"],
    ["/private/binding.json", "--inspect", "extra"], ["/private/binding.json", "--provision", "z".repeat(64)]
  ].map(args => ({ args })))("rejects ambiguous launch arguments $args", ({ args }) => { expect(() => echoSetupLaunch(args)).toThrow(); });
  it.each([{ accountId: "000000000000" }, { region: "us-west-2" }, { profile: "default" }, { operatorRoleName: "root" },
    { secretArn: `${binding.secretArn}-other` }, { expectedOAuthCodeSha256: "A".repeat(43) + "=" },
    { requestToken: "not-a-uuid" }, { expectedCurrentVersionId: "short" }, { extra: true },
  ])("rejects foreign or malformed binding %j", patch => { expect(() => parseEchoSetupBinding({ ...binding, ...patch })).toThrow(); });
  it.each([undefined, "0".repeat(64)])("rejects unapproved provisioning before credentials are loaded", async approvedDigest => {
    const f = fixture(); await expect(runEchoSetup(binding, { mode: "provision", approvedDigest }, f.dependencies)).rejects.toThrow("approval_required");
    expect(f.aws).not.toHaveBeenCalled(); expect(f.secretClient).not.toHaveBeenCalled();
  });
  it("requires the inspected current version, not just a target digest", async () => {
    const f = fixture(), noVersion = { ...binding, expectedCurrentVersionId: undefined };
    await expect(runEchoSetup(noVersion, { mode: "provision", approvedDigest: planEchoSetup(noVersion).bindingDigest }, f.dependencies)).rejects.toThrow("approval_required");
    expect(f.aws).not.toHaveBeenCalled();
  });
  it.each([
    { Account: binding.accountId, Arn: `arn:aws:iam::${binding.accountId}:root` },
    { Account: binding.accountId, Arn: `${identity.Arn.replace("KinEchoOAuthSetup/", "KinOtherRole/")}` },
    { ...identity, Account: "000000000000" }, { ...identity, Arn: `${identity.Arn}/extra` },
  ])("rejects the wrong or root identity before secret access %j", async badIdentity => {
    const f = fixture({ identity: badIdentity }); await expect(f.provision()).rejects.toThrow("exact_non_root_operator_role_required");
    expect(f.secretClient).not.toHaveBeenCalled(); expect(provisioning.provisionEchoOAuthClient).not.toHaveBeenCalled();
  });
  it.each([{ ...credentials, Expiration: "2026-09-11T19:01:00Z" }, { ...credentials, SessionToken: undefined },
    { ...credentials, AccessKeyId: `AKIA${"A".repeat(16)}` }])("requires fresh temporary credentials %j", async badCredentials => {
    const f = fixture({ credentials: badCredentials }); await expect(f.provision()).rejects.toThrow("fresh_temporary_credentials_required");
    expect(f.aws).toHaveBeenCalledTimes(1); expect(f.secretClient).not.toHaveBeenCalled();
  });
  it.each([{ CodeSha256: "wrong" }, { State: "Pending" }, { LastUpdateStatus: "InProgress" },
    { FunctionArn: `${config.FunctionArn}-other` },
    { Environment: { Variables: { ...config.Environment.Variables, KIN_ECHO_REDIRECT_URIS: "https://callback.invalid" } } },
    { Environment: { Variables: { ...config.Environment.Variables, KIN_OAUTH_SECRET_ID: "other-secret" } } },
  ])("refuses an incompatible or already-enabled OAuth reader %j", async patch => {
    const f = fixture({ config: { ...config, ...patch } }); await expect(f.provision()).rejects.toThrow("compatible_oauth_reader_and_disabled_callbacks_required");
    expect(f.secretClient).not.toHaveBeenCalled();
  });
  it("inspects redacted status and uses the same captured session across all checks", async () => {
    const f = fixture(); const result = await runEchoSetup(binding, { mode: "inspect" }, f.dependencies);
    expect(result).toMatchObject({ hasEchoClient: false, currentVersionId: binding.expectedCurrentVersionId,
      cloudStateChecked: true, enablesCare: false, configuresAlexa: false });
    expect(provisioning.provisionEchoOAuthClient).not.toHaveBeenCalled();
    expect(f.aws.mock.calls.slice(1).map(([, env]) => env.AWS_ACCESS_KEY_ID)).toEqual([credentials.AccessKeyId, credentials.AccessKeyId]);
    expect(f.aws.mock.calls[1]![1].AWS_CONFIG_FILE).toBe("/dev/null");
    expect(f.secretClient).toHaveBeenCalledWith({ accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken });
    expect(JSON.stringify(result)).not.toContain(credentials.SecretAccessKey); expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("passes only the approved exact version and request token to the provisioner", async () => {
    const f = fixture(); expect(await f.provision()).toMatchObject({ currentVersionId: binding.requestToken, enablesCare: false });
    expect(provisioning.provisionEchoOAuthClient).toHaveBeenCalledExactlyOnceWith({ secretArn: binding.secretArn,
      expectedCurrentVersionId: binding.expectedCurrentVersionId, requestToken: binding.requestToken, client: f.client });
    expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("does not retry a failed secret operation and always closes the client", async () => {
    const f = fixture(); vi.mocked(provisioning.provisionEchoOAuthClient).mockRejectedValue(new Error("synthetic failure"));
    await expect(f.provision()).rejects.toThrow("synthetic failure");
    expect(provisioning.provisionEchoOAuthClient).toHaveBeenCalledOnce(); expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("does not inherit alternate AWS endpoints, profiles, static credentials or debug hooks", () => {
    const env = echoSetupCliEnvironment({ HOME: "/allowed", PATH: "/usr/bin", AWS_PROFILE: "other", AWS_ENDPOINT_URL: "https://untrusted.invalid",
      AWS_ACCESS_KEY_ID: "secret", AWS_CONFIG_FILE: "/foreign", NODE_OPTIONS: "--inspect", AWS_CA_BUNDLE: "/foreign-ca" });
    expect(env).toEqual({ HOME: "/allowed", PATH: "/usr/bin", AWS_EC2_METADATA_DISABLED: "true",
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" });
  });
  it("accepts only a small, owner-private regular binding file, never a symlink", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kin-echo-binding-test-")); directories.push(directory);
    const file = path.join(directory, "binding.json"), link = path.join(directory, "link.json");
    await writeFile(file, JSON.stringify(binding), { mode: 0o600 });
    expect(await readEchoSetupBinding(file)).toEqual(binding);
    await chmod(file, 0o644); await expect(readEchoSetupBinding(file)).rejects.toThrow("nonprivate");
    await chmod(file, 0o600); await symlink(file, link); await expect(readEchoSetupBinding(link)).rejects.toThrow();
    await writeFile(file, "x".repeat(8193)); await expect(readEchoSetupBinding(file)).rejects.toThrow("nonprivate");
  });
  it("allows only one concurrent intent claim and refuses a retry without overwriting its receipt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kin-echo-intent-test-")); directories.push(directory);
    const file = path.join(directory, "binding.json"), digest = planEchoSetup(binding).bindingDigest;
    const attempts = await Promise.allSettled([claimEchoSetupIntent(file, binding, digest), claimEchoSetupIntent(file, binding, digest)]);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.status === "rejected")).toHaveLength(1);
    const intentFile = `${file}.${binding.requestToken}.intent.json`, before = await readFile(intentFile, "utf8");
    expect(JSON.parse(before)).toMatchObject({ requestToken: binding.requestToken, expectedCurrentVersionId: binding.expectedCurrentVersionId, bindingDigest: digest });
    expect((await stat(intentFile)).mode & 0o077).toBe(0);
    await expect(claimEchoSetupIntent(file, binding, digest)).rejects.toThrow();
    expect(await readFile(intentFile, "utf8")).toBe(before);
    expect(before).not.toContain(credentials.SecretAccessKey);
  });
  it("does not claim an intent for unapproved input", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kin-echo-intent-test-")); directories.push(directory);
    const file = path.join(directory, "binding.json");
    await expect(claimEchoSetupIntent(file, binding, "0".repeat(64))).rejects.toThrow("approval_required");
    await expect(stat(`${file}.${binding.requestToken}.intent.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("blocks a repeated command before loading AWS credentials, even after the first operation failed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kin-echo-command-test-")); directories.push(directory);
    const file = path.join(directory, "binding.json"); await writeFile(file, JSON.stringify(binding), { mode: 0o600 });
    const options = { mode: "provision" as const, file, approvedDigest: planEchoSetup(binding).bindingDigest };
    const f = fixture(); vi.mocked(provisioning.provisionEchoOAuthClient).mockRejectedValue(new Error("uncertain synthetic write"));
    await expect(executeEchoSetupCommand(options, f.dependencies)).rejects.toThrow("uncertain synthetic write");
    f.aws.mockClear();
    await expect(executeEchoSetupCommand(options, f.dependencies)).rejects.toMatchObject({ code: "EEXIST" });
    expect(f.aws).not.toHaveBeenCalled(); expect(provisioning.provisionEchoOAuthClient).toHaveBeenCalledOnce();
  });
  it("runs the default command as an offline plan without constructing AWS dependencies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kin-echo-command-test-")); directories.push(directory);
    const file = path.join(directory, "binding.json"); await writeFile(file, JSON.stringify(binding), { mode: 0o600 });
    const f = fixture();
    expect(await executeEchoSetupCommand({ mode: "plan", file }, f.dependencies)).toMatchObject({ cloudStateChecked: false, writesSecrets: false });
    expect(f.aws).not.toHaveBeenCalled(); expect(f.secretClient).not.toHaveBeenCalled();
  });
});
