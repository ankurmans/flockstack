import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { newsletterInput } from "@/lib/actions/shared";

const level = z.enum(["read_only", "drafts", "send_with_approval"]);
const grant = z.object({ id: z.string(), name: z.string(), level, dailyCap: z.number(), expiresAt: z.string() });
const usage = z.object({ used: z.number(), limit: z.number().nullable(), resetsAt: z.string() });
const load = () => import("@/lib/account-assistant");

export const accountAssistantActions = [
	defineAction({
		name: "get_assistant_settings", title: "Get assistant settings", group: "Account assistant", dashboardOnly: true, readOnly: true,
		description: "Owner reads this newsletter's internal assistant grants and shared AI usage. Does not create a grant or call a model.",
		http: { method: "GET", path: "/assistant/settings" }, input: z.object({ newsletter: newsletterInput }),
		output: z.object({ available: z.boolean(), grants: z.array(grant), usage }),
		handler: async ({ account, user, input }) => (await load()).getAssistantSettings(account, user, input),
	}),
	defineAction({
		name: "create_assistant_grant", title: "Create an assistant grant", group: "Account assistant", dashboardOnly: true,
		description: "Owner explicitly creates a real newsletter-bound, revocable internal agent grant. No bearer token is created or exposed. Up to 100 tool calls a day for 90 days, subject to the shared AI allowance. Sends and schedules require separate human approval.",
		http: { method: "POST", path: "/assistant/grants" }, rateLimit: { limit: 10, window: "1 h" }, limitDashboard: true,
		input: z.object({ newsletter: newsletterInput, level: level.describe("Read only, drafts, or sends with approval; never full access") }), output: z.object({ grant }),
		handler: async ({ account, user, input }) => (await load()).createAssistantGrant(account, user, input),
	}),
	defineAction({
		name: "chat_with_assistant", title: "Ask the account assistant", group: "Account assistant", dashboardOnly: true, openWorld: true,
		description: "Owner-consented, bounded Workers AI conversation. Allowed tools run through the selected real agent grant and runAction. Three model calls and four tool attempts at most; every started model call counts. No server chat transcript. Source text and tool DTOs may be processed outside the region.",
		http: { method: "POST", path: "/assistant/chat" }, rateLimit: { limit: 30, window: "1 h" },
		input: z.object({ newsletter: newsletterInput, grant: z.string().regex(/^[a-f0-9]{24}$/).describe("An active internal assistant grant for this newsletter"), turnId: z.string().uuid().describe("A retry identifier for this user turn"), consent: z.literal(true).describe("Consent to global AI processing of chat, selected draft/brief and allowed tool results"), body: z.string().trim().min(1).max(4000).describe("The owner's request, treated as untrusted text"), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }).strict()).max(10).describe("Recent plain text only; client system and tool messages are refused") }),
		output: z.object({ text: z.string(), results: z.array(z.object({ tool: z.string(), status: z.enum(["completed", "failed", "approval_required"]), data: z.record(z.string(), z.unknown()), reused: z.boolean().optional() })), usage, stopped: z.string().nullable() }),
		handler: async ({ account, user, input }) => (await load()).chatWithAssistant(account, user, input),
	}),
];
