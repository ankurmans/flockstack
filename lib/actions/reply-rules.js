import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { findNewsletter, newsletterInput } from "@/lib/actions/shared";
import { REPLY_RULE_LIMITS } from "@/lib/reply-rule-settings";
const output = z.object({ enabled: z.boolean(), available: z.boolean(), learnFromHides: z.boolean(), revision: z.string(), rules: z.array(z.object({ id: z.string(), text: z.string() })) });
export const replyRuleActions = [
	defineAction({
		name: "get_reply_rules", title: "Read Reply Rules", group: "Comments", readOnly: true,
		description: "Reads the newsletter's public written comment rules and optional classification from recent consenting manually hidden examples. No model call. Hidden comment text and reader metadata are never returned here.",
		http: { method: "GET", path: "/reply-rules" }, input: z.object({ newsletter: newsletterInput }), output,
		handler: async ({ account, input }) => (await import("@/lib/reply-rules")).replyRulesSettings(await findNewsletter(account, input.newsletter)),
	}),
	defineAction({
		name: "set_reply_rules", title: "Change Reply Rules", group: "Comments", dashboardOnly: true, idempotent: false,
		description: "The signed-in owner configures opt-in Workers AI comment classification and agrees to global processing. Each reader must separately agree before their comment is processed or becomes an eligible hidden example. Conservative or unavailable results are held for review. Every started model attempt counts against the shared daily AI allowance; no training or automatic retries.",
		http: { method: "PATCH", path: "/reply-rules" }, input: z.object({ newsletter: newsletterInput, enabled: z.boolean(), rules: z.array(z.string().trim().min(1).max(REPLY_RULE_LIMITS.ruleChars)).max(REPLY_RULE_LIMITS.rules), learnFromHides: z.boolean(), consent: z.boolean() }), output,
		handler: async ({ account, user, input }) => (await import("@/lib/reply-rules")).saveReplyRules(account, user, await findNewsletter(account, input.newsletter), input),
	}),
];
