export const confirmationResponses = ["done", "not_yet", "skipped"] as const;

export type ConfirmationResponse = (typeof confirmationResponses)[number];
export type TaskState = "scheduled" | "done" | "skipped";

export interface CareTask {
  id: string;
  title: string;
  dueAt: string;
  state: TaskState;
  lastResponse: ConfirmationResponse | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

export interface Confirmation {
  id: string;
  requestId: string;
  taskId: string;
  response: ConfirmationResponse;
  actor: string;
  recordedAt: string;
}

export interface DutyAssignment {
  memberId: string;
  memberName: string;
  startsAt: string;
  endsAt: string;
}

export interface TodaySnapshot {
  date: string;
  tasks: CareTask[];
  onDuty: DutyAssignment | null;
  summary: {
    total: number;
    completed: number;
    remaining: number;
    skipped: number;
  };
}

export interface CareRepository {
  today(): Promise<TodaySnapshot>;
  confirm(input: {
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }>;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Care task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class InMemoryCareStore implements CareRepository {
  readonly #tasks = new Map<string, CareTask>();
  readonly #confirmationsByRequest = new Map<string, Confirmation>();
  readonly #now: () => Date;
  readonly #onDuty: DutyAssignment | null;

  constructor(
    tasks: CareTask[],
    now: () => Date = () => new Date(),
    onDuty: DutyAssignment | null = null,
  ) {
    this.#now = now;
    this.#onDuty = onDuty ? structuredClone(onDuty) : null;
    for (const task of tasks) this.#tasks.set(task.id, structuredClone(task));
  }

  async today(): Promise<TodaySnapshot> {
    const date = this.#now().toISOString().slice(0, 10);
    const tasks = [...this.#tasks.values()]
      .filter((task) => task.dueAt.startsWith(date))
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map((task) => structuredClone(task));

    const completed = tasks.filter((task) => task.state === "done").length;
    const skipped = tasks.filter((task) => task.state === "skipped").length;

    return {
      date,
      tasks,
      onDuty: this.#onDuty ? structuredClone(this.#onDuty) : null,
      summary: {
        total: tasks.length,
        completed,
        skipped,
        remaining: tasks.length - completed - skipped,
      },
    };
  }

  async confirm(input: {
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }> {
    const previous = this.#confirmationsByRequest.get(input.requestId);
    if (previous) {
      const previousTask = this.#tasks.get(previous.taskId);
      if (!previousTask) throw new TaskNotFoundError(previous.taskId);
      return {
        task: structuredClone(previousTask),
        confirmation: structuredClone(previous),
        replayed: true,
      };
    }

    const task = this.#tasks.get(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);

    const recordedAt = this.#now().toISOString();
    const confirmation: Confirmation = {
      id: `confirmation_${input.requestId}`,
      requestId: input.requestId,
      taskId: input.taskId,
      response: input.response,
      actor: input.actor,
      recordedAt,
    };

    task.lastResponse = input.response;
    task.confirmedBy = input.actor;
    task.confirmedAt = recordedAt;
    if (input.response === "done") task.state = "done";
    if (input.response === "skipped") task.state = "skipped";
    if (input.response === "not_yet") task.state = "scheduled";

    this.#confirmationsByRequest.set(input.requestId, confirmation);
    return {
      task: structuredClone(task),
      confirmation: structuredClone(confirmation),
      replayed: false,
    };
  }
}

export function createDemoStore(now: () => Date = () => new Date()): InMemoryCareStore {
  const date = now().toISOString().slice(0, 10);
  const dutyEndsAt = new Date(`${date}T02:00:00.000Z`);
  dutyEndsAt.setUTCDate(dutyEndsAt.getUTCDate() + 1);
  return new InMemoryCareStore(
    [
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
    ],
    now,
    {
      memberId: "theo",
      memberName: "Theo",
      startsAt: `${date}T08:00:00.000Z`,
      endsAt: dutyEndsAt.toISOString(),
    },
  );
}
