import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { BootstrapInput } from "@/lib/agent-bootstrap-schema";
import { newsletterInput } from "@/lib/actions/shared";

const BootstrapOutput = z.object({
	newsletterId: z.string(), slug: z.string(), formId: z.string(), batchId: z.string(), linkPageUrl: z.string(), reviewUrl: z.string(),
	drafts: z.array(z.object({ id: z.string(), subject: z.string(), status: z.string() })),
	domainSteps: z.array(z.object({ domain: z.string(), action: z.string(), status: z.string() })), sent: z.boolean(), published: z.boolean(),
});
// A briefing in get_agent_brief: its last runs and what waits for the owner (lib/agent-brief-briefings.js).
const BriefingBrief = z.object({
	id: z.string(), newsletterId: z.string(), name: z.string(), status: z.string().describe("active or paused"), schedule: z.string().describe("The schedule in words, with its time zone"),
	nextRunAt: z.string().nullable().describe("The next scheduled run; null while paused"), manualRunAt: z.string().nullable().describe("A run asked for with run_briefing, waiting for the engine"), budgetUsd: z.number().describe("The cap on a run's model spend, in USD"),
	runs: z.array(z.object({
		id: z.string(), slot: z.string().describe("The local day the run was due, or manual:<time>"), manual: z.boolean(), status: z.string(), costUsd: z.number().describe("What its model calls cost, against budgetUsd"),
		picked: z.number().int().describe("Stories picked"), sections: z.array(z.object({ id: z.string(), items: z.number().int(), status: z.string().nullable() })).optional().describe("Stories per section, for a briefing with sections"),
		held: z.string().nullable().describe("Why the draft was held instead of sent: review_mode, thin, checks, partial or agent_approval"), campaignId: z.string().nullable(),
		draft: z.string().nullable().describe("waiting (a draft for review), the campaign's status once it is more, deleted, or null for no draft"),
		failedLanguages: z.array(z.object({ language: z.string(), status: z.string() })).describe("Translations not written: failed, skipped_budget, skipped_no_key"),
		verdictsPending: z.number().int().describe("Stories with no keep or drop yet, for a run of the last 14 days"), error: z.string().nullable(),
	})).describe("The last runs, newest first; get_briefing_run has the rest"),
	needsOwner: z.array(z.string()).describe("What waits for the owner, a line each"),
});
export const agentActions = [
	defineAction({
		name: "get_best_send_time", title: "Find a send time", group: "Agents", readOnly: true,
		description: "Suggests the next occurrence of this newsletter's best observed weekday and hour from completed sends in the last 90 days. Needs three campaigns and 100 sends per slot, excludes the last 48 hours and imports. Opens include privacy proxies. Returns insufficient_data without a suggested time when evidence is missing. Never schedules or sends; pass a chosen time to schedule_campaign after review.",
		http: { method: "GET", path: "/agent/send-time" },
		input: z.object({ newsletter: newsletterInput, timeZone: z.string().max(64).optional().describe("IANA zone; UTC by default") }),
		output: z.object({ newsletterId: z.string(), timeZone: z.string(), suggestedAt: z.string().nullable(), basis: z.string(), note: z.string(), samples: z.array(z.object({ weekday: z.number(), hour: z.number(), campaigns: z.number(), sent: z.number(), opened: z.number(), openRate: z.number() })) }),
		handler: async ({ account, input }) => (await import("@/lib/best-send-time")).getBestSendTime(account, input),
	}),
	defineAction({
		name: "bootstrap_newsletter", title: "Bootstrap a newsletter", group: "Agents",
		description: "Builds a newsletter from a private brand brief: disabled archive, welcome and link page, confirmed-opt-in signup form, editorial batch and four unsent issue drafts. Uses externalId to resume safely after a partial failure. It sends, schedules and publishes nothing, and returns unstarted setup steps for the supplied brand domain. Normal shared-sender and archive provisioning still follows create_newsletter. A full account key or the dashboard owner may create it.",
		http: { method: "POST", path: "/agent/bootstrap" }, idempotent: true, openWorld: true, rateLimit: { limit: 20, window: "1 h" },
		input: BootstrapInput, output: BootstrapOutput,
		handler: async ({ account, input, user }) => (await import("@/lib/agent-bootstrap")).bootstrapNewsletter(account, input, user),
	}),
	defineAction({
		name: "get_agent_brief", title: "Get an agent brief", group: "Agents",
		description: "A compact writing brief from this newsletter's actual recent issue results, scheduled sends, seven planned days, empty calendar slots and backlog, with each briefing's last runs (status, cost against its cap, stories per section, whether the draft was held and why, translations that failed), its next run and what waits for the owner (drafts to review, stories with no keep or drop). Briefings are the account's, or only the newsletter's when one is named or the key is limited to one. Suggested next steps are derived from those records; missing evidence stays missing. Reading does not create or publish anything.",
		http: { method: "GET", path: "/agent/brief" }, readOnly: true,
		input: z.object({ newsletter: newsletterInput, timeZone: z.string().max(64).optional().describe("IANA zone for calendar days; UTC by default") }),
		output: z.object({ newsletterId: z.string(), name: z.string(), writingBrief: z.string().nullable(), description: z.string(), asOf: z.string(), timeZone: z.string(), coverageLimited: z.boolean(), recent: z.array(z.object({ id: z.string(), subject: z.string(), sent: z.number(), opened: z.number(), clicked: z.number(), openRate: z.number().nullable() })), scheduled: z.array(z.object({ id: z.string(), subject: z.string(), at: z.string() })), emptyDays: z.array(z.string()), backlog: z.array(z.object({ id: z.string(), title: z.string(), state: z.string() })), briefings: z.array(BriefingBrief), nextSteps: z.array(z.string()) }),
		handler: async ({ account, input, apiKey }) => (await import("@/lib/agent-brief")).getAgentBrief(account, input, { limitedTo: apiKey?.newsletterId ? String(apiKey.newsletterId) : null }),
	}),
	defineAction({
		name: "preview_agent_workspace", title: "Preview an agent workspace", group: "Agents", dashboardOnly: true,
		description: "Shows a provisional workspace's brief and drafts to a signed-in person holding its claim token. It creates no customer data and changes nothing.",
		http: { method: "POST", path: "/agent/workspaces/preview" }, readOnly: true,
		input: z.object({ id: z.string().max(100).describe("Workspace ID"), token: z.string().max(200).describe("Private claim token") }),
		output: z.object({ id: z.string(), revision: z.number(), name: z.string(), brief: z.string(), payload: z.record(z.string(), z.unknown()), drafts: z.array(z.object({ subject: z.string(), content: z.string().optional() })) }),
		handler: async ({ input }) => (await import("@/lib/agent-workspaces")).previewWorkspace(input),
	}),
	defineAction({
		name: "claim_agent_workspace", title: "Claim an agent workspace", group: "Agents", dashboardOnly: true,
		description: "A signed-in owner claims the exact draft workspace revision they previewed. Creates its newsletter and drafts through bootstrap, then revokes the provisional editing and claim tokens. Claiming never enables an archive or sends email.",
		http: { method: "POST", path: "/agent/workspaces/claim" }, idempotent: true, openWorld: true, rateLimit: { limit: 20, window: "1 h" },
		input: z.object({ id: z.string().max(100).describe("Workspace ID"), token: z.string().max(200).describe("Private claim token"), revision: z.number().int().min(1).describe("The revision the owner reviewed") }), output: BootstrapOutput,
		handler: async ({ account, input, user }) => (await import("@/lib/agent-workspaces")).claimWorkspace(account, input, user),
	}),
];
