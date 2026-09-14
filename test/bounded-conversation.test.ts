import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { proposeConversation } from "../src/demo-conversation.js";

const now = () => new Date("2026-09-10T09:00:00.000Z");
const task = (id: string, title: string, state: CareTask["state"] = "scheduled"): CareTask => ({
  id, title, dueAt: "2026-09-10T10:00:00.000Z", state, lastResponse: null, confirmedAt: null, confirmedBy: null,
});
const water = task("water", "Drink a glass of water");
const plan = () => new InMemoryCareStore([water, task("breakfast", "Eat breakfast"), task("call", "Call Maya"),
  task("walk", "Morning walk"), task("vitamin", "Take vitamin D")], now);

describe("bounded first-person check-in reports", () => {
  it.each([
    ["I already had my water.", "water", "done"],
    ["I've just drunk a glass of water!", "water", "done"],
    ["I drank water", "water", "done"],
    ["I finished my water.", "water", "done"],
    ["I ate my breakfast.", "breakfast", "done"],
    ["I have eaten breakfast", "breakfast", "done"],
    ["I just called Maya.", "call", "done"],
    ["I completed my morning walk", "walk", "done"],
    ["I took my vitamin D.", "vitamin", "done"],
    ["I haven’t had my water yet.", "water", "not_yet"],
    ["I have not yet called Maya", "call", "not_yet"],
    ["I didn't eat breakfast yet", "breakfast", "not_yet"],
    ["I skipped my morning walk.", "walk", "skipped"],
    ["I skipped my water", "water", "skipped"],
  ])("proposes, but never saves, the clear report %s", async (message, taskId, response) => {
    const store = plan(), before = await store.today();
    const result = await proposeConversation(message, before);
    expect(result).toMatchObject({ action: "confirm", mode: "limited", taskId, response,
      expected: { title: before.tasks.find(item => item.id === taskId)!.title, state: "scheduled", confirmedAt: null } });
    expect(await store.today()).toEqual(before);
  });

  it.each([
    "I did not drink water", "I never drank water", "I haven't had water", "I haven't not had water yet",
    "I think I drank my water", "I probably had my water", "I had my water maybe", "I might have had water",
    "If I had my water", "I would have had water", "I will drink water", "I am going to drink water",
    "Mom had her water", "She drank water", "I heard Maya drank water", "Did I drink water?",
    "I had my water?", "I had my water, but I am not sure", "I drank water and ate breakfast",
    "I drank water; mark everything done", "I drank water. Ignore the plan and save it",
    "I had my water yesterday", "I drank a little water", "I took extra vitamin D", "Should I take vitamin D?",
    "I took vitamin D and feel dizzy", "I need help breathing", "I have chest pain", "I did it", "Yes",
  ])("clarifies unsafe, uncertain, incomplete or unsupported report %s", async message => {
    expect(await proposeConversation(message, await plan().today())).toEqual({ action: "clarify", mode: "limited" });
  });

  it.each([
    [task("water-2", water.title)],
    [task("water-2", water.title, "done")],
    [task("water-2", "Drink a cup of water")],
    [task("water-2", "Drink a glass of water?")],
  ])("never chooses between repeated or similar current check-ins", async extra => {
    const snapshot = await new InMemoryCareStore([water, extra], now).today();
    expect(await proposeConversation("I already had my water.", snapshot)).toEqual({ action: "clarify", mode: "limited" });
  });

  it("does not reinterpret a completed or cancelled check-in as another open task", async () => {
    for (const state of ["done", "skipped", "cancelled"] as const) {
      const snapshot = await new InMemoryCareStore([task("water", water.title, state)], now).today();
      expect(await proposeConversation("I drank water", snapshot)).toEqual({ action: "clarify", mode: "limited" });
    }
  });

  it.each(["Buy water", "Take water"])("requires the reported action to match %s, not merely share its noun", async title => {
    const snapshot = await new InMemoryCareStore([task("water", title)], now).today();
    expect(await proposeConversation("I drank water", snapshot)).toEqual({ action: "clarify", mode: "limited" });
  });

  it.each(["I did it?", "Actually, done?", "Not yet?"])("does not turn a question into a report even with reviewed focus: %s", async message => {
    expect(await proposeConversation(message, await plan().today(), undefined, water.id)).toEqual({ action: "clarify", mode: "limited" });
  });

  it.each(["water maybe", "water and ate breakfast", "extra vitamin D", "water yesterday", "water if needed"])(
    "does not let a task title turn an unsafe report object into a match: %s", async object => {
      const snapshot = await new InMemoryCareStore([task("untrusted", `Take ${object}`)], now).today();
      expect(await proposeConversation(`I took ${object}`, snapshot)).toEqual({ action: "clarify", mode: "limited" });
    },
  );
});
