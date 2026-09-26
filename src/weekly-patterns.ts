import type { CareActivityWindow, CareTask } from "./domain.js";
import { calendarDate } from "./calendar.js";
import type { BriefEvidence, BriefPoint } from "./weekly-brief.js";

export interface WeeklyPatterns { points: BriefPoint[]; notice: string }

// One observation is one scheduled occurrence, not one confirmation event.
// Acknowledgments never enter these counts; closure is explicitly not a reply.
export function weeklyPatterns(current: CareActivityWindow, previous: CareActivityWindow | null, asOf: Date, timeZone: string): {
  patterns: WeeklyPatterns; previousEvidence: BriefEvidence[];
} {
  const select = (window: CareActivityWindow) => {
    const tasks = window.tasks.filter(task => {
      const date = calendarDate(new Date(task.dueAt), timeZone);
      return date >= window.startDate && date <= window.endDate && task.state !== "cancelled" &&
        Date.parse(task.dueAt) <= asOf.getTime();
    });
    if (new Set(tasks.map(task => `${task.id}:${task.dueAt}`)).size !== tasks.length) throw new Error("Duplicate pattern evidence");
    return tasks;
  };
  const replied = (task: CareTask) => task.state !== "closed_unanswered" &&
    (task.lastResponse !== null || task.state === "done" || task.state === "skipped");
  const id = (task: CareTask) => `task:${task.id}:${task.dueAt}`;
  const tasks = select(current), prior = previous ? select(previous) : [];
  const points: BriefPoint[] = [];
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });
  for (const [label, start, end] of [["Morning (midnight–noon)", 0, 12], ["Afternoon (noon–6 PM)", 12, 18], ["Evening (6 PM–midnight)", 18, 24]] as const) {
    const group = tasks.filter(task => { const value = Number(hour.format(new Date(task.dueAt))); return value >= start && value < end; });
    if (!group.length) continue;
    points.push({ text: `${label}: ${group.filter(replied).length} of ${group.length} due check-in${group.length === 1 ? " has" : "s have"} a recorded reply.`, evidenceIds: group.map(id) });
  }
  const currentReplies = tasks.filter(replied).length, priorReplies = prior.filter(replied).length;
  if (tasks.length && prior.length) {
    const delta = Math.round((currentReplies / tasks.length - priorReplies / prior.length) * 100);
    // These are already circle-local calendar dates, not instants to shift into
    // the server's or reader's time zone. UTC preserves their calendar labels.
    const dates = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
    const range = (window: CareActivityWindow) => dates.formatRange(new Date(`${window.startDate}T00:00:00.000Z`), new Date(`${window.endDate}T00:00:00.000Z`)).replaceAll("\u2009", "");
    // A rounded zero is not evidence that the underlying fractions are equal.
    const difference = delta === 0 ? "Rounded change in reply share: 0 percentage points."
      : `Reply share is ${Math.abs(delta)} percentage point${Math.abs(delta) === 1 ? "" : "s"} ${delta > 0 ? "higher" : "lower"} (rounded).`;
    points.push({ text: `Recorded replies: ${currentReplies} of ${tasks.length} due check-in${tasks.length === 1 ? "" : "s"} for ${range(current)} (so far), compared with ${priorReplies} of ${prior.length} for ${range(previous!)}. ${difference}`,
      evidenceIds: [...tasks, ...prior].map(id) });
  }
  const previousEvidence = prior.map(task => ({ id: id(task), kind: "care_task" as const, occurredAt: task.dueAt,
    fact: `Prior comparison period: ${task.title}; ${replied(task) ? "a reply is recorded" : task.state === "closed_unanswered" ? "closed without a reply" : "no reply is recorded"}.` }));
  return { patterns: { points, notice: `Times use ${timeZone}. Counts include due check-ins only; cancellations are excluded. Done, not yet and skipped count as replies; closed without a reply does not. The current period includes a partial day; changes in schedules or recording can change the comparison. This is not a health or safety assessment.${previous === null ? " Previous-period records could not be loaded; no week comparison is shown." : !tasks.length || !prior.length ? " There are not enough recorded due check-ins in both periods for a week comparison." : ""}` }, previousEvidence };
}
