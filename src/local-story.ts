import express from "express";
import { z } from "zod";
import { calendarDayBounds, shiftCalendarDate } from "./calendar.js";
import { InMemoryCareStore, type CareTask } from "./domain.js";
import { runEscalationSweep } from "./escalation.js";
import { createHttpApp } from "./http.js";
import { conversationBody, proposeConversation, type IntentGenerator } from "./demo-conversation.js";
import { createConversationFocus } from "./conversation-focus.js";
import type { Membership } from "./membership.js";
import { WeeklyBriefService } from "./weekly-brief.js";

export const localStoryStart = "2026-09-08T15:00:00.000Z";
export const localStoryAfterGrace = "2026-09-08T15:31:00.000Z";
const timeZone = "America/Denver";
const storyDate = "2026-09-08";
const graceMinutes = 30;
const advanceBody = z.object({ step: z.literal("after_grace"), confirm: z.literal(true) }).strict();
const storyConversationBody = conversationBody.extend({ allowModel: z.boolean().optional() }).strict();
const modelLimit = 20;
const syntheticCaregiver: Membership = {
  circleId: "local-story", memberId: "theo", name: "Theo", role: "caregiver", status: "active",
};

// Explicit local entry only: never imported by runtime.ts, Lambda, or infrastructure.
// The factory owns its synthetic store and publisher; callers cannot inject a cloud repository.
export function createLocalStoryApp(options: { intentGenerator?: IntentGenerator } = {}) {
  let instant = localStoryStart;
  const now = () => new Date(instant);
  const history: CareTask[] = Array.from({ length: 6 }, (_, index) => {
    const date = shiftCalendarDate(storyDate, index - 6);
    return {
      id: `story-water-${date}`, title: "Drink a glass of water", dueAt: `${date}T15:00:00.000Z`,
      state: "done", lastResponse: "done", confirmedBy: "Evelyn", confirmedAt: `${date}T15:05:00.000Z`,
    };
  });
  const duties = Array.from({ length: 7 }, (_, index) => {
    const date = shiftCalendarDate(storyDate, index);
    return { date, memberId: index % 2 ? "maya" : "theo", memberName: index % 2 ? "Maya" : "Theo", ...calendarDayBounds(date, timeZone) };
  });
  const store = new InMemoryCareStore([...history, {
    id: "morning-water", title: "Drink a glass of water", dueAt: localStoryStart,
    state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null,
  }], now, duties[0]!, timeZone, duties);

  class StoryBrief extends WeeklyBriefService {
    override create(asOf: Date = now()) { return super.create(asOf); }
  }
  const brief = new StoryBrief(store, null, timeZone);
  const notifications: { id: string; recipientMemberName: string | null; status: "simulated" }[] = [];
  let modelRequests = 0;
  let modelPending: Promise<unknown> | null = null;
  const focus = createConversationFocus();
  const publisher = { async publish(record: { id: string; recipientMemberName: string | null }) {
    notifications.push({ id: record.id, recipientMemberName: record.recipientMemberName, status: "simulated" });
    return { messageId: `local-simulation-${notifications.length}` };
  } };
  async function state() {
    const snapshot = await store.today();
    return {
      mode: "local-story" as const, now: instant, timeZone,
      step: instant === localStoryStart ? "check_in" as const : "after_grace" as const,
      graceMinutes,
      conversation: { mode: options.intentGenerator ? "bedrock" : "limited", modelLimit, modelRequests },
      notifications: notifications.map(notification => {
        const alert = snapshot.escalations.find(record => record.id === notification.id);
        return { ...notification, ...(alert?.acknowledgedBy
          ? { acknowledgedBy: alert.acknowledgedBy, acknowledgedAt: alert.acknowledgedAt } : {}) };
      }),
    };
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((request, response, next) => {
    response.set({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    const port = request.socket.localPort;
    const host = request.get("host");
    const origin = request.get("origin");
    const address = request.socket.remoteAddress;
    const loopback = address === "127.0.0.1" || address === "::ffff:127.0.0.1" || address === "::1";
    const trustedHost = !!port && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
    if (!loopback || !trustedHost || (origin !== undefined && origin !== `http://${host}`) || request.get("sec-fetch-site") === "cross-site") {
      response.status(403).json({ error: "local_story_origin_required" }); return;
    }
    next();
  });
  app.use("/demo/story", (request, response, next) => {
    if (request.method === "POST" && !request.is("application/json")) {
      response.status(415).json({ error: "json_required" }); return;
    }
    next();
  });
  app.use("/demo/story/conversation", express.json({ limit: "4kb", strict: true }));
  app.use("/demo/story", express.json({ limit: "1kb", strict: true }));
  app.get("/demo/story", async (_request, response) => { response.json(await state()); });
  // Interpretation only sees synthetic task labels and the submitted message.
  // It can propose a reviewed action, never write care state or publish a message.
  app.post("/demo/story/conversation", async (request, response) => {
    const input = storyConversationBody.safeParse(request.body);
    if (!input.success) { response.status(400).json({ error: "invalid_story_message" }); return; }
    const model = input.data.allowModel === true;
    if (model && !options.intentGenerator) {
      response.status(409).json({ error: "story_model_unavailable", modelRequests }); return;
    }
    if (model && modelPending) { response.status(429).json({ error: "story_conversation_busy", modelRequests }); return; }
    if (model && modelRequests >= modelLimit) { response.status(429).json({ error: "story_model_limit", modelRequests }); return; }
    try {
      const snapshot = await store.today();
      const focusedTaskId = focus.resolve(input.data.contextToken, snapshot);
      // Recheck after the read: two requests may have read the same snapshot.
      if (model && modelPending) { response.status(429).json({ error: "story_conversation_busy", modelRequests }); return; }
      if (model && modelRequests >= modelLimit) { response.status(429).json({ error: "story_model_limit", modelRequests }); return; }
      if (model) modelRequests += 1;
      const attempt = proposeConversation(input.data.message, snapshot, model ? options.intentGenerator : undefined, focusedTaskId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: Awaited<typeof attempt>;
      if (model) {
        // A caller deadline does not cancel a credential process or provider that
        // ignores abort. Keep that attempt reserved until it really settles;
        // local commands stay available, but another paid attempt cannot overlap.
        modelPending = attempt;
        const settled = () => { if (modelPending === attempt) modelPending = null; };
        void attempt.then(settled, settled);
        try {
          result = await Promise.race([attempt, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Story interpretation deadline")), 5000);
            timer.unref?.();
          })]);
        } finally { clearTimeout(timer); }
      } else result = await attempt;
      response.json({ ...result, modelRequests, ...(result.action === "confirm"
        ? { contextToken: focus.remember(result.task.id, result.expected) } : {}) });
    } catch {
      response.status(503).json({ error: "story_conversation_unavailable", modelRequests });
    }
  });
  let sweeping: Promise<unknown> | null = null;
  app.post("/demo/story/advance", async (request, response) => {
    if (!advanceBody.safeParse(request.body).success) { response.status(400).json({ error: "invalid_story_step" }); return; }
    instant = localStoryAfterGrace;
    sweeping ??= (async () => {
      const snapshot = await store.escalationSnapshot(now());
      await runEscalationSweep({ snapshot, store, publisher, now: now(), graceMinutes, attemptId: "local-story-after-grace" });
    })().finally(() => { sweeping = null; });
    await sweeping;
    response.json(await state());
  });
  // The shared caregiver route still performs its existing strict body validation and first-write operation.
  // No header, request body, or query parameter can select a simulated role or identity.
  app.use((request, response, next) => {
    if (request.method === "POST" && /^\/api\/escalations\/[^/]+\/acknowledge$/.test(request.path)) {
      response.locals.member = { ...syntheticCaregiver };
    }
    next();
  });
  app.use(createHttpApp(store, brief));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
    if (type === "entity.too.large") { response.status(413).json({ error: "story_body_too_large" }); return; }
    if (type === "entity.parse.failed") { response.status(400).json({ error: "invalid_json" }); return; }
    response.status(500).json({ error: "local_story_unavailable" });
  });
  return app;
}
