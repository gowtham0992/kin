import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSmsDestinationSetup, parseSmsDestinationBinding, planSmsDestination, smsSetupTarget,
  type SmsDestinationBinding, type SmsSetupOperation } from "../src/sms-destination-setup.js";
import { readSmsBinding, smsSetupCliEnvironment, smsSetupCliTransport, smsSetupLaunch } from "../scripts/prepare-sms-destination.js";

// No test is permitted to start the installed AWS CLI.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const binding: SmsDestinationBinding = { schemaVersion: 1, accountId: smsSetupTarget.accountId, region: smsSetupTarget.region,
  topicArn: smsSetupTarget.topicArn, profile: "kin-sms-setup", operatorRoleName: "KinSmsSetup",
  memberId: "theo", phoneNumber: "+12025550123", consentConfirmed: true,
  consentRecordId: "38228ccf-7666-4f38-82e1-613908b1bac0", exclusiveSetupAndPublishersPaused: true,
  expectedWorkerCodeSha256: "gDG48iUTL0fVnMgszuYXObnMS3bZUyfptn6+VAW3MyA=" };
const arn = `${binding.topicArn}:38228ccf-7666-4f38-82e1-613908b1bac0`;
const attributes = (phoneNumber = binding.phoneNumber, memberId = binding.memberId) => ({ Attributes: {
  SubscriptionArn: arn, TopicArn: binding.topicArn, Owner: binding.accountId, Protocol: "sms", Endpoint: phoneNumber,
  PendingConfirmation: "false", FilterPolicy: JSON.stringify({ onDutyMemberId: [memberId] }), FilterPolicyScope: "MessageAttributes",
} });
const listed = (phoneNumber = binding.phoneNumber) => ({ SubscriptionArn: arn, TopicArn: binding.topicArn,
  Owner: binding.accountId, Protocol: "sms", Endpoint: phoneNumber });
function fixture(overrides: Partial<Record<SmsSetupOperation, unknown>> = {}) {
  const values: Record<SmsSetupOperation, unknown> = {
    identity: { Account: binding.accountId, Arn: `arn:aws:sts::${binding.accountId}:assumed-role/${binding.operatorRoleName}/synthetic` },
    worker: { FunctionArn: smsSetupTarget.workerArn, CodeSha256: binding.expectedWorkerCodeSha256, State: "Active",
      LastUpdateStatus: "Successful", Environment: { Variables: { KIN_ESCALATION_WORKER_ENABLED: "false" } } },
    schedule: { State: "DISABLED" }, topic: { Attributes: { TopicArn: binding.topicArn, Owner: binding.accountId } },
    sandbox: { IsInSandbox: true }, sandboxNumbers: { PhoneNumbers: [{ PhoneNumber: binding.phoneNumber, Status: "Verified" }] },
    optOut: { isOptedOut: false }, subscriptions: { Subscriptions: [] }, attributes: attributes(), subscribe: { SubscriptionArn: arn },
    ...overrides,
  };
  const respond = async (operation: SmsSetupOperation) => {
    if (operation === "subscribe") values.subscriptions = { Subscriptions: [listed()] };
    return values[operation];
  };
  const call = vi.fn(async (operation: SmsSetupOperation, _input: Record<string, unknown>, _signal: AbortSignal) => respond(operation));
  const setup = createSmsDestinationSetup({ call });
  return { values, call, setup, respond, approve: () => setup(binding, { mode: "subscribe", approvedBindingDigest: planSmsDestination(binding).bindingDigest }) };
}
const temporary: string[] = [];
beforeEach(() => { vi.mocked(spawn).mockReset().mockImplementation(() => { throw new Error("Real process execution forbidden in SMS tests"); }); });
afterEach(async () => { vi.useRealTimers(); await Promise.all(temporary.splice(0).map(file => rm(file, { recursive: true, force: true }))); });

describe("one-time, explicitly bound SMS setup", () => {
  it("defaults to a redacted local plan and never constructs a transport", () => {
    expect(smsSetupLaunch(["/private/binding.json"])).toEqual({ mode: "plan", file: "/private/binding.json" });
    expect(smsSetupLaunch(["--help"])).toEqual({ mode: "help" });
    const plan = planSmsDestination(binding);
    expect(plan).toMatchObject({ destination: "••••0123", filterPolicy: { onDutyMemberId: ["theo"] },
      publishesMessages: false, changesCareData: false, liveStateVerified: false, routingVerified: false, humanReceiptVerified: false });
    expect(JSON.stringify(plan)).not.toContain(binding.phoneNumber);
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([[], ["relative.json"], ["/private/binding.json", "--subscribe"], ["/private/binding.json", "--inspect", "extra"],
    ["/private/binding.json", "--subscribe", "x".repeat(64)], ["/private/\nbinding.json"]].map(args => ({ args })))("rejects ambiguous arguments $args", ({ args }) => {
    expect(() => smsSetupLaunch(args)).toThrow();
  });
  it.each([{ consentConfirmed: false }, { exclusiveSetupAndPublishersPaused: false }, { accountId: "000000000000" },
    { region: "us-west-2" }, { topicArn: `${binding.topicArn}-other` }, { operatorRoleName: "root" }, { profile: "default" },
    { phoneNumber: "2025550123" }, { memberId: "theo\n" }, { extra: true }])("rejects unapproved or foreign binding %j", patch => {
    expect(() => parseSmsDestinationBinding({ ...binding, ...patch })).toThrow("invalid_sms_binding");
  });
  it.each([{ phoneNumber: "+12025550124" }, { memberId: "maya" }, { profile: "kin-other" },
    { consentRecordId: "b22ddbcf-dc7c-4ee1-aa99-0c470d48efc5" }, { expectedWorkerCodeSha256: "A".repeat(43) + "=" }])(
    "binds approval to every destination and operator input %j", patch => {
      expect(planSmsDestination({ ...binding, ...patch }).bindingDigest).not.toBe(planSmsDestination(binding).bindingDigest);
    });
  it.each([undefined, "0".repeat(64)])("requires exact write approval before any cloud call", async approvedBindingDigest => {
    const f = fixture();
    await expect(f.setup(binding, { mode: "subscribe", approvedBindingDigest })).rejects.toThrow("binding_approval_required");
    expect(f.call).not.toHaveBeenCalled();
  });
  it("inspects without subscribing, publishing, or treating configuration as routing or receipt", async () => {
    const f = fixture();
    expect(await f.setup(binding, { mode: "inspect" })).toMatchObject({ status: "ready_for_approved_subscription", liveStateVerified: true,
      subscriptionRequestAcknowledged: false, routingVerified: false, humanReceiptVerified: false, changesCareData: false });
    expect(f.call.mock.calls.map(([operation]) => operation)).toEqual(["identity", "worker", "schedule", "topic", "optOut", "sandbox", "sandboxNumbers", "subscriptions"]);
  });
  it.each([
    ["identity", { Account: binding.accountId, Arn: `arn:aws:iam::${binding.accountId}:root` }],
    ["identity", { Account: "000000000000", Arn: `arn:aws:sts::${binding.accountId}:assumed-role/KinSmsSetup/synthetic` }],
    ["identity", { Account: binding.accountId, Arn: `arn:aws:sts::${binding.accountId}:assumed-role/KinSmsSetupOther/synthetic` }],
    ["worker", { ...fixture().values.worker as object, CodeSha256: "wrong" }],
    ["worker", { ...fixture().values.worker as object, Environment: { Variables: { KIN_ESCALATION_WORKER_ENABLED: "true" } } }],
    ["worker", { ...fixture().values.worker as object, LastUpdateStatus: "InProgress" }],
    ["schedule", { State: "ENABLED" }], ["topic", { Attributes: { TopicArn: binding.topicArn, Owner: "000000000000" } }],
    ["optOut", { isOptedOut: true }], ["optOut", {}], ["sandbox", {}],
    ["sandboxNumbers", { PhoneNumbers: [{ PhoneNumber: binding.phoneNumber, Status: "Pending" }] }],
    ["sandboxNumbers", { PhoneNumbers: [{ PhoneNumber: binding.phoneNumber, Status: "Verified" }], NextToken: "more" }],
    ["subscriptions", { Subscriptions: [], NextToken: "more" }], ["subscriptions", { Subscriptions: Array.from({ length: 21 }, () => listed()) }],
  ] as const)("fails closed on %s prerequisites", async (operation, value) => {
    const f = fixture({ [operation]: value }); await expect(f.approve()).rejects.toThrow();
    expect(f.call.mock.calls.some(([name]) => name === "subscribe")).toBe(false);
  });
  it.each([{ FilterPolicy: "{}" }, { FilterPolicy: JSON.stringify({ onDutyMemberId: ["theo", "maya"] }) },
    { FilterPolicy: JSON.stringify({ onDutyMemberId: ["theo"], other: ["a"] }) }, { FilterPolicyScope: "MessageBody" },
    { PendingConfirmation: "true" }, { Endpoint: "+12025550124" }, { Owner: "000000000000" }])(
    "refuses unsafe existing subscription instead of repairing it %j", async patch => {
      const f = fixture({ subscriptions: { Subscriptions: [listed()] }, attributes: { Attributes: { ...attributes().Attributes, ...patch } } });
      await expect(f.approve()).rejects.toThrow(); expect(f.call.mock.calls.some(([op]) => op === "subscribe")).toBe(false);
    });
  it("treats a matching subscription as read-only without claiming receipt", async () => {
    const f = fixture({ subscriptions: { Subscriptions: [listed()] } });
    expect(await f.approve()).toMatchObject({ status: "existing_binding_verified", existingSubscription: arn,
      subscriptionRequestAcknowledged: false, routingVerified: false, humanReceiptVerified: false });
    expect(f.call.mock.calls.some(([op]) => op === "subscribe")).toBe(false);
  });
  it("uses the typed directory and documented defaults when optional map attributes are absent", async () => {
    const attrs: Record<string, unknown> = { ...attributes().Attributes };
    for (const key of ["Protocol", "Endpoint", "PendingConfirmation", "FilterPolicyScope"]) delete attrs[key];
    const f = fixture({ attributes: { Attributes: attrs } });
    expect(await f.approve()).toMatchObject({ subscriptionRequestAcknowledged: true, routingVerified: false });
    expect(f.call.mock.calls.filter(([op]) => op === "subscriptions")).toHaveLength(2);
  });
  it.each(["pending confirmation", "PendingConfirmation", `${binding.topicArn}:wrong`, "arn:aws:sns:us-east-1:000000000000:other:38228ccf-7666-4f38-82e1-613908b1bac0"])(
    "does not treat an unconfirmed or foreign Subscribe response as accepted %s", async SubscriptionArn => {
      const f = fixture({ subscribe: { SubscriptionArn } });
      await expect(f.approve()).rejects.toThrow("subscription_outcome_uncertain_keep_publishers_paused_inspect_do_not_retry");
    });
  it("does not accept a missing endpoint/protocol in the authoritative subscription directory", async () => {
    const f = fixture({ subscriptions: { Subscriptions: [{ ...listed(), Endpoint: undefined }] } });
    await expect(f.approve()).rejects.toThrow("subscription_directory_conflict");
    expect(f.call.mock.calls.some(([op]) => op === "subscribe")).toBe(false);
  });
  it.each([
    { subscriptions: { Subscriptions: [listed()] }, attributes: attributes(binding.phoneNumber, "maya") },
    { subscriptions: { Subscriptions: [listed("+12025550124")] }, attributes: attributes("+12025550124") },
    { subscriptions: { Subscriptions: [listed(), listed()] } },
  ])("does not overwrite a phone/member conflict or duplicate", async overrides => {
    const f = fixture(overrides); await expect(f.approve()).rejects.toThrow();
    expect(f.call.mock.calls.some(([op]) => op === "subscribe")).toBe(false);
  });
  it("rechecks pause immediately before one Subscribe with its exact filter supplied initially", async () => {
    const f = fixture(); const result = await f.approve();
    expect(f.call.mock.calls.slice(-6).map(([op]) => op)).toEqual(["identity", "worker", "schedule", "subscribe", "subscriptions", "attributes"]);
    expect(f.call.mock.calls.filter(([op]) => op === "subscribe").map(([, input]) => input)).toEqual([{
      TopicArn: binding.topicArn, Protocol: "sms", Endpoint: binding.phoneNumber, ReturnSubscriptionArn: false,
      Attributes: { FilterPolicy: '{"onDutyMemberId":["theo"]}', FilterPolicyScope: "MessageAttributes" },
    }]);
    expect(result).toMatchObject({ subscriptionRequestAcknowledged: true, routingVerified: false, humanReceiptVerified: false,
      status: "subscription_config_verified_routing_unproven", propagationMayTakeSeconds: 900 });
    expect(JSON.stringify(result)).not.toContain(binding.phoneNumber);
    await expect(f.approve()).rejects.toThrow("setup_busy_or_write_already_attempted");
  });
  it("does not subscribe if the pause changes during inspection", async () => {
    const f = fixture(); let reads = 0;
    f.call.mockImplementation(async op => op === "schedule" && ++reads > 1 ? { State: "ENABLED" } : f.values[op]);
    await expect(f.approve()).rejects.toThrow("schedule_pause_not_verified");
    expect(f.call.mock.calls.some(([op]) => op === "subscribe")).toBe(false);
  });
  it.each(["subscribe", "attributes"] as const)("does not retry uncertain %s or expose provider errors", async failure => {
    const f = fixture(); f.call.mockImplementation(async op => { if (op === failure) throw new Error(`${binding.phoneNumber} secret-provider-details`); return f.respond(op); });
    await expect(f.approve()).rejects.toThrow("subscription_outcome_uncertain_keep_publishers_paused_inspect_do_not_retry");
    await expect(f.approve()).rejects.toThrow("setup_busy_or_write_already_attempted");
    expect(f.call.mock.calls.filter(([op]) => op === "subscribe")).toHaveLength(1);
    f.call.mockImplementation(async op => f.values[op]);
    await expect(f.setup(binding, { mode: "inspect" })).resolves.toMatchObject({ subscriptionRequestAcknowledged: false });
  });
  it("bounds a hung call, keeps the reservation until it settles, and discards its late result", async () => {
    vi.useFakeTimers(); const f = fixture(); let release!: (value: unknown) => void;
    f.call.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const result = f.approve().catch(error => error); await vi.advanceTimersByTimeAsync(1);
    await expect(f.approve()).rejects.toThrow("setup_busy_or_write_already_attempted");
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60_000); expect(settled).toBe(true); expect((await result).message).toBe("setup_aborted");
    await expect(f.setup(binding, { mode: "inspect" })).rejects.toThrow("setup_busy_or_write_already_attempted");
    release(f.values.identity); await vi.advanceTimersByTimeAsync(1);
    expect(f.call).toHaveBeenCalledTimes(1);
    await expect(f.setup(binding, { mode: "inspect" })).resolves.toMatchObject({ subscriptionRequestAcknowledged: false });
  });
  it("treats an aborted Subscribe as uncertain and never lets its late ARN trigger another operation", async () => {
    const f = fixture(), controller = new AbortController(); let release!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.call.mockImplementation(async op => op === "subscribe" ? new Promise(resolve => { release = resolve; started(); }) : f.values[op]);
    const result = f.setup(binding, { mode: "subscribe", approvedBindingDigest: planSmsDestination(binding).bindingDigest, signal: controller.signal }).catch(error => error);
    await entered; controller.abort();
    expect((await result).message).toBe("subscription_outcome_uncertain_keep_publishers_paused_inspect_do_not_retry");
    release({ SubscriptionArn: arn }); await new Promise(resolve => setImmediate(resolve));
    await expect(f.approve()).rejects.toThrow("setup_busy_or_write_already_attempted");
    expect(f.call.mock.calls.at(-1)?.[0]).toBe("subscribe");
  });
});

describe("private CLI boundary", () => {
  it("strips ambient credentials, profile, endpoint overrides and executable injection", () => {
    const environment = smsSetupCliEnvironment({ HOME: "/synthetic", PATH: "/bin", AWS_PROFILE: "other", AWS_CONFIG_FILE: "/other",
      AWS_ACCESS_KEY_ID: "secret", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "secret", AWS_BEARER_TOKEN_BEDROCK: "secret",
      AWS_ENDPOINT_URL: "http://wrong", NODE_OPTIONS: "--require=/wrong", HTTP_PROXY: "http://wrong" });
    expect(environment).toEqual({ HOME: "/synthetic", PATH: "/bin", AWS_EC2_METADATA_DISABLED: "true",
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" });
  });
  it("accepts only a small owner-private regular non-symlink binding file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kin-sms-test-")); temporary.push(directory);
    const file = path.join(directory, "binding.json"), link = path.join(directory, "link.json");
    await writeFile(file, JSON.stringify(binding), { mode: 0o600 });
    expect(await readSmsBinding(file)).toEqual(binding);
    await symlink(file, link); await expect(readSmsBinding(link)).rejects.toThrow();
    await chmod(file, 0o644); await expect(readSmsBinding(file)).rejects.toThrow("invalid_or_nonprivate_binding_file");
    await chmod(file, 0o600); await writeFile(file, "a".repeat(8193)); await expect(readSmsBinding(file)).rejects.toThrow();
  });
  it("keeps numbers out of argv, passes one private JSON file, and removes it after readback", async () => {
    let inputFile = "", captured: unknown, mode = 0;
    vi.mocked(spawn).mockImplementation((_command, args) => {
      inputFile = String(args![3]).replace(/^file:\/\//, ""); captured = JSON.parse(readFileSync(inputFile, "utf8")); mode = statSync(inputFile).mode & 0o777;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => { child.stdout.write('{"isOptedOut":false}'); child.emit("close", 0); });
      return child as unknown as ReturnType<typeof spawn>;
    });
    expect(await smsSetupCliTransport(binding).call("optOut", { phoneNumber: binding.phoneNumber }, new AbortController().signal)).toEqual({ isOptedOut: false });
    expect(captured).toEqual({ phoneNumber: binding.phoneNumber }); expect(mode).toBe(0o600);
    expect(spawn).toHaveBeenCalledWith("/usr/local/bin/aws", expect.arrayContaining(["sns", "check-if-phone-number-is-opted-out", "--profile", binding.profile, "--region", "us-east-1"]), expect.anything());
    expect(JSON.stringify(vi.mocked(spawn).mock.calls[0]?.slice(0, 2))).not.toContain(binding.phoneNumber);
    expect(existsSync(inputFile)).toBe(false); expect(existsSync(path.dirname(inputFile))).toBe(false);
  });
  it.each(["exit-zero", "ignore-term"])("treats timeout as failure when child chooses %s and cleans its input", async behavior => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let inputFile = "", started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const kill = vi.fn((signal: string) => { if (behavior === "exit-zero" || signal === "SIGKILL") queueMicrotask(() => child.emit("close", 0)); return true; });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill });
    vi.mocked(spawn).mockImplementation((_command, args) => { inputFile = String(args![3]).replace(/^file:\/\//, ""); started(); return child as unknown as ReturnType<typeof spawn>; });
    const result = smsSetupCliTransport(binding).call("identity", {}, new AbortController().signal).catch(error => error);
    await entered; await vi.advanceTimersByTimeAsync(12_001);
    expect(await result).toMatchObject({ message: "aws_setup_command_failed" }); expect(kill).toHaveBeenCalledWith("SIGTERM");
    if (behavior === "ignore-term") expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(existsSync(inputFile)).toBe(false);
  });
});
