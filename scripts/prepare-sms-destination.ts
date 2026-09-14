import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSmsDestinationSetup, parseSmsDestinationBinding, planSmsDestination, SmsSetupError,
  type SmsDestinationBinding, type SmsSetupOperation, type SmsSetupTransport } from "../src/sms-destination-setup.js";

const operations: Record<SmsSetupOperation, [string, string]> = {
  identity: ["sts", "get-caller-identity"], worker: ["lambda", "get-function-configuration"],
  schedule: ["scheduler", "get-schedule"], topic: ["sns", "get-topic-attributes"],
  sandbox: ["sns", "get-sms-sandbox-account-status"], sandboxNumbers: ["sns", "list-sms-sandbox-phone-numbers"],
  optOut: ["sns", "check-if-phone-number-is-opted-out"], subscriptions: ["sns", "list-subscriptions-by-topic"],
  attributes: ["sns", "get-subscription-attributes"], subscribe: ["sns", "subscribe"],
};
export function smsSetupLaunch(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" as const };
  if (!args[0] || !path.isAbsolute(args[0]) || /[\u0000-\u001f\u007f]/.test(args[0])) throw new SmsSetupError("absolute_private_binding_file_required");
  if (args.length === 1) return { mode: "plan" as const, file: args[0] };
  if (args.length === 2 && args[1] === "--inspect") return { mode: "inspect" as const, file: args[0] };
  if (args.length === 3 && args[1] === "--subscribe" && /^[a-f0-9]{64}$/.test(args[2]!)) {
    return { mode: "subscribe" as const, file: args[0], approvedBindingDigest: args[2] };
  }
  throw new SmsSetupError("unsupported_sms_setup_arguments");
}
export async function readSmsBinding(file: string) {
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size > 8192 || info.size < 2 || (info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid())) throw new SmsSetupError("binding_file_must_be_private_and_small");
    const bytes = Buffer.alloc(8193);
    const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192) throw new SmsSetupError("binding_file_too_large");
    return parseSmsDestinationBinding(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } catch { throw new SmsSetupError("invalid_or_nonprivate_binding_file"); }
  finally { await descriptor.close(); }
}
export function smsSetupCliEnvironment(environment: NodeJS.ProcessEnv) {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"];
  return { ...Object.fromEntries(keep.filter(key => environment[key] !== undefined).map(key => [key, environment[key]])),
    AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true", AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" };
}
export function smsSetupCliTransport(binding: SmsDestinationBinding): SmsSetupTransport {
  const environment = smsSetupCliEnvironment(process.env);
  return { async call(operation, input, signal) {
    if (!Object.hasOwn(operations, operation) || signal.aborted) throw new SmsSetupError("setup_aborted_or_unknown_operation");
    // Phone numbers never enter argv, a shell, source, care data, or logs.
    const directory = await mkdtemp(path.join(tmpdir(), "kin-sms-input-"));
    const file = path.join(directory, "request.json");
    try {
      await writeFile(file, JSON.stringify(input), { mode: 0o600, flag: "wx" });
      if (signal.aborted) throw new SmsSetupError("setup_aborted");
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn("/usr/local/bin/aws", [...operations[operation], "--cli-input-json", `file://${file}`,
          "--profile", binding.profile, "--region", binding.region, "--output", "json", "--no-paginate", "--no-cli-pager",
          "--no-cli-auto-prompt", "--cli-connect-timeout", "3", "--cli-read-timeout", "8"],
        { env: environment, stdio: ["ignore", "pipe", "pipe"] });
        let output = "", size = 0, stopping = false, done = false, killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
          if (done || stopping) return; stopping = true; child.kill("SIGTERM");
          killTimer = setTimeout(() => { if (!done) child.kill("SIGKILL"); }, 2000);
        };
        signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
        const timer = setTimeout(stop, 10_000);
        const finish = () => { done = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", stop); };
        child.stdout.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) stop(); else output += chunk; });
        child.stderr.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) stop(); });
        child.on("error", () => { finish(); reject(new SmsSetupError("aws_setup_command_failed")); });
        child.on("close", code => { finish(); if (code !== 0 || stopping) reject(new SmsSetupError("aws_setup_command_failed")); else resolve(output); });
      });
      try { return JSON.parse(result); } catch { throw new SmsSetupError("invalid_aws_response"); }
    } finally { await rm(file, { force: true }); await rmdir(directory); }
  } };
}
async function main() {
  process.umask(0o077);
  const options = smsSetupLaunch(process.argv.slice(2));
  if (options.mode === "help") {
    console.log("node --import tsx scripts/prepare-sms-destination.ts /absolute/private-binding.json [--inspect | --subscribe APPROVED_BINDING_SHA256]");
    console.log("Default: local redacted plan, no AWS. Inspect: read-only AWS. Subscribe: one explicitly approved filtered subscription; no Publish, OTP, eligibility or worker changes.");
    return;
  }
  const binding = await readSmsBinding(options.file);
  if (options.mode === "plan") { console.log(JSON.stringify(planSmsDestination(binding), null, 2)); return; }
  const controller = new AbortController(), stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const result = await createSmsDestinationSetup(smsSetupCliTransport(binding))(binding, {
      mode: options.mode, approvedBindingDigest: options.mode === "subscribe" ? options.approvedBindingDigest : undefined,
      signal: controller.signal,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({ status: "stopped", code: error instanceof SmsSetupError ? error.code : "sms_setup_failed",
      instruction: "Keep publishers paused. Inspect any uncertain subscription; do not retry a write or print raw AWS errors." }));
    process.exitCode = 1;
  });
}
