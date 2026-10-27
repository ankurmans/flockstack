import { normalizeLinkUrl } from "./link-page.js";
import * as z from "zod";
export const BootstrapInput = z.object({
	externalId: z.string().trim().min(1).max(60).describe("A stable retry key for this brief, unique within the account"),
	name: z.string().trim().min(1).max(100).describe("Newsletter name"),
	brief: z.string().trim().min(1).max(6000).describe("Private brand brief: audience, purpose, voice and subjects to cover"),
	description: z.string().trim().max(200).optional().describe("Public one-sentence description; private brief text is never copied into it"),
	slug: z.string().trim().max(40).optional().describe("Requested newsletter slug; otherwise made from the name"),
	fromEmail: z.string().trim().max(254).optional().describe("Existing account sending domain, or omit for the shared address"),
	domain: z.string().trim().max(253).optional().describe("Desired sending domain, returned as an unstarted setup step; this does not onboard that brand domain"),
	welcomeSubject: z.string().max(200).optional().describe("Subject of the disabled welcome email"),
	welcomeContent: z.string().max(30_000).optional().describe("Markdown for the disabled welcome email; otherwise a short thank-you"),
	links: z.array(z.object({ label: z.string().trim().min(1).max(80), url: z.string().trim().max(500).refine((value) => Boolean(normalizeLinkUrl(value)), "Use a web or email address") })).max(12).optional().describe("Links for the disabled link page"),
	drafts: z.array(z.object({ subject: z.string().trim().min(1).max(200), content: z.string().max(40_000).optional() })).length(4).optional().describe("Exactly four unsent issues; omitted, four empty drafts with starter titles are created"),
});
