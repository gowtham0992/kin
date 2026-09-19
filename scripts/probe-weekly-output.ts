// Explicit opt-in, synthetic-only Bedrock reproduction. Never reads care storage.
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { createHash } from "node:crypto";
import { BedrockBriefGenerator, type WeeklyBriefSource } from "../src/weekly-brief.js";

if (process.env.KIN_SYNTHETIC_MODEL_PROBE !== "true") throw new Error("Synthetic probe requires explicit opt-in");
const source: WeeklyBriefSource = {
  period: { startDate: "2026-09-12", endDate: "2026-09-18" },
  stats: { scheduled: 14, completed: 2, skipped: 0, stillOpen: 12, escalations: 2 },
  evidence: Array.from({ length: 14 }, (_, i) => ({
    id: `task:care-${createHash("sha1").update(`synthetic-${i}`).digest("hex")}:2026-09-17T${String(i + 10).padStart(2, "0")}:00:00.000Z`,
    kind: "care_task" as const,
    occurredAt: "2026-09-17T18:00:00.000Z",
    fact: `Synthetic task ${i + 1} was ${i < 2 ? "completed" : "still open"}.`,
  })),
};
source.evidence.push(...[0, 1].map(i => ({
  id: `escalation:missed_care-${createHash("sha1").update(`synthetic-${i}`).digest("hex")}_2026-09-17T18:00:00.000Z`,
  kind: "escalation" as const, occurredAt: "2026-09-17T18:00:00.000Z", acknowledged: i === 0,
  fact: `A synthetic family follow-up was sent to the on-duty caregiver.${i === 0 ? " A caregiver acknowledged it." : ""}`,
})));
const client = new BedrockRuntimeClient({ region: "us-east-1", maxAttempts: 1, credentials: fromIni({ profile: "kin-dev" }) });
const generator = new BedrockBriefGenerator({ modelId: "amazon.nova-micro-v1:0", timeoutMs: 5000,
  client: { send: async (command, options) => {
    const result = await client.send(command, options);
    // This command contains only the synthetic source above, never family data.
    console.log(JSON.stringify({ stopReason: result.stopReason, usage: result.usage, content: result.output?.message?.content }));
    return result;
  } },
});
try {
  const result = await generator.generate(source);
  console.log(JSON.stringify({ result: "validated", generation: result.generation }));
} catch (error) {
  console.log(JSON.stringify({ result: "rejected", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown" }));
  process.exitCode = 1;
} finally { client.destroy(); }
