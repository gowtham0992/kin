import {
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { createDemoStore, InMemoryCareStore, type CareTask } from "../src/domain.js";
import type { EscalationSummary } from "../src/escalation.js";
import {
  BedrockBriefGenerator,
  type BriefGenerator,
  WeeklyBriefService,
} from "../src/weekly-brief.js";

const asOf = new Date("2026-09-02T18:00:00.000Z");
const fixedNow = () => asOf;

function recordedTask(id: string, dueAt: string, state: CareTask["state"] = "scheduled"): CareTask {
  return { id, title: id, dueAt, state, lastResponse: null, confirmedBy: null, confirmedAt: null };
}

type RoutedSummary = EscalationSummary & { recipientMemberId?: string | null; sentAt?: string | null };
function routedAlert(id: string, overrides: Partial<RoutedSummary> = {}): RoutedSummary {
  return { id, taskId: `task-${id}`, dueAt: "2026-09-02T15:00:00.000Z", updatedAt: "2026-09-02T15:00:00.000Z",
    recipientMemberId: "theo", recipientMemberName: "Theo", status: "queued", ...overrides };
}
function storeWithAlerts(escalations: RoutedSummary[]) {
  const store = new InMemoryCareStore([], fixedNow);
  // The repository boundary supplies recorded facts; all summary/model logic is real.
  store.activityBetween = async period => ({ ...period, tasks: [], escalations: structuredClone(escalations) });
  return store;
}

describe("weekly responsibility facts", () => {
  it("counts frozen routing separately from provider acceptance and never assigns an unrouted alert", async () => {
    const brief = await new WeeklyBriefService(storeWithAlerts([
      routedAlert("theo-queued"), routedAlert("theo-failed", { status: "failed" }),
      routedAlert("maya-sent", { recipientMemberId: "maya", recipientMemberName: "Maya", status: "sent", sentAt: "2026-09-02T16:00:00.000Z" }),
      routedAlert("blocked", { status: "blocked", recipientMemberId: null, recipientMemberName: null }),
      routedAlert("legacy", { recipientMemberId: undefined, recipientMemberName: "Theo" }),
    ])).create(asOf);

    expect(brief.responsibility).toMatchObject({ routedTotal: 3, unroutedTotal: 1, unattributedTotal: 1,
      providerAccepted: 1, acceptanceNotRecorded: 3,
      routed: [
        { memberId: "theo", memberName: "Theo", count: 2, evidenceIds: ["escalation:theo-failed", "escalation:theo-queued"] },
        { memberId: "maya", memberName: "Maya", count: 1, evidenceIds: ["escalation:maya-sent"] },
      ] });
    expect(brief.responsibility.points[0]).toEqual({ text: "Alerts routed: Theo 2 · Maya 1.",
      evidenceIds: ["escalation:theo-failed", "escalation:theo-queued", "escalation:maya-sent"] });
    expect(brief.responsibility.notice).toMatch(/not.*delivery.*caregiving effort/i);
    expect(brief.evidence.find(item => item.id === "escalation:maya-sent")?.fact).toContain("Recorded recipient: Maya.");
    expect(brief.evidence.find(item => item.id === "escalation:maya-sent")?.fact).toContain("Messaging service accepted it at 2026-09-02T16:00:00.000Z");
  });

  it("measures acknowledgments from stable acceptance time, including exactly fifteen minutes", async () => {
    const brief = await new WeeklyBriefService(storeWithAlerts([
      routedAlert("zero", { status: "sent", sentAt: "2026-09-02T16:00:00.000Z", acknowledgedAt: "2026-09-02T16:00:00.000Z" }),
      routedAlert("boundary", { status: "sent", sentAt: "2026-09-02T16:00:00.000Z", acknowledgedAt: "2026-09-02T16:15:00.000Z" }),
      routedAlert("late", { status: "sent", sentAt: "2026-09-02T16:00:00.000Z", acknowledgedAt: "2026-09-02T16:15:00.001Z", updatedAt: "2026-09-02T16:15:00.001Z" }),
    ])).create(asOf);

    expect(brief.responsibility.acknowledgment).toEqual({ withinMinutes: 15, withinWindow: 2, eligible: 3,
      pending: 0, timingUnavailable: 0, evidenceIds: ["escalation:boundary", "escalation:late", "escalation:zero"] });
    expect(brief.responsibility.points.some(point => point.text.includes("Acknowledged within 15 minutes of messaging-service acceptance: 2 of 3"))).toBe(true);
  });

  it("does not invent acceptance timing from legacy updatedAt, dueAt, or an unsent acknowledgment", async () => {
    const brief = await new WeeklyBriefService(storeWithAlerts([
      routedAlert("legacy-sent", { status: "sent", updatedAt: "2026-09-02T16:00:00.000Z", acknowledgedAt: "2026-09-02T16:01:00.000Z" }),
      routedAlert("queued-ack", { acknowledgedAt: "2026-09-02T15:01:00.000Z" }),
    ])).create(asOf);

    expect(brief.responsibility.acknowledgment).toMatchObject({ eligible: 0, withinWindow: 0, pending: 0, timingUnavailable: 1 });
    expect(brief.responsibility.points.some(point => point.text.includes("timing unavailable for 1 provider-accepted follow-up"))).toBe(true);
  });

  it("keeps recent unanswered acceptances pending and excludes impossible or future timing from prompt counts", async () => {
    const brief = await new WeeklyBriefService(storeWithAlerts([
      routedAlert("recent", { status: "sent", sentAt: "2026-09-02T17:59:59.999Z" }),
      routedAlert("mature", { status: "sent", sentAt: "2026-09-02T17:45:00.000Z" }),
      routedAlert("before", { status: "sent", sentAt: "2026-09-02T17:00:00.000Z", acknowledgedAt: "2026-09-02T16:59:59.999Z" }),
      routedAlert("future-ack", { status: "sent", sentAt: "2026-09-02T17:59:00.000Z", acknowledgedAt: "2026-09-02T18:00:00.001Z" }),
      routedAlert("invalid", { status: "sent", sentAt: "not-a-date" }),
      routedAlert("future-send", { status: "sent", sentAt: "2026-09-02T18:00:00.001Z" }),
    ])).create(asOf);

    expect(brief.responsibility.acknowledgment).toMatchObject({ eligible: 4, withinWindow: 0, pending: 1, timingUnavailable: 4 });
    expect(brief.responsibility.points.some(point => point.text.includes("1 recent follow-up is still within its 15-minute window"))).toBe(true);
  });

  it("keeps same-named recipients separate and uses the latest frozen name deterministically", async () => {
    const alerts = [routedAlert("older", { recipientMemberName: "Old name" }),
      routedAlert("newer", { dueAt: "2026-09-02T16:00:00.000Z", recipientMemberName: "Sam" }),
      routedAlert("other", { recipientMemberId: "other-sam", recipientMemberName: "Sam" })];
    const service = (rows: RoutedSummary[]) => new WeeklyBriefService(storeWithAlerts(rows)).create(asOf);
    const first = await service(alerts), reversed = await service([...alerts].reverse());

    expect(first.responsibility.routed).toEqual([
      { memberId: "theo", memberName: "Sam", count: 2, evidenceIds: ["escalation:newer", "escalation:older"] },
      { memberId: "other-sam", memberName: "Sam", count: 1, evidenceIds: ["escalation:other"] },
    ]);
    expect(reversed.responsibility).toEqual(first.responsibility);
  });

  it("returns zero responsibility without a model call and rejects duplicate routing evidence", async () => {
    const generate = vi.fn<BriefGenerator["generate"]>();
    const empty = await new WeeklyBriefService(storeWithAlerts([]), { generate }).create(asOf);
    expect(empty.responsibility).toMatchObject({ routed: [], routedTotal: 0, providerAccepted: 0,
      acknowledgment: { eligible: 0, withinWindow: 0, pending: 0, timingUnavailable: 0 } });
    expect(generate).not.toHaveBeenCalled();
    await expect(new WeeklyBriefService(storeWithAlerts([routedAlert("duplicate"), routedAlert("duplicate")])).create(asOf))
      .rejects.toThrow("Duplicate follow-up evidence");
  });

  it("adds responsibility facts after model selection without sending frozen identities to Bedrock", async () => {
    const send = vi.fn(async (_command: ConverseCommand) => ({ stopReason: "end_turn", output: { message: {
      role: "assistant", content: [{ text: JSON.stringify({ overviewEvidenceIds: ["escalation:model"],
        highlightEvidenceIds: ["escalation:model"], followUps: [] }) }],
    } } } as ConverseCommandOutput));
    const brief = await new WeeklyBriefService(storeWithAlerts([routedAlert("model", {
      recipientMemberId: "private-member-id", recipientMemberName: "Private name", status: "sent", sentAt: "2026-09-02T16:00:00.000Z",
    })]), new BedrockBriefGenerator({ client: { send }, modelId: "synthetic-model" })).create(asOf);

    expect(brief.generatedBy).toBe("bedrock");
    expect(brief.responsibility.routed[0]).toMatchObject({ memberId: "private-member-id", memberName: "Private name", count: 1 });
    const sentSource = send.mock.calls[0]![0].input.messages![0]!.content![0]!.text!;
    expect(sentSource).not.toMatch(/Private name|private-member-id|responsibility|sentAt/);
    expect(brief.evidence[0]?.fact).toContain("Recorded recipient: Private name.");
    const ids = new Set(brief.evidence.map(fact => fact.id));
    expect(brief.responsibility.points.every(point => point.evidenceIds.every(id => ids.has(id)))).toBe(true);
  });
});

describe("WeeklyBriefService", () => {
  it("uses correct number agreement for zero, one, and multiple recorded tasks", async () => {
    for (const count of [0, 1, 2]) {
      const tasks = Array.from({ length: count }, (_, index) => recordedTask(`task-${index}`, "2026-09-02T15:00:00.000Z", "done"));
      const brief = await new WeeklyBriefService(new InMemoryCareStore(tasks, fixedNow)).create(asOf);
      if (count === 0) {
        expect(brief.overview).toBe("Kin has no recorded tasks or family follow-ups for this seven-day period.");
        expect(brief.highlights).toEqual([]);
      } else {
        expect(brief.overview).toContain(`Kin recorded ${count} care ${count === 1 ? "task (" : "tasks ("}`);
        expect(brief.highlights[0]?.text).toBe(`${count} of ${count} recorded care ${count === 1 ? "task was" : "tasks were"} completed.`);
      }
    }
  });

  it("records a not-yet reply as a reply, without describing its family follow-up as a missed task", async () => {
    const store = createDemoStore(fixedNow);
    await store.confirm({ taskId: "morning-water", response: "not_yet", actor: "Evelyn", requestId: "brief-not-yet-1" });
    await store.queueEscalation({ taskId: "morning-water", taskTitle: "Drink a glass of water", dueAt: "2026-09-02T15:00:00.000Z", reason: "no_active_duty_assignment",
      responseState: "not_yet", responseRecordedAt: fixedNow().toISOString() });

    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.stats.stillOpen).toBe(1);
    expect(brief.evidence.find(item => item.kind === "care_task")?.fact).toBe(
      'A "not yet" reply was recorded for Drink a glass of water; the task was still open.',
    );
    expect(brief.evidence.find(item => item.kind === "escalation")?.fact).toBe(
      "A family follow-up was blocked because no caregiver was on duty.",
    );
    expect(brief.overview).toContain("1 family follow-up");
    expect(brief.highlights.map(point => point.text)).toContain("1 family follow-up was recorded.");
    expect(brief.followUps.map(point => point.text)).toContain("Ask a caregiver to acknowledge the follow-up.");
    expect(JSON.stringify(brief)).not.toContain("missed-task");
  });

  it("records caregiver acknowledgment and selects an unacknowledged follow-up instead", async () => {
    const first = recordedTask("first", "2026-09-02T15:00:00.000Z", "done");
    const second = recordedTask("second", "2026-09-02T16:00:00.000Z", "done");
    const store = new InMemoryCareStore([first, second].map(task => ({ ...task, state: "scheduled", lastResponse: null,
      confirmedAt: null, confirmedBy: null })), fixedNow);
    const { record: acknowledged } = (await store.queueEscalation({ taskId: first.id, taskTitle: first.title, dueAt: first.dueAt, reason: "no_active_duty_assignment" }))!;
    const { record: pending } = (await store.queueEscalation({ taskId: second.id, taskTitle: second.title, dueAt: second.dueAt, reason: "no_active_duty_assignment" }))!;
    for (const task of [first, second]) await store.confirm({ taskId: task.id, response: "done", actor: "Evelyn", requestId: `complete-${task.id}` });
    await store.acknowledgeEscalation({ id: acknowledged.id, memberId: "maya", name: "Maya" });

    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.evidence.find(item => item.id === `escalation:${acknowledged.id}`)).toMatchObject({
      acknowledged: true,
      fact: `A family follow-up was blocked because no caregiver was on duty. A caregiver acknowledged it at ${asOf.toISOString()}.`,
    });
    expect(brief.followUps).toEqual([{
      text: "Ask a caregiver to acknowledge the follow-up.", evidenceIds: [`escalation:${pending.id}`],
    }]);
    expect(JSON.stringify(brief)).not.toContain("Maya");

    await store.acknowledgeEscalation({ id: pending.id, memberId: "theo", name: "Theo" });
    const allAcknowledged = await new WeeklyBriefService(store).create(asOf);
    expect(allAcknowledged.followUps).toEqual([]);
    expect(allAcknowledged.stats.escalations).toBe(2);
  });

  it("includes exactly-due and overdue tasks but not the next scheduled instant", async () => {
    const store = new InMemoryCareStore([
      recordedTask("overdue", "2026-09-02T17:59:59.999Z"),
      recordedTask("due-now", asOf.toISOString()),
      recordedTask("upcoming", "2026-09-02T18:00:00.001Z"),
    ], fixedNow);

    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.stats).toEqual({ scheduled: 2, completed: 0, skipped: 0, stillOpen: 2, escalations: 0 });
    expect(brief.evidence.map(item => item.id)).toEqual([
      "task:overdue:2026-09-02T17:59:59.999Z", "task:due-now:2026-09-02T18:00:00.000Z",
    ]);
    expect(JSON.stringify(brief)).not.toContain("upcoming");
    expect((await store.activityBetween(brief.period)).tasks).toHaveLength(3);
  });

  it("uses the captured instant inside a local day that spans two UTC dates", async () => {
    const instant = new Date("2026-09-03T04:30:00.000Z");
    const store = new InMemoryCareStore([
      recordedTask("earlier-local-day", "2026-09-02T23:00:00.000Z"),
      recordedTask("earlier-tonight", "2026-09-03T04:00:00.000Z"),
      recordedTask("later-tonight", "2026-09-03T05:00:00.000Z"),
    ], () => instant, null, "America/Denver");

    const brief = await new WeeklyBriefService(store, null, "America/Denver").create(instant);

    expect(brief.period).toEqual({ startDate: "2026-08-27", endDate: "2026-09-02" });
    expect(brief.stats.stillOpen).toBe(2);
    expect(brief.evidence.map(item => item.fact)).toEqual([
      "earlier-local-day was still open.", "earlier-tonight was still open.",
    ]);
  });

  it.each([
    ["an empty activity window", []],
    ["only future scheduled tasks", [recordedTask("later", "2026-09-02T21:00:00.000Z")]],
  ] as const)("returns an empty brief without calling a model for %s", async (_description, tasks) => {
    const store = new InMemoryCareStore([...tasks], fixedNow);
    const generate = vi.fn<BriefGenerator["generate"]>();

    const brief = await new WeeklyBriefService(store, { generate }).create(asOf);

    expect(brief.stats).toEqual({ scheduled: 0, completed: 0, skipped: 0, stillOpen: 0, escalations: 0 });
    expect(brief.evidence).toEqual([]);
    expect(brief.followUps).toEqual([]);
    expect(brief.headline).toBe("No care activity recorded this week");
    expect(brief.generatedBy).toBe("deterministic");
    expect(generate).not.toHaveBeenCalled();
  });

  it("preserves already-recorded completion, skip, and cancellation facts before their original due time", async () => {
    const dueAt = "2026-09-02T21:00:00.000Z";
    const store = new InMemoryCareStore([
      { ...recordedTask("already-done", dueAt, "done"), lastResponse: "done", confirmedBy: "Evelyn", confirmedAt: asOf.toISOString() },
      { ...recordedTask("already-skipped", dueAt, "skipped"), lastResponse: "skipped", confirmedBy: "Evelyn", confirmedAt: asOf.toISOString() },
      { ...recordedTask("already-cancelled", dueAt, "cancelled"), changedAt: asOf.toISOString(), changedBy: "Maya" },
      recordedTask("still-upcoming", dueAt),
    ], fixedNow);

    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.stats).toEqual({ scheduled: 2, completed: 1, skipped: 1, stillOpen: 0, escalations: 0 });
    expect(brief.evidence.map(item => item.fact)).toEqual([
      "already-done was completed.", "already-skipped was skipped.", "already-cancelled was cancelled before it was due.",
    ]);
    expect(brief.followUps).toEqual([]);
  });

  it("excludes future scheduled facts before sending the source to the model", async () => {
    const past = recordedTask("due-task", "2026-09-02T15:00:00.000Z");
    const future = recordedTask("future-task-must-not-leak", "2026-09-02T21:00:00.000Z");
    const evidenceId = `task:${past.id}:${past.dueAt}`;
    const send = vi.fn(async (_command: ConverseCommand) => ({
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: JSON.stringify({
        overviewEvidenceIds: [evidenceId], highlightEvidenceIds: [evidenceId],
        followUps: [{ kind: "check_open_task", evidenceId }],
      }) }] } },
    } as ConverseCommandOutput));
    const generator = new BedrockBriefGenerator({ client: { send }, modelId: "synthetic-model" });

    const brief = await new WeeklyBriefService(new InMemoryCareStore([past, future], fixedNow), generator).create(asOf);

    expect(brief.generatedBy).toBe("bedrock");
    expect(send).toHaveBeenCalledTimes(1);
    const modelSource = JSON.parse(send.mock.calls[0]![0].input.messages![0]!.content![0]!.text!);
    expect(modelSource.stats).toEqual({ scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 });
    expect(modelSource.evidence).toEqual([{ id: evidenceId, kind: "care_task", occurredAt: past.dueAt, fact: "due-task was still open." }]);
    expect(JSON.stringify(brief)).not.toContain(future.id);
  });

  it("builds a deterministic, evidence-linked brief without a model", async () => {
    const asOf = new Date("2026-09-02T22:00:00.000Z");
    const store = createDemoStore(() => asOf);
    await store.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Evelyn",
      requestId: "weekly-test-0001",
    });
    const snapshot = await store.today();
    await store.queueEscalation({
      id: "missed_afternoon-walk_2026-09-02T21:00:00.000Z",
      taskId: "afternoon-walk",
      taskTitle: "Take the afternoon walk",
      dueAt: "2026-09-02T21:00:00.000Z",
      createdAt: asOf.toISOString(),
      recipient: snapshot.onDuty!,
    });

    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief).toMatchObject({
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 2, completed: 1, stillOpen: 1, escalations: 1 },
      generatedBy: "deterministic",
      generation: null,
    });
    const allowed = new Set(brief.evidence.map((item) => item.id));
    for (const point of [...brief.highlights, ...brief.followUps]) {
      expect(point.evidenceIds.length).toBeGreaterThan(0);
      expect(point.evidenceIds.every((id) => allowed.has(id))).toBe(true);
    }
    expect(brief.safetyNotice).toContain("not medical advice");
  });

  it("uses a grounded generated narrative", async () => {
    const store = createDemoStore(fixedNow);
    const generator: BriefGenerator = {
      generate: vi.fn(async (source) => ({
        narrative: {
          overview: "One care task was recorded this week.",
          overviewEvidenceIds: [source.evidence[0]!.id],
          highlights: [{
            text: "The water task is still open.",
            evidenceIds: [source.evidence[0]!.id],
          }],
          followUps: [],
        },
        generation: {
          provider: "bedrock" as const,
          modelId: "amazon.nova-micro-v1:0",
          stopReason: "end_turn",
          inputTokens: 100,
          outputTokens: 40,
        },
      })),
    };

    const brief = await new WeeklyBriefService(store, generator).create(asOf);

    expect(brief.generatedBy).toBe("bedrock");
    expect(brief.headline).toBe("1 recorded task is still open");
  });

  it("falls back safely when the generator fails", async () => {
    const generator: BriefGenerator = {
      generate: vi.fn(async () => {
        throw new Error("invalid or unavailable model output");
      }),
    };

    const brief = await new WeeklyBriefService(createDemoStore(fixedNow), generator).create(asOf);

    expect(brief.generatedBy).toBe("deterministic");
    expect(brief.generation).toBeNull();
    expect(brief.headline).toBe("1 recorded task is still open");
  });

  it("uses the care circle's local calendar instead of UTC", async () => {
    const instant = new Date("2026-09-03T04:30:00.000Z");
    const store = createDemoStore(() => instant, "America/Denver");

    const brief = await new WeeklyBriefService(
      store,
      null,
      "America/Denver",
    ).create(instant);

    expect(brief.period).toEqual({ startDate: "2026-08-27", endDate: "2026-09-02" });
    expect(brief.stats.scheduled).toBe(2);
  });
});

describe("BedrockBriefGenerator", () => {
  it("rejects a model's close-loop follow-up for an acknowledged event", async () => {
    const source = {
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 0, completed: 0, skipped: 0, stillOpen: 0, escalations: 1 },
      evidence: [{ id: "escalation:acknowledged", kind: "escalation" as const,
        occurredAt: "2026-09-02T15:00:00.000Z", acknowledged: true,
        fact: "A family follow-up was sent to the on-duty caregiver. A caregiver acknowledged it at 2026-09-02T16:00:00.000Z." }],
    };
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", client: {
      send: async () => ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: JSON.stringify({
        overviewEvidenceIds: [source.evidence[0]!.id], highlightEvidenceIds: [source.evidence[0]!.id],
        followUps: [{ kind: "close_escalation_loop", evidenceId: source.evidence[0]!.id }],
      }) }] } } } as ConverseCommandOutput),
    } });

    await expect(generator.generate(source)).rejects.toThrow("inapplicable follow-up");
  });

  it("renders a not-yet reply and an unacknowledged family follow-up from selected facts", async () => {
    const source = {
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 1 },
      evidence: [
        { id: "task:reply", kind: "care_task" as const, occurredAt: "2026-09-02T15:00:00.000Z",
          fact: 'A "not yet" reply was recorded for Drink water; the task was still open.' },
        { id: "escalation:pending", kind: "escalation" as const, occurredAt: "2026-09-02T15:00:00.000Z", acknowledged: false,
          fact: "A family follow-up was queued to the on-duty caregiver." },
      ],
    };
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", client: {
      send: async () => ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: JSON.stringify({
        overviewEvidenceIds: source.evidence.map(item => item.id), highlightEvidenceIds: source.evidence.map(item => item.id),
        followUps: [{ kind: "check_open_task", evidenceId: "task:reply" }, { kind: "close_escalation_loop", evidenceId: "escalation:pending" }],
      }) }] } } } as ConverseCommandOutput),
    } });

    const result = await generator.generate(source);

    expect(result.narrative.highlights.map(point => point.text)).toEqual(source.evidence.map(item => item.fact));
    expect(result.narrative.followUps).toEqual([
      { text: "Check whether the still-open task needs a new time or family follow-up.", evidenceIds: ["task:reply"] },
      { text: "Ask a caregiver to acknowledge the follow-up.", evidenceIds: ["escalation:pending"] },
    ]);
    expect(JSON.stringify(result.narrative)).not.toContain("missed-task");
  });

  it("accepts only a completed JSON response with known evidence IDs", async () => {
    const send = vi.fn(async (_command: ConverseCommand) => ({
      stopReason: "end_turn",
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
      output: {
        message: {
          role: "assistant",
          content: [{ text: JSON.stringify({
            overviewEvidenceIds: ["task:one"],
            highlightEvidenceIds: ["task:one"],
            followUps: [{ kind: "check_open_task", evidenceId: "task:one" }],
          }) }],
        },
      },
    } as ConverseCommandOutput));
    const generator = new BedrockBriefGenerator({
      client: { send },
      modelId: "amazon.nova-micro-v1:0",
    });

    const result = await generator.generate({
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 },
      evidence: [{
        id: "task:one",
        kind: "care_task",
        occurredAt: "2026-09-02T15:00:00.000Z",
        fact: "Drink water was still open.",
      }],
    });

    expect(result.generation).toMatchObject({
      provider: "bedrock",
      inputTokens: 80,
      outputTokens: 30,
    });
    expect(result.narrative.highlights).toEqual([{
      text: "Drink water was still open.",
      evidenceIds: ["task:one"],
    }]);
    expect(result.narrative.followUps[0]?.text).toBe(
      "Check whether the still-open task needs a new time or family follow-up.",
    );
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      modelId: "amazon.nova-micro-v1:0",
      inferenceConfig: { temperature: 0.1 },
      requestMetadata: { application: "kin", feature: "weekly-brief" },
    });
  });

  it("rejects invented evidence and incomplete model turns", async () => {
    const response = (stopReason: string) => ({
      stopReason,
      output: {
        message: {
          role: "assistant",
          content: [{ text: JSON.stringify({
            overviewEvidenceIds: ["made-up"],
            highlightEvidenceIds: ["made-up"],
            followUps: [],
          }) }],
        },
      },
    } as ConverseCommandOutput);
    const source = {
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 },
      evidence: [{
        id: "task:one",
        kind: "care_task" as const,
        occurredAt: "2026-09-02T15:00:00.000Z",
        fact: "Drink water was still open.",
      }],
    };

    await expect(new BedrockBriefGenerator({
      client: { send: async () => response("end_turn") },
      modelId: "model",
    }).generate(source)).rejects.toThrow("unknown evidence");
    await expect(new BedrockBriefGenerator({
      client: { send: async () => response("max_tokens") },
      modelId: "model",
    }).generate(source)).rejects.toThrow("did not complete");
  });

  it("rejects a follow-up applied to the wrong event type", async () => {
    const client = {
      send: async () => ({
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [{ text: JSON.stringify({
              overviewEvidenceIds: ["task:done"],
              highlightEvidenceIds: ["task:done"],
              followUps: [{ kind: "check_open_task", evidenceId: "task:done" }],
            }) }],
          },
        },
      } as ConverseCommandOutput),
    };
    const generator = new BedrockBriefGenerator({ client, modelId: "model" });

    await expect(generator.generate({
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 1, skipped: 0, stillOpen: 0, escalations: 0 },
      evidence: [{
        id: "task:done",
        kind: "care_task",
        occurredAt: "2026-09-02T15:00:00.000Z",
        fact: "Drink water was completed.",
      }],
    })).rejects.toThrow("inapplicable follow-up");
  });

  it("aborts model selection before it can consume Alexa's response budget", async () => {
    const send = vi.fn((_command: ConverseCommand, options?: { abortSignal?: AbortSignal }) =>
      new Promise<ConverseCommandOutput>((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      }));
    const generator = new BedrockBriefGenerator({
      client: { send },
      modelId: "model",
      timeoutMs: 50,
    });
    const startedAt = Date.now();

    await expect(generator.generate({
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 },
      evidence: [{
        id: "task:one",
        kind: "care_task",
        occurredAt: "2026-09-02T15:00:00.000Z",
        fact: "Drink water was still open.",
      }],
    })).rejects.toThrow("aborted");

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(send.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
