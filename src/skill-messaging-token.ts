import { z } from "zod";
import { ReminderSyncUnavailable } from "./echo-reminder-sync.js";

const credentialsSchema = z.object({ clientId: z.string().min(16).max(1024), clientSecret: z.string().min(32).max(4096) }).strict();
const tokenSchema = z.object({ access_token: z.string().min(1).max(2048).refine(v => !/[\s\p{Cc}]/u.test(v)),
  token_type: z.literal("bearer"), expires_in: z.number().int().min(61).max(86400), scope: z.literal("alexa:skill_messaging") });

/** Credentials and short-lived tokens stay in process memory, never in reminder records. */
export function createSkillMessagingToken(options: { credentials: () => Promise<unknown>; fetch?: typeof fetch; now?: () => number }) {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  const load = async () => {
    try {
      const credentials = credentialsSchema.parse(await options.credentials());
      const started = now();
      const response = await request("https://api.amazon.com/auth/o2/token", { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(2500), headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "alexa:skill_messaging", client_id: credentials.clientId, client_secret: credentials.clientSecret }).toString() });
      if (response.status !== 200) { await response.body?.cancel(); throw new ReminderSyncUnavailable(); }
      const reader = response.body?.getReader();
      if (!reader) throw new ReminderSyncUnavailable();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength; if (length > 8192) throw new ReminderSyncUnavailable();
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const token = tokenSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const expires = started + token.expires_in * 1000 - 60_000;
      if (expires <= now()) throw new ReminderSyncUnavailable();
      cached = { token: token.access_token, expires };
      return cached.token;
    } catch { throw new ReminderSyncUnavailable(); }
  };
  return async () => {
    if (cached && cached.expires > now()) return cached.token;
    pending ??= load().finally(() => { pending = undefined; });
    return pending;
  };
}
