import { createHash } from "node:crypto";
import { z } from "zod";

// One-time operator setup, not preferences, delivery, or a care-table migration.
export const smsSetupTarget = {
  accountId: "954807518512", region: "us-east-1",
  topicArn: "arn:aws:sns:us-east-1:954807518512:kin-care-alerts",
  workerArn: "arn:aws:lambda:us-east-1:954807518512:function:kin-escalation-worker",
} as const;
const memberId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const bindingSchema = z.object({
  schemaVersion: z.literal(1), accountId: z.literal(smsSetupTarget.accountId),
  region: z.literal(smsSetupTarget.region), topicArn: z.literal(smsSetupTarget.topicArn),
  profile: z.string().regex(/^kin-[A-Za-z0-9_-]{1,60}$/),
  operatorRoleName: z.string().regex(/^Kin[A-Za-z0-9_-]{1,61}$/),
  memberId, phoneNumber: phone, consentConfirmed: z.literal(true),
  consentRecordId: z.string().uuid(), exclusiveSetupAndPublishersPaused: z.literal(true),
  expectedWorkerCodeSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
}).strict();
export type SmsDestinationBinding = z.infer<typeof bindingSchema>;
export class SmsSetupError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SmsSetupError"; }
}
function requireCondition(value: unknown, code: string): asserts value { if (!value) throw new SmsSetupError(code); }
export function parseSmsDestinationBinding(input: unknown): SmsDestinationBinding {
  const parsed = bindingSchema.safeParse(input);
  if (!parsed.success) throw new SmsSetupError("invalid_sms_binding");
  return parsed.data;
}
const filter = (id: string) => ({ onDutyMemberId: [id] });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function planSmsDestination(input: unknown) {
  const binding = parseSmsDestinationBinding(input);
  return { mode: "plan", bindingDigest: digest(binding), accountId: binding.accountId, region: binding.region,
    topicArn: binding.topicArn, profile: binding.profile, operatorRoleName: binding.operatorRoleName,
    memberId: binding.memberId, destination: `••••${binding.phoneNumber.slice(-4)}`,
    filterPolicy: filter(binding.memberId), filterPolicyScope: "MessageAttributes",
    createsSubscriptionOnly: true, publishesMessages: false, changesCareData: false,
    liveStateVerified: false, routingVerified: false, humanReceiptVerified: false,
    memberIdentityVerified: false, allPublishersQuiescentVerified: false,
    propagationMayTakeSeconds: 900 };
}

export type SmsSetupOperation = "identity" | "worker" | "schedule" | "topic" | "sandbox" | "sandboxNumbers"
  | "optOut" | "subscriptions" | "attributes" | "subscribe";
export interface SmsSetupTransport {
  call(operation: SmsSetupOperation, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
const object = z.record(z.string(), z.unknown());
function record(input: unknown) {
  const result = object.safeParse(input);
  if (!result.success) throw new SmsSetupError("invalid_aws_response");
  return result.data;
}
function subscriptionArn(value: unknown, binding: SmsDestinationBinding): asserts value is string {
  requireCondition(typeof value === "string" && value.startsWith(`${binding.topicArn}:`)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.slice(binding.topicArn.length + 1)), "invalid_subscription_arn");
}

// A factory keeps an unsettled/uncertain Subscribe from being retried in-process.
// Separate operators/processes must honor the explicit exclusive-setup agreement.
export function createSmsDestinationSetup(transport: SmsSetupTransport) {
  let running = false, pending = false, writeAttempted = false;
  return async (input: unknown, options: { mode: "inspect" | "subscribe"; approvedBindingDigest?: string; signal?: AbortSignal }) => {
    const binding = parseSmsDestinationBinding(input), plan = planSmsDestination(binding);
    requireCondition(options.mode === "inspect" || options.mode === "subscribe", "invalid_setup_mode");
    if (options.mode === "subscribe") requireCondition(options.approvedBindingDigest === plan.bindingDigest, "binding_approval_required");
    requireCondition(!running && !pending && (options.mode !== "subscribe" || !writeAttempted), "setup_busy_or_write_already_attempted");
    running = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, 60_000);
    let attemptedHere = false;
    async function call(operation: SmsSetupOperation, data: Record<string, unknown>) {
      controller.signal.throwIfAborted();
      let abortCall!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortCall = () => reject(new SmsSetupError("setup_aborted"));
        controller.signal.addEventListener("abort", abortCall, { once: true });
      });
      pending = true;
      const request = Promise.resolve().then(() => {
        controller.signal.throwIfAborted(); return transport.call(operation, data, controller.signal);
      }).finally(() => { pending = false; });
      try {
        const result = await Promise.race([request, aborted]);
        controller.signal.throwIfAborted(); return record(result);
      } finally { controller.signal.removeEventListener("abort", abortCall); }
    }
    async function identityAndPause() {
      const identity = await call("identity", {});
      requireCondition(identity.Account === binding.accountId && typeof identity.Arn === "string"
        && identity.Arn.startsWith(`arn:aws:sts::${binding.accountId}:assumed-role/${binding.operatorRoleName}/`), "operator_identity_mismatch");
      const worker = await call("worker", { FunctionName: "kin-escalation-worker" });
      const variables = record(record(worker.Environment).Variables);
      requireCondition(worker.FunctionArn === smsSetupTarget.workerArn && worker.CodeSha256 === binding.expectedWorkerCodeSha256
        && worker.State === "Active" && worker.LastUpdateStatus === "Successful" && variables.KIN_ESCALATION_WORKER_ENABLED === "false", "worker_pause_not_verified");
      requireCondition((await call("schedule", { Name: "kin-escalation-sweep", GroupName: "default" })).State === "DISABLED", "schedule_pause_not_verified");
    }
    async function attributes(arn: string, expectedPhone: string, expectedMember?: string) {
      const attrs = record((await call("attributes", { SubscriptionArn: arn })).Attributes);
      requireCondition(attrs.SubscriptionArn === arn && attrs.TopicArn === binding.topicArn && attrs.Owner === binding.accountId
        && (attrs.Protocol === undefined || attrs.Protocol === "sms") && (attrs.Endpoint === undefined || attrs.Endpoint === expectedPhone)
        && (attrs.PendingConfirmation === undefined || attrs.PendingConfirmation === "false"), "subscription_binding_mismatch");
      let policy: unknown;
      try { policy = JSON.parse(String(attrs.FilterPolicy)); } catch { throw new SmsSetupError("subscription_filter_mismatch"); }
      const parsed = z.object({ onDutyMemberId: z.tuple([memberId]) }).strict().safeParse(policy);
      requireCondition(parsed.success && (attrs.FilterPolicyScope === undefined || attrs.FilterPolicyScope === "MessageAttributes"), "subscription_filter_mismatch");
      const id = parsed.data.onDutyMemberId[0];
      if (expectedMember) requireCondition(id === expectedMember, "subscription_filter_mismatch");
      return id;
    }
    async function inspectDirectory() {
      const subscriptions = await call("subscriptions", { TopicArn: binding.topicArn });
      requireCondition(!subscriptions.NextToken && Array.isArray(subscriptions.Subscriptions)
        && subscriptions.Subscriptions.length <= 20, "subscription_list_incomplete_or_too_large");
      const destinations = new Set<string>(), members = new Set<string>(); let existing: string | undefined;
      for (const raw of subscriptions.Subscriptions) {
        const item = record(raw), arn = item.SubscriptionArn;
        subscriptionArn(arn, binding);
        requireCondition(item.Owner === binding.accountId && item.TopicArn === binding.topicArn && item.Protocol === "sms"
          && typeof item.Endpoint === "string" && phone.safeParse(item.Endpoint).success && !destinations.has(item.Endpoint), "subscription_directory_conflict");
        destinations.add(item.Endpoint);
        const id = await attributes(arn, item.Endpoint);
        requireCondition(!members.has(id), "subscription_directory_conflict"); members.add(id);
        if (item.Endpoint === binding.phoneNumber || id === binding.memberId) {
          requireCondition(item.Endpoint === binding.phoneNumber && id === binding.memberId, "destination_or_member_already_bound");
          existing = arn;
        }
      }
      requireCondition(existing || subscriptions.Subscriptions.length < 20, "subscription_directory_at_capacity");
      return existing;
    }
    try {
      await identityAndPause();
      const topic = record((await call("topic", { TopicArn: binding.topicArn })).Attributes);
      requireCondition(topic.TopicArn === binding.topicArn && topic.Owner === binding.accountId, "topic_binding_mismatch");
      requireCondition((await call("optOut", { phoneNumber: binding.phoneNumber })).isOptedOut === false, "destination_opted_out_or_unknown");
      const sandbox = await call("sandbox", {});
      requireCondition(typeof sandbox.IsInSandbox === "boolean", "sandbox_status_unknown");
      if (sandbox.IsInSandbox) {
        const numbers = await call("sandboxNumbers", { MaxResults: 100 });
        requireCondition(!numbers.NextToken && Array.isArray(numbers.PhoneNumbers), "sandbox_list_incomplete");
        requireCondition(numbers.PhoneNumbers.some(value => {
          const item = record(value); return item.PhoneNumber === binding.phoneNumber && item.Status === "Verified";
        }), "sandbox_destination_unverified");
      }
      const existing = await inspectDirectory();
      if (options.mode === "inspect" || existing) return { ...plan, mode: options.mode, status: existing ? "existing_binding_verified" : "ready_for_approved_subscription",
        liveStateVerified: true, existingSubscription: existing ?? null, subscriptionRequestAcknowledged: false, sandbox: sandbox.IsInSandbox };
      // Readback does not make SNS filtering instantaneous. No Publish exists here.
      await identityAndPause();
      writeAttempted = attemptedHere = true;
      const result = await call("subscribe", { TopicArn: binding.topicArn, Protocol: "sms", Endpoint: binding.phoneNumber,
        Attributes: { FilterPolicy: JSON.stringify(filter(binding.memberId)), FilterPolicyScope: "MessageAttributes" }, ReturnSubscriptionArn: false });
      const arn = result.SubscriptionArn; subscriptionArn(arn, binding);
      // Directory fields bind the endpoint/protocol even when optional map attributes are absent.
      requireCondition(await inspectDirectory() === arn, "subscription_readback_missing");
      return { ...plan, mode: "subscribe", status: "subscription_config_verified_routing_unproven", liveStateVerified: true,
        subscriptionRequestAcknowledged: true, subscriptionArn: arn, sandbox: sandbox.IsInSandbox };
    } catch (error) {
      // Neither raw provider messages nor endpoint values cross this boundary.
      if (attemptedHere) throw new SmsSetupError("subscription_outcome_uncertain_keep_publishers_paused_inspect_do_not_retry");
      throw error instanceof SmsSetupError ? error : new SmsSetupError(controller.signal.aborted ? "setup_aborted" : "setup_inspection_failed");
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); running = false;
    }
  };
}
