import { randomUUID } from "node:crypto";
import type { TodaySnapshot } from "./domain.js";
import { assertTaskReview, type TaskReview } from "./task-review.js";

// Opaque, short-lived pointers to a reviewed task, never an authorization to write.
// No messages are retained. Restarting the local demo deliberately forgets context.
export function createConversationFocus(now = Date.now) {
  const entries = new Map<string, { taskId: string; expected: TaskReview; expiresAt: number }>();
  function prune() {
    for (const [token, value] of entries) if (value.expiresAt <= now()) entries.delete(token);
  }
  return {
    remember(taskId: string, expected: TaskReview) {
      prune();
      if (entries.size >= 100) entries.delete(entries.keys().next().value!);
      const token = randomUUID();
      entries.set(token, { taskId, expected, expiresAt: now() + 5 * 60_000 });
      return token;
    },
    resolve(token: string | undefined, snapshot: TodaySnapshot) {
      prune();
      const entry = token ? entries.get(token) : undefined;
      const task = entry && snapshot.tasks.find(task => task.id === entry.taskId && task.state === "scheduled");
      if (!entry || !task) return undefined;
      try { assertTaskReview(task, entry.expected); return task.id; }
      catch { entries.delete(token!); return undefined; }
    },
  };
}
