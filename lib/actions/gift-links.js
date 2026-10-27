import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, newsletterInput, toIso } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { GIFT_LINK_LIMITS, GIFT_LINK_STATES, getGiftLinkProblem, getGiftLinkSettings, getGiftLinkState } from "@/lib/gift-link-rules";
import { createGiftLink, findGiftableIssue, getGiftLinkUrl, revokeGiftLink } from "@/lib/gift-links";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import GiftLink from "@/models/GiftLink";
import Newsletter from "@/models/Newsletter";

const GROUP = "Gift links";
const HOW_IT_WORKS = "A gift link opens one paid issue's page on your website for whoever holds it, with no subscription: the rest of the archive, the email, comments and audio stay closed. A paid subscriber can make one from the issue itself when you allow it, and you can make one too. Each link opens in a limited number of browsers, ends on its date and can be taken back at once.";

const SettingsSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean().describe("Paid subscribers can make gift links from the issues they read"),
	perReaderPerMonth: z.number().int().describe("Links one subscriber may make a month (UTC)"),
	opensPerLink: z.number().int().describe("Browsers a reader's link opens in"),
	days: z.number().int().describe("Days a reader's link lasts"),
});

const LinkSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	issue: z.object({ id: z.string(), subject: z.string() }),
	url: z.string().describe("The link to share: the issue's page with the secret code. Anyone who has it can read that one issue until it ends"),
	createdBy: z.enum(["owner", "reader"]),
	reader: z.string().nullable().describe("The subscriber's email when a reader made it"),
	note: z.string().nullable(),
	opens: z.number().int().describe("Browsers that have opened it. A browser counts once, however often it reads"),
	maxOpens: z.number().int(),
	status: z.enum(GIFT_LINK_STATES).describe("active, used_up (opened in as many browsers as it allows), expired or revoked"),
	expiresAt: dateOutput,
	lastOpenedAt: dateOutput,
	revokedAt: dateOutput,
	createdAt: dateOutput,
});

function toSettings(newsletter) {
	return { newsletterId: String(newsletter._id), ...getGiftLinkSettings(newsletter) };
}

async function toLinks(account, newsletter, links) {
	const [issues, readers] = await Promise.all([
		Campaign.find(scoped(account, { _id: { $in: [...new Set(links.map(({ campaignId }) => String(campaignId)))] } })).select({ subject: 1, archiveSlug: 1 }).lean(),
		Contact.find(scoped(account, { _id: { $in: links.map(({ contactId }) => contactId).filter(Boolean) } })).select({ email: 1 }).lean(),
	]);
	const issueOf = new Map(issues.map((issue) => [String(issue._id), issue]));
	const emailOf = new Map(readers.map(({ _id, email }) => [String(_id), email]));
	return links.map((link) => {
		const issue = issueOf.get(String(link.campaignId));
		return {
			id: String(link._id),
			newsletterId: String(link.newsletterId),
			issue: { id: String(link.campaignId), subject: issue?.subject ?? "" },
			url: issue?.archiveSlug ? getGiftLinkUrl(newsletter, issue, link.code) : "",
			createdBy: link.createdBy,
			reader: link.contactId ? (emailOf.get(String(link.contactId)) ?? null) : null,
			note: link.note ?? null,
			opens: link.opens ?? 0,
			maxOpens: link.maxOpens,
			status: getGiftLinkState(link),
			expiresAt: toIso(link.expiresAt),
			lastOpenedAt: toIso(link.lastOpenedAt),
			revokedAt: toIso(link.revokedAt),
			createdAt: toIso(link.createdAt),
		};
	});
}

const setGiftLinks = defineAction({
	name: "set_gift_links",
	tryWithoutPlan: true,
	title: "Set a newsletter's gift links",
	group: GROUP,
	description: `Turns on or off paid subscribers' gift links for a newsletter and sets their limits. ${HOW_IT_WORKS} Links you make yourself (create_gift_link) work whether this is on or not. Send only the fields to change.`,
	http: { method: "PATCH", path: "/newsletters/{id}/gift-links" },
	idempotent: true,
	example: { enabled: true, perReaderPerMonth: 3, opensPerLink: 10, days: 30 },
	input: z.object({
		id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug"),
		enabled: z.boolean().optional().describe("Let paid subscribers make gift links. Off by default."),
		perReaderPerMonth: z.number().int().optional().describe(`How many links one subscriber may make a month, ${GIFT_LINK_LIMITS.perReaderPerMonth.min} to ${GIFT_LINK_LIMITS.perReaderPerMonth.max}. Default ${GIFT_LINK_LIMITS.perReaderPerMonth.default}.`),
		opensPerLink: z.number().int().optional().describe(`How many browsers a subscriber's link opens in, ${GIFT_LINK_LIMITS.opens.min} to ${GIFT_LINK_LIMITS.opens.max}. Default ${GIFT_LINK_LIMITS.opens.default}.`),
		days: z.number().int().optional().describe(`How many days a subscriber's link lasts, ${GIFT_LINK_LIMITS.days.min} to ${GIFT_LINK_LIMITS.days.max}. Default ${GIFT_LINK_LIMITS.days.default}.`),
	}),
	output: SettingsSchema,
	handler: async ({ account, input: { id, ...changes } }) => {
		const newsletter = await findNewsletter(account, id);
		const next = { ...getGiftLinkSettings(newsletter), ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
		const problem = getGiftLinkProblem(next);
		if (problem) throw actionError("validation_failed", problem);
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { giftLinks: next } });
		revalidateArchive();
		return toSettings({ ...newsletter, giftLinks: next });
	},
});

const createLink = defineAction({
	name: "create_gift_link",
	tryWithoutPlan: true,
	title: "Make a gift link",
	group: GROUP,
	description: `Makes a link to one paid issue that anyone can open without subscribing, for a reader you want to win over, a reviewer or a friend. ${HOW_IT_WORKS} The issue has to be sent and have a page on your website. Nothing is emailed: you share the link yourself.`,
	http: { method: "POST", path: "/gift-links" },
	example: { campaign: "6650f1c2e9b1d4a0123456bb", opens: 5, days: 14, note: "For the reviewer" },
	input: z.object({
		newsletter: newsletterInput,
		campaign: z.string().trim().min(1).max(100).describe("The paid issue's ID"),
		opens: z.number().int().min(GIFT_LINK_LIMITS.opens.min).max(GIFT_LINK_LIMITS.opens.max).optional().describe(`How many browsers it opens in. Default: the newsletter's setting, ${GIFT_LINK_LIMITS.opens.default} unless changed.`),
		days: z.number().int().min(GIFT_LINK_LIMITS.days.min).max(GIFT_LINK_LIMITS.days.max).optional().describe("How many days it lasts. Default: the newsletter's setting."),
		note: z.string().trim().max(GIFT_LINK_LIMITS.note).optional().describe("A private note for you, like who it is for"),
	}),
	output: LinkSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const issue = await findGiftableIssue(account, newsletter, input.campaign);
		const link = await createGiftLink({ account, newsletter, issue, createdBy: "owner", opens: input.opens, days: input.days, note: input.note });
		return (await toLinks(account, newsletter, [link]))[0];
	},
});

const listLinks = defineAction({
	name: "list_gift_links",
	tryWithoutPlan: true,
	title: "List gift links",
	group: GROUP,
	description: `Lists a newsletter's gift links, newest first, 50 a page, with how many browsers opened each and whether it is still active, and the newsletter's settings. ${HOW_IT_WORKS} The links hold secret codes: share them only with the people they are for.`,
	http: { method: "GET", path: "/gift-links" },
	readOnly: true,
	example: { limit: 20 },
	input: z.object({
		newsletter: newsletterInput,
		campaign: z.string().trim().max(100).optional().describe("Only this issue's links"),
		limit: z.number().int().min(1).max(100).optional().describe("Links per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({ settings: SettingsSchema, links: z.array(LinkSchema), nextCursor: z.string().nullable().describe("null on the last page") }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		if (input.campaign && !isObjectIdString(input.campaign)) throw actionError("validation_failed", "campaign isn't an issue ID");
		const limit = input.limit ?? 50;
		const links = await GiftLink.find(scoped(account, { newsletterId: newsletter._id, ...(input.campaign && { campaignId: input.campaign }), ...(input.cursor && afterCursor(input.cursor, "createdAt")) }))
			.sort({ createdAt: -1, _id: -1 })
			.limit(limit + 1)
			.lean();
		const page = links.slice(0, limit);
		const last = page.at(-1);
		return { settings: toSettings(newsletter), links: await toLinks(account, newsletter, page), nextCursor: links.length > limit ? encodeCursor(last.createdAt, last._id) : null };
	},
});

const revokeLink = defineAction({
	name: "revoke_gift_link",
	tryWithoutPlan: true,
	title: "Take a gift link back",
	group: GROUP,
	description: "Ends a gift link at once, whoever made it: nobody can open the issue with it from now on, including a browser that already did. It can't be turned back on; make another link instead.",
	http: { method: "DELETE", path: "/gift-links/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: z.string().trim().min(1).max(100).describe("The gift link's ID") }),
	output: LinkSchema,
	handler: async ({ account, input }) => {
		const link = await revokeGiftLink(account, input.id);
		const newsletter = await Newsletter.findOne(scoped(account, { _id: link.newsletterId })).lean();
		return (await toLinks(account, newsletter, [link]))[0];
	},
});

export const giftLinkActions = [setGiftLinks, createLink, listLinks, revokeLink];
