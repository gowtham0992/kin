import type { CareTask, DutyAssignment } from "./domain.js";

export interface DemoSeedItem {
  PK: string;
  SK: string;
  entityType: "CareTask" | "DutyAssignment";
  [key: string]: unknown;
}

export function buildDemoSeed(input: {
  circleId: string;
  now?: Date;
}): DemoSeedItem[] {
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const nextDate = new Date(`${date}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
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
  const duty: DutyAssignment = {
    memberId: "theo",
    memberName: "Theo",
    startsAt: `${date}T08:00:00.000Z`,
    endsAt: `${nextDate.toISOString().slice(0, 10)}T02:00:00.000Z`,
  };

  return [
    ...tasks.map((task) => ({
      ...task,
      PK: partitionKey,
      SK: `TASK#${task.dueAt}#${task.id}`,
      entityType: "CareTask" as const,
    })),
    {
      ...duty,
      PK: partitionKey,
      SK: `DUTY#${date}`,
      entityType: "DutyAssignment",
    },
  ];
}
