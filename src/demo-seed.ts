import type { CareTask, CircleMember, DutyAssignment } from "./domain.js";
import {
  calendarDate,
  calendarDayBounds,
  shiftCalendarDate,
  validateTimeZone,
} from "./calendar.js";

export interface DemoSeedItem {
  PK: string;
  SK: string;
  entityType: "CareTask" | "DutyAssignment" | "CircleMember";
  [key: string]: unknown;
}

export function buildDemoSeed(input: {
  circleId: string;
  now?: Date;
  timeZone?: string;
}): DemoSeedItem[] {
  const now = input.now ?? new Date();
  const timeZone = validateTimeZone(input.timeZone ?? "UTC");
  const date = calendarDate(now, timeZone);
  const partitionKey = `CIRCLE#${input.circleId}`;

  const tasks: CareTask[] = [
    {
      id: "morning-water",
      title: "Drink a glass of water",
      dueAt: `${date}T15:00:00.000Z`,
      state: "scheduled",
      lastResponse: null,
      confirmedBy: null,
      confirmedAt: null,
    },
    {
      id: "afternoon-walk",
      title: "Take the afternoon walk",
      dueAt: `${date}T21:00:00.000Z`,
      state: "scheduled",
      lastResponse: null,
      confirmedBy: null,
      confirmedAt: null,
    },
  ];
  const duties = Array.from({ length: 7 }, (_, index): DutyAssignment & { date: string } => {
    const dutyDate = shiftCalendarDate(date, index);
    const isTheo = index % 2 === 0;
    return {
      date: dutyDate,
      memberId: isTheo ? "theo" : "maya",
      memberName: isTheo ? "Theo" : "Maya",
      ...calendarDayBounds(dutyDate, timeZone),
    };
  });
  const members: CircleMember[] = [
    { id: "evelyn", name: "Evelyn", relationship: "parent", canReceiveAlerts: false },
    { id: "maya", name: "Maya", relationship: "daughter", canReceiveAlerts: true },
    { id: "theo", name: "Theo", relationship: "son", canReceiveAlerts: true },
  ];

  return [
    ...members.map((member) => ({
      ...member,
      PK: partitionKey,
      SK: `MEMBER#${member.id}`,
      entityType: "CircleMember" as const,
    })),
    ...tasks.map((task) => ({
      ...task,
      PK: partitionKey,
      SK: `TASK#${task.dueAt}#${task.id}`,
      entityType: "CareTask" as const,
    })),
    ...duties.map(({ date: dutyDate, ...duty }) => ({
      ...duty,
      PK: partitionKey,
      SK: `DUTY#${dutyDate}`,
      entityType: "DutyAssignment" as const,
    })),
  ];
}
