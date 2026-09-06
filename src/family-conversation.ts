import type { TodaySnapshot } from "./domain.js";
import { proposeConversation, type IntentGenerator } from "./demo-conversation.js";
import { BudgetExceeded, type ConversationBudget } from "./conversation-budget.js";
import { FamilyAccessDeniedError, type Membership } from "./membership.js";

export { BudgetExceeded } from "./conversation-budget.js";
export const familyConversationConsentVersion = "bedrock-task-titles-v1" as const;
export type FamilyConversationConsentVersion = typeof familyConversationConsentVersion;
export class ConsentRequired extends Error {
  constructor() { super("Explicit consent is required for this request's Bedrock transfer."); this.name = "ConsentRequired"; }
}
export class ModelUnavailable extends Error {
  constructor() { super("Natural-language interpretation is unavailable. Your draft has not been saved."); this.name = "ModelUnavailable"; }
}
export type FamilyConversationService = ReturnType<typeof createFamilyConversationService>;

export function createFamilyConversationService(options: { generate: IntentGenerator; budget: ConversationBudget }) {
  return {
    async propose(input: { message: string; consent: boolean }, snapshot: TodaySnapshot, member: Membership) {
      if (member.status !== "active" || member.role === "viewer") throw new FamilyAccessDeniedError();
      if (input.consent !== true) throw new ConsentRequired();
      if (typeof input.message !== "string" || !input.message.trim() || input.message.trim().length > 800) throw new TypeError("Invalid conversation message");
      const message = input.message.trim();
      if (snapshot.tasks.filter(task => task.state === "scheduled").length > 40) {
        return { action: "clarify" as const, mode: "limited" as const };
      }
      try {
        await options.budget.reserve({ circleId: member.circleId, memberId: member.memberId });
      } catch (error) {
        if (error instanceof BudgetExceeded) throw error;
        throw new ModelUnavailable();
      }
      try {
        // Only a snapshot and generator enter proposal interpretation. No repository,
        // writer, raw model response, or conversational transcript leaves this service.
        return await proposeConversation(message, snapshot, options.generate);
      } catch {
        // Never attach provider errors: they may contain request text or model output.
        throw new ModelUnavailable();
      }
    },
  };
}
