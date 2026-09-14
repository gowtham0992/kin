import { describe, expect, it } from "vitest";
import { InMemoryCareStore } from "../src/domain.js";
import { WeeklyBriefService } from "../src/weekly-brief.js";

describe("weekly evidence for accepted delivery with a pending receipt", () => {
  it("counts known acceptance, explains reconciliation and never calls it handset delivery", async () => {
    const now = new Date("2026-09-02T18:00:00.000Z");
    const store = new InMemoryCareStore([], () => now);
    store.activityBetween = async period => ({ ...period, tasks: [], escalations: [{
      id: "held", taskId: "water", dueAt: "2026-09-02T15:00:00.000Z", updatedAt: "2026-09-02T16:00:00.000Z",
      sentAt: "2026-09-02T16:00:00.000Z", status: "receipt_pending", recipientMemberId: "theo", recipientMemberName: "Theo",
    }] });
    const brief = await new WeeklyBriefService(store).create(now);
    expect(brief.responsibility).toMatchObject({ providerAccepted: 1, acceptanceNotRecorded: 0 });
    const fact = brief.evidence.find(item => item.id === "escalation:held")?.fact;
    expect(fact).toContain("its receipt needs review");
    expect(fact).toContain("Messaging service accepted it at 2026-09-02T16:00:00.000Z; delivery is not confirmed.");
    expect(fact).not.toContain("receipt_pending");
  });
});
