import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, newsletterInput } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { LINK_PAGE_LIMITS, readLinks, toLinkPage } from "@/lib/link-page";
import Newsletter from "@/models/Newsletter";

const GROUP = "Newsletters";
const FIELDS = "name slug archiveEnabled archiveHost linkPage";
const LinkSchema = z.object({
	label: z.string().describe("The text of the link's button"),
	url: z.string().describe("An https:// address, or mailto:"),
});
const LinkPageSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean(),
	title: z.string().describe("Shown above the links. Empty: the newsletter's name."),
	bio: z.string().describe("A line or two under the title"),
	links: z.array(LinkSchema).describe("In the order the page shows them"),
	url: z.string().describe("The page's address: /links on the newsletter's website"),
	isLive: z.boolean().describe("The page is on, and the newsletter's website too (it goes online with the first sent issue): otherwise the address answers 404"),
});

function toOutput(newsletter) {
	return { newsletterId: String(newsletter._id), ...toLinkPage(newsletter), url: getArchiveUrls(newsletter).absoluteLinks, isLive: Boolean(newsletter.linkPage?.enabled && newsletter.archiveEnabled) };
}

const getLinkPage = defineAction({
	name: "get_link_page",
	tryWithoutPlan: true,
	title: "Get a newsletter's link page",
	group: GROUP,
	description:
		"Gets a newsletter's link-in-bio page: the title, bio and links it lists, whether it is on, and its address (/links on the newsletter's website). Handy for a social profile that allows one link.",
	http: { method: "GET", path: "/link-page" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: LinkPageSchema,
	handler: async ({ account, input }) => toOutput(await findNewsletter(account, input.newsletter, FIELDS)),
});

const updateLinkPage = defineAction({
	name: "update_link_page",
	tryWithoutPlan: true,
	title: "Update a newsletter's link page",
	group: GROUP,
	description: `Turns a newsletter's link-in-bio page on or off and sets what it lists. Send only what changes; links replaces the whole list, ${LINK_PAGE_LIMITS.links} at most, each with a label and an https:// or mailto: address (a bare "example.com/shop" becomes https://). The page is at /links on the newsletter's website, which goes online with its first sent issue.`,
	http: { method: "PATCH", path: "/link-page" },
	idempotent: true,
	example: { enabled: true, title: "Field Notes", links: [{ label: "Read the latest issue", url: "https://example.com/p/latest" }] },
	input: z.object({
		newsletter: newsletterInput,
		enabled: z.boolean().optional().describe("Turn the page on or off. Off keeps what it lists."),
		title: z.string().trim().max(LINK_PAGE_LIMITS.title).optional().describe(`Shown above the links, ${LINK_PAGE_LIMITS.title} characters at most. Empty: the newsletter's name.`),
		bio: z.string().trim().max(LINK_PAGE_LIMITS.bio).optional().describe(`A line or two under the title, ${LINK_PAGE_LIMITS.bio} characters at most`),
		links: z
			.array(z.object({ label: z.string().max(200).describe(`The button's text, ${LINK_PAGE_LIMITS.label} characters at most`), url: z.string().max(LINK_PAGE_LIMITS.url + 100).describe("An https:// address, or an email address") }))
			.max(LINK_PAGE_LIMITS.links + 10)
			.optional()
			.describe(`The whole list, in order, ${LINK_PAGE_LIMITS.links} at most`),
	}),
	output: LinkPageSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, FIELDS);
		const set = {};
		if (input.enabled !== undefined) set["linkPage.enabled"] = input.enabled;
		if (input.title !== undefined) set["linkPage.title"] = input.title;
		if (input.bio !== undefined) set["linkPage.bio"] = input.bio;
		if (input.links !== undefined) {
			const { links, error } = readLinks(input.links);
			if (error) throw actionError("validation_failed", error);
			set["linkPage.links"] = links;
		}
		if (Object.keys(set).length > 0) {
			await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: set });
			revalidateArchive();
		}
		return toOutput(await Newsletter.findOne(scoped(account, { _id: newsletter._id })).select(FIELDS).lean());
	},
});

export const linkPageActions = [getLinkPage, updateLinkPage];
