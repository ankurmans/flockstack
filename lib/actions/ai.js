import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findCampaign } from "@/lib/actions/campaigns";
import { idInput } from "@/lib/actions/shared";
import { askModels, getAiBinding } from "@/lib/ai";
import { getAiUsage, returnAiRequest, takeAiRequest } from "@/lib/ai-usage";
import {
	LANGUAGES,
	LIMITS,
	REWRITE_STYLE_NAMES,
	SOCIAL_PLATFORMS,
	buildPreviewPrompt,
	buildRewritePrompt,
	buildSocialPrompt,
	buildSubjectPrompt,
	draftToText,
	parseOptions,
	parseSocialPosts,
} from "@/lib/ai-writing";
import { getIssuePageUrl } from "@/lib/archive-data";
import { markdownToHtml } from "@/lib/markdown";
import Newsletter from "@/models/Newsletter";

const GROUP = "AI writing";
const PRIVACY = "Only the text you send, or the campaign's draft, goes to Workers AI on Cloudflare; no subscriber's data does, and nothing is kept.";
const COUNTS = "Each call takes one of the account's AI requests for the day (get_ai_usage); a call that fails isn't counted.";

const UsageSchema = z.object({
	used: z.number().int().describe("AI requests made today (UTC), this one included"),
	limit: z.number().int().nullable().describe("The plan's requests a day. null on a self-hosted server without AI_DAILY_LIMIT: no limit"),
	resetsAt: z.string().describe("When the count starts over: the next midnight UTC"),
});

const draftInput = {
	campaign: idInput("campaign").optional().describe("The campaign whose draft to read. Send this or text."),
	text: z.string().max(LIMITS.draftChars).optional().describe(`The draft's text, ${LIMITS.draftChars.toLocaleString("en-US")} characters at most. Send this or campaign.`),
};

// The model's answer for one request, counted against today's allowance. Nothing is kept: not the text, not the answer.
async function ask(account, { system, user }, options) {
	const ai = await getAiBinding();
	if (!ai) throw actionError("unavailable", "AI writing isn't available on this server");
	const taken = await takeAiRequest(account);
	if (!taken.allowed) {
		const hours = Math.max(1, Math.ceil((Date.parse(taken.resetsAt) - Date.now()) / 3_600_000));
		throw actionError("ai_daily_limit", `You've used all ${taken.limit} AI requests for today. The count starts over at midnight UTC, in about ${hours} ${hours === 1 ? "hour" : "hours"}; a bigger plan has more.`);
	}
	const result = await askModels(ai, { system, user, ...options });
	if (!result) {
		await returnAiRequest(account);
		throw actionError("unavailable", "The AI couldn't answer just now. Try again in a minute; this request wasn't counted.");
	}
	return { text: result.text, usage: { used: taken.used, limit: taken.limit, resetsAt: taken.resetsAt } };
}

// The draft the model reads, from the campaign or the text sent, and what else it knows about the issue.
async function readDraft(account, input) {
	if (Boolean(input.campaign) === Boolean(input.text?.trim())) throw actionError("validation_failed", "Send either campaign or text");
	if (!input.campaign) return { text: input.text.trim(), subject: "", previewText: "" };
	const campaign = await findCampaign(account, input.campaign);
	const html = campaign.format === "markdown" ? markdownToHtml(campaign.markdown ?? "") : (campaign.html ?? "");
	const text = campaign.format === "html" ? draftToText(stripDocument(html)) : draftToText(html);
	if (!text) throw actionError("validation_failed", "The campaign has no text yet");
	return { text, subject: campaign.subject ?? "", previewText: campaign.previewText ?? "", campaign };
}

// A designed HTML email has a head with styles; only its body is the issue's words.
function stripDocument(html) {
	return html.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "");
}

const rewriteText = defineAction({
	name: "rewrite_text",
	title: "Rewrite text",
	group: GROUP,
	description: `Rewrites, shortens, expands, corrects, changes the tone of or translates a piece of writing you pass in, and returns the new text for you to use or discard: nothing in any campaign changes. ${PRIVACY} ${COUNTS}`,
	http: { method: "POST", path: "/ai/rewrite" },
	openWorld: true,
	idempotent: true,
	example: { text: "We is shipping the update tomorow.", style: "fix_grammar" },
	input: z.object({
		text: z.string().trim().min(1).max(LIMITS.selectionChars).describe(`The text to work on, ${LIMITS.selectionChars.toLocaleString("en-US")} characters at most`),
		style: z
			.enum(REWRITE_STYLE_NAMES)
			.describe("rewrite (clearer and tighter), shorten, expand, fix_grammar (spelling and punctuation only), friendly, formal, punchy, or translate (with language)"),
		language: z.enum(LANGUAGES).optional().describe(`With translate: ${LANGUAGES.join(", ")}`),
	}),
	output: z.object({ text: z.string().describe("The new text, paragraphs split by a blank line"), usage: UsageSchema }),
	handler: async ({ account, input }) => {
		if (input.style === "translate" && !input.language) throw actionError("validation_failed", "language: pick one to translate into");
		const { text, usage } = await ask(account, buildRewritePrompt(input), { maxTokens: 1800, temperature: input.style === "fix_grammar" ? 0.1 : 0.6 });
		return { text, usage };
	},
});

const suggestSubjectLines = defineAction({
	name: "suggest_subject_lines",
	title: "Suggest subject lines",
	group: GROUP,
	description: `Suggests ${LIMITS.subjects} subject lines for an issue from its draft. Use one as the campaign's subject, or several in update_campaign's abTest to try them on part of the audience. ${PRIVACY} ${COUNTS}`,
	http: { method: "POST", path: "/ai/subject-lines" },
	openWorld: true,
	idempotent: true,
	example: { text: "Three links on remote work, and what I learned running a team across four time zones." },
	input: z.object(draftInput),
	output: z.object({ subjects: z.array(z.string()).describe("Up to 5 subject lines"), usage: UsageSchema }),
	handler: async ({ account, input }) => {
		const draft = await readDraft(account, input);
		const { text, usage } = await ask(account, buildSubjectPrompt({ text: draft.text, previewText: draft.previewText }), { maxTokens: 500, temperature: 0.9 });
		const subjects = parseOptions(text, { count: LIMITS.subjects, maxLength: LIMITS.subjectLength });
		if (subjects.length === 0) throw actionError("unavailable", "The AI gave no usable subject lines. Try again; this request was counted.");
		return { subjects, usage };
	},
});

const suggestPreviewText = defineAction({
	name: "suggest_preview_text",
	title: "Suggest preview text",
	group: GROUP,
	description: `Suggests ${LIMITS.previews} options for the preview text, the line inbox apps show after the subject, from an issue's draft. ${PRIVACY} ${COUNTS}`,
	http: { method: "POST", path: "/ai/preview-text" },
	openWorld: true,
	idempotent: true,
	example: { text: "Three links on remote work, and what I learned running a team across four time zones.", subject: "Remote work, four time zones" },
	input: z.object({ ...draftInput, subject: z.string().trim().max(200).optional().describe("The subject line it follows. Default: the campaign's.") }),
	output: z.object({ previewTexts: z.array(z.string()).describe("Up to 3 options"), usage: UsageSchema }),
	handler: async ({ account, input }) => {
		const draft = await readDraft(account, input);
		const { text, usage } = await ask(account, buildPreviewPrompt({ text: draft.text, subject: input.subject ?? draft.subject }), { maxTokens: 400, temperature: 0.8 });
		const previewTexts = parseOptions(text, { count: LIMITS.previews, maxLength: LIMITS.previewLength });
		if (previewTexts.length === 0) throw actionError("unavailable", "The AI gave no usable preview text. Try again; this request was counted.");
		return { previewTexts, usage };
	},
});

const draftSocialPosts = defineAction({
	name: "draft_social_posts",
	title: "Draft social posts",
	group: GROUP,
	description: `Drafts a LinkedIn post and a post for X promoting an issue, from its draft: plain text to edit and post yourself. FlockStack never posts anything. A sent issue with a public page gets its link at the end. ${PRIVACY} ${COUNTS}`,
	http: { method: "POST", path: "/ai/social-posts" },
	openWorld: true,
	idempotent: true,
	example: { text: "Three links on remote work, and what I learned running a team across four time zones.", platforms: ["linkedin", "x"] },
	input: z.object({
		...draftInput,
		subject: z.string().trim().max(200).optional().describe("The issue's subject. Default: the campaign's."),
		platforms: z.array(z.enum(SOCIAL_PLATFORMS)).min(1).max(2).optional().describe("linkedin, x or both. Default: both."),
	}),
	output: z.object({
		posts: z.object({
			linkedin: z.string().optional(),
			x: z.string().optional().describe("Within X's 280 characters, its link counted"),
		}),
		usage: UsageSchema,
	}),
	handler: async ({ account, input }) => {
		const draft = await readDraft(account, input);
		const platforms = [...new Set(input.platforms ?? SOCIAL_PLATFORMS)];
		const link = draft.campaign ? await findIssueLink(account, draft.campaign) : null;
		const { text, usage } = await ask(
			account,
			buildSocialPrompt({ text: draft.text, subject: input.subject ?? draft.subject, platforms, hasLink: Boolean(link) }),
			{ maxTokens: 1200, temperature: 0.8 }
		);
		const posts = parseSocialPosts(text, platforms, { link });
		if (platforms.every((platform) => !posts[platform])) throw actionError("unavailable", "The AI gave no usable post. Try again; this request was counted.");
		return { posts: Object.fromEntries(platforms.map((platform) => [platform, posts[platform]])), usage };
	},
});

// The issue's public page, once it is sent and listed.
async function findIssueLink(account, campaign) {
	if (campaign.status !== "sent") return null;
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).lean();
	return getIssuePageUrl({ campaign, newsletter });
}

const getAiUsageAction = defineAction({
	name: "get_ai_usage",
	title: "Get today's AI usage",
	group: GROUP,
	description: "Tells how many shared AI requests (writing, images and the account assistant) the account has made today (UTC) and how many its plan gives it a day, and whether this server has AI writing at all.",
	http: { method: "GET", path: "/ai/usage" },
	readOnly: true,
	input: z.object({}),
	output: UsageSchema.extend({
		available: z.boolean().describe("False on a server without Workers AI: the AI actions answer unavailable"),
		left: z.number().int().nullable().describe("Requests left today; null with no limit"),
	}),
	handler: async ({ account }) => {
		const [{ used, limit, left, resetsAt }, ai] = await Promise.all([getAiUsage(account), getAiBinding()]);
		return { available: Boolean(ai), used, limit, left, resetsAt };
	},
});

export const aiActions = [rewriteText, suggestSubjectLines, suggestPreviewText, draftSocialPosts, getAiUsageAction];
