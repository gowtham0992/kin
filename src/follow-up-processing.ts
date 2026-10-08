import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export type FollowUpProcessing = { state: "off" | "configured" | "unknown"; checkedAt?: string; source?: "deployment_configuration" };
export type FollowUpProcessingProvider = () => Promise<FollowUpProcessing>;

/** Deployment configuration is not worker health or evidence of phone delivery. */
export function createFollowUpProcessingProvider(input: {
  parameterName: string; region?: string; now?: () => Date;
  client?: { send(command: GetParameterCommand, options?: { abortSignal?: AbortSignal }): Promise<{ Parameter?: { Value?: string } }> };
}): FollowUpProcessingProvider {
  const client = input.client ?? new SSMClient({ region: input.region, maxAttempts: 1 });
  const now = input.now ?? (() => new Date());
  let cached: { value: FollowUpProcessing; expiresAt: number } | undefined;
  let pending: Promise<FollowUpProcessing> | undefined;
  return async () => {
    if (cached && now().getTime() < cached.expiresAt) return { ...cached.value };
    pending ??= Promise.resolve().then(async (): Promise<FollowUpProcessing> => {
      try {
        const response = await client.send(new GetParameterCommand({ Name: input.parameterName }), { abortSignal: AbortSignal.timeout(800) });
        const value = JSON.parse(response.Parameter?.Value ?? "null");
        if (value?.version !== 1 || !["true", "false"].includes(value.worker) || !["true", "false"].includes(value.schedule)) return { state: "unknown" };
        const checked = now();
        const result: FollowUpProcessing = { state: value.worker === "true" && value.schedule === "true" ? "configured" : "off",
          checkedAt: checked.toISOString(), source: "deployment_configuration" };
        cached = { value: result, expiresAt: checked.getTime() + 15_000 };
        return result;
      } catch { return { state: "unknown" }; }
    }).finally(() => { pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // abortSignal does not bound credential lookup. Keep a stalled operation
      // in flight (no overlapping reads), but never stall the family page.
      return { ...await Promise.race([pending, new Promise<FollowUpProcessing>(resolve => {
        timer = setTimeout(() => resolve({ state: "unknown" }), 800);
      })]) };
    } finally { clearTimeout(timer); }
  };
}

export async function followUpProcessing(provider?: FollowUpProcessingProvider): Promise<FollowUpProcessing> {
  try { return provider ? await provider() : { state: "unknown" }; }
  catch { return { state: "unknown" }; }
}
