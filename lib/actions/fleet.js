import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { findNewsletter } from "@/lib/actions/shared";

const GROUP = "Fleet";
const number = z.number().int().nonnegative();
const warmup = z.object({ days: number, day: number, hasStarted: z.boolean(), progress: z.number(), endsAt: z.string().nullable() }).nullable();

export const fleetActions = [
	defineAction({
		name: "get_brand_fleet", title: "Get the brand fleet", group: GROUP,
		description: "All newsletters in this account: active subscribers, last sent issue, sent messages and bounce and complaint counts over 7 days, sending brakes and warm-up. Rates are fractions of sent messages, null with no sends. This is account-wide; a key limited to one newsletter cannot use it.",
		http: { method: "GET", path: "/fleet" }, readOnly: true,
		output: z.object({
			asOf: z.string(), periodDays: number, newsletterLimit: number.nullable(),
			limits: z.object({ bounceRate: z.number(), complaintRate: z.number(), minBounces: number, minComplaints: number }),
			domains: z.array(z.string()).describe("Domains the operator has enabled for this account's automatic DNS setup"),
			newsletters: z.array(z.object({
				id: z.string(), name: z.string(), slug: z.string(), fromEmail: z.string(), archiveUrl: z.string().nullable(),
				subscribers: number, lastSentAt: z.string().nullable(), paused: z.boolean(), reason: z.string().nullable(), warmup,
				health: z.object({ sent: number, bounced: number, complained: number, bounceRate: z.number().nullable(), complaintRate: z.number().nullable() }),
			})),
		}),
		handler: async ({ account }) => (await import("@/lib/fleet")).getBrandFleet(account),
	}),
	defineAction({
		name: "onboard_brand_domains", title: "Set up brand domains", group: GROUP,
		description: "Adds up to 10 brand domains to Amazon SES and writes their DKIM, return-path SPF and MX, DMARC and archive records through Cloudflare. Only domains assigned to this account in the operator's CLOUDFLARE_FLEET_ZONES configuration are allowed. Existing policies are preserved; conflicting records require review. Each result reports ready, pending DNS/certificate checks, or error, including partial records. Retry reuses existing domains and records. This sends nothing and never changes a newsletter's From address; use update_newsletter once verified.",
		http: { method: "POST", path: "/fleet/domains" }, destructive: true, openWorld: true,
		rateLimit: { limit: 3, window: "1 h" },
		input: z.object({ domains: z.array(z.object({ domain: z.string().trim().min(1).max(253).describe("An operator-approved sending domain"), archiveHost: z.string().trim().max(253).optional().describe("Archive subdomain; defaults to news.<domain>") })).min(1).max(10).describe("One to ten approved sending domains and their optional archive hosts") }),
		example: { domains: [{ domain: "example.com" }] },
		output: z.object({ domains: z.array(z.object({
			domain: z.string(), id: z.string().nullable(), state: z.enum(["ready", "pending", "error"]), error: z.string().nullable(),
			records: z.array(z.object({ type: z.string(), name: z.string(), state: z.enum(["created", "existing"]) })),
		})) }),
		handler: async ({ account, input }) => (await import("@/lib/brand-domains")).onboardBrandDomains(account, input.domains),
	}),
	defineAction({
		name: "resume_newsletter_sending", title: "Resume a newsletter's sending", group: GROUP,
		description: "Clears this newsletter's sending brake only after rechecking its 7-day bounce and complaint rates. Refused while it is still over a pause level. Paused campaigns need resume_campaign separately; queued signup and automation jobs retry. Account and provider blocks still apply. A send-with-approval agent must ask the owner first.",
		http: { method: "POST", path: "/newsletters/{id}/resume-sending" }, idempotent: true,
		input: z.object({ id: z.string().trim().min(1).max(100).describe("Newsletter ID or slug") }),
		output: z.object({ resumed: z.boolean() }),
		handler: async ({ account, input }) => (await import("@/lib/newsletter-health")).resumeNewsletterSending(account, await findNewsletter(account, input.id)),
	}),
];
