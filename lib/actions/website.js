import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { listIssueTags, revalidateArchive } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { cleanRichHtml } from "@/lib/clean-html";
import { markdownToHtml } from "@/lib/markdown";
import { MAX_PAGES_PER_NEWSLETTER, MAX_PAGE_BYTES, MAX_PAGE_DESCRIPTION, MAX_PAGE_TITLE, PAGE_STATUSES, getPageProblem, slugFromTitle } from "@/lib/site-page-rules";
import { MAX_NAV_ITEMS, NAV_KINDS, getNavLinks, normalizeNavigation } from "@/lib/site-navigation";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";
import SitePage from "@/models/SitePage";

const GROUP = "Website";
const SLUG_TAKEN = "An issue or another page of this newsletter already uses this slug";
const FORMATS = ["markdown", "rich"];
const pageId = idInput("page");

const PageSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	title: z.string(),
	slug: z.string().describe("The page is /<slug> under /p on the newsletter's website: /p/<slug>"),
	description: z.string().describe("For search results and link previews. Empty: the page's first words."),
	status: z.enum(PAGE_STATUSES).describe("A draft has no address; a published page does"),
	url: z.string().nullable().describe("The page's address while it is published and the website is on, else null"),
	publishedAt: dateOutput,
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const PageDetailSchema = PageSchema.extend({ content: z.string().describe("The page's HTML, cleaned: paragraphs, headings, links, images and the editor's blocks") });

const NavItemSchema = z.object({
	id: z.string(),
	kind: z.enum(NAV_KINDS),
	label: z.string().describe("The label you gave, empty for none"),
	text: z.string().describe("What the bar shows: the label, else the page's title, the tag or Archive"),
	page: z.string().nullable().describe("For a page: its ID"),
	tag: z.string().nullable().describe("For a tag: its slug"),
	url: z.string().nullable().describe("For a link: its address"),
	href: z.string().nullable().describe("Where it goes on the website now; null for a page that is a draft or gone, which the bar leaves out"),
});

function toPage(page, newsletter) {
	const id = String(page._id);
	const isLive = page.status === "published" && newsletter?.archiveEnabled;
	return {
		id,
		newsletterId: String(page.newsletterId),
		title: page.title,
		slug: page.slug,
		description: page.description ?? "",
		status: page.status,
		url: isLive ? getArchiveUrls(newsletter).absolutePost(page.slug) : null,
		publishedAt: toIso(page.publishedAt),
		createdAt: toIso(page.createdAt),
		updatedAt: toIso(page.updatedAt),
	};
}

function toPageDetail(page, newsletter) {
	return { ...toPage(page, newsletter), content: page.html ?? "" };
}

async function findPage(account, id) {
	const page = isObjectIdString(id) ? await SitePage.findOne(scoped(account, { _id: id })).lean() : null;
	if (!page) throw actionError("not_found", "Page not found");
	return page;
}

// Pages share /p/ with the issues: a slug an issue of the newsletter uses isn't free for a page.
async function assertSlugFree(account, { newsletterId, slug, exceptId }) {
	const [issue, page] = await Promise.all([
		Campaign.exists(scoped(account, { newsletterId, archiveSlug: slug })),
		SitePage.exists(scoped(account, { newsletterId, slug, ...(exceptId && { _id: { $ne: exceptId } }) })),
	]);
	if (issue || page) throw actionError("conflict", SLUG_TAKEN);
}

function readContent(format, content) {
	const html = cleanRichHtml(format === "markdown" ? markdownToHtml(content) : content);
	if (new TextEncoder().encode(html).length > MAX_PAGE_BYTES) throw actionError("validation_failed", `content: a page can hold ${MAX_PAGE_BYTES / 1000} KB at most`);
	return html;
}

function assertValid(fields) {
	const problem = getPageProblem(fields);
	if (problem) throw actionError("validation_failed", problem);
}

const titleInput = z.string().trim().max(MAX_PAGE_TITLE).describe(`The page's title, ${MAX_PAGE_TITLE} characters at most`);
const slugInput = z
	.string()
	.trim()
	.toLowerCase()
	.max(120)
	.describe("The page's path: /p/<slug>. Lowercase letters, digits and dashes. Default: made from the title. It can't be one an issue of the newsletter uses.");
const descriptionInput = z.string().trim().max(MAX_PAGE_DESCRIPTION).describe(`For search results and link previews, ${MAX_PAGE_DESCRIPTION} characters at most. Empty: the page's first words.`);
const formatInput = z.enum(FORMATS).describe("markdown (the default) or rich: an HTML fragment, what the dashboard editor writes");
const contentInput = z.string().max(MAX_PAGE_BYTES * 2).describe(`The page's body in that format, ${MAX_PAGE_BYTES / 1000} KB at most once cleaned`);
const statusInput = z.enum(PAGE_STATUSES).describe("published puts the page on the website at its address; draft keeps it private. Default: draft.");

const listPages = defineAction({
	name: "list_pages",
	tryWithoutPlan: true,
	title: "List website pages",
	group: GROUP,
	description: `Lists the custom pages of a newsletter's website (About, Sponsor, Contact…), oldest first, with their addresses. A newsletter has up to ${MAX_PAGES_PER_NEWSLETTER}. Content is left out; get_page has it.`,
	http: { method: "GET", path: "/pages" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: z.object({ pages: z.array(PageSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const pages = await SitePage.find(scoped(account, { newsletterId: newsletter._id })).sort({ createdAt: 1, _id: 1 }).select({ html: 0 }).lean();
		return { pages: pages.map((page) => toPage(page, newsletter)) };
	},
});

const getPage = defineAction({
	name: "get_page",
	tryWithoutPlan: true,
	title: "Get a website page",
	group: GROUP,
	description: "Gets a custom page of a newsletter's website with its content as cleaned HTML, drafts included.",
	http: { method: "GET", path: "/pages/{id}" },
	readOnly: true,
	input: z.object({ id: pageId }),
	output: PageDetailSchema,
	handler: async ({ account, input }) => {
		const page = await findPage(account, input.id);
		return toPageDetail(page, await Newsletter.findOne(scoped(account, { _id: page.newsletterId })).lean());
	},
});

const createPage = defineAction({
	name: "create_page",
	tryWithoutPlan: true,
	title: "Create a website page",
	group: GROUP,
	description: `Creates a custom page for the newsletter's website: About, Sponsor, Contact, anything. It is a draft until status is published, and then it lives at /p/<slug> on the newsletter's host. Add it to the navigation with update_navigation. A newsletter has up to ${MAX_PAGES_PER_NEWSLETTER} pages.`,
	http: { method: "POST", path: "/pages", status: 201 },
	example: { title: "About", content: "I write about small software companies.", status: "published" },
	input: z.object({
		newsletter: newsletterInput,
		title: titleInput.min(1),
		slug: slugInput.optional(),
		description: descriptionInput.optional(),
		format: formatInput.optional(),
		content: contentInput.optional(),
		status: statusInput.optional(),
	}),
	output: PageDetailSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const slug = input.slug || slugFromTitle(input.title);
		const html = input.content ? readContent(input.format ?? "markdown", input.content) : "";
		assertValid({ title: input.title, slug, description: input.description, html });
		if ((await SitePage.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_PAGES_PER_NEWSLETTER) {
			throw actionError("conflict", `A newsletter has up to ${MAX_PAGES_PER_NEWSLETTER} pages: delete one you don't use`);
		}
		await assertSlugFree(account, { newsletterId: newsletter._id, slug });
		const status = input.status ?? "draft";
		let page;
		try {
			page = await SitePage.create({
				accountId: account._id,
				newsletterId: newsletter._id,
				title: input.title,
				slug,
				html,
				...(input.description && { description: input.description }),
				status,
				...(status === "published" && { publishedAt: new Date() }),
			});
		} catch (error) {
			if (error?.code === 11000) throw actionError("conflict", SLUG_TAKEN);
			throw error;
		}
		revalidateArchive();
		return toPageDetail(page.toObject(), newsletter);
	},
});

const updatePage = defineAction({
	name: "update_page",
	tryWithoutPlan: true,
	title: "Update a website page",
	group: GROUP,
	description:
		"Changes a custom page's title, path, description, content or status. Send only the fields to change; format goes with content. Publishing puts it on the website; a draft goes offline, and the navigation leaves it out until it is published again. Changing the slug changes the page's address.",
	http: { method: "PATCH", path: "/pages/{id}" },
	idempotent: true,
	example: { status: "published" },
	input: z.object({
		id: pageId,
		title: titleInput.min(1).optional(),
		slug: slugInput.optional(),
		description: descriptionInput.optional(),
		format: formatInput.optional().describe("With content: the format it's in. Default: markdown."),
		content: contentInput.optional(),
		status: statusInput.optional(),
	}),
	output: PageDetailSchema,
	handler: async ({ account, input }) => {
		const page = await findPage(account, input.id);
		if (input.format !== undefined && input.content === undefined) throw actionError("validation_failed", "format: send content with it");
		const next = {
			title: input.title ?? page.title,
			slug: input.slug ?? page.slug,
			description: input.description ?? page.description ?? "",
			html: input.content === undefined ? (page.html ?? "") : readContent(input.format ?? "markdown", input.content),
		};
		assertValid(next);
		if (next.slug !== page.slug) await assertSlugFree(account, { newsletterId: page.newsletterId, slug: next.slug, exceptId: page._id });
		const set = {
			title: next.title,
			slug: next.slug,
			html: next.html,
			...(input.status && { status: input.status }),
			...(input.status === "published" && page.status !== "published" && { publishedAt: new Date() }),
		};
		const unset = next.description ? {} : { description: 1 };
		if (next.description) set.description = next.description;
		try {
			await SitePage.updateOne(scoped(account, { _id: page._id }), { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) });
		} catch (error) {
			if (error?.code === 11000) throw actionError("conflict", SLUG_TAKEN);
			throw error;
		}
		revalidateArchive();
		return toPageDetail(await findPage(account, input.id), await Newsletter.findOne(scoped(account, { _id: page.newsletterId })).lean());
	},
});

const deletePage = defineAction({
	name: "delete_page",
	tryWithoutPlan: true,
	title: "Delete a website page",
	group: GROUP,
	description: "Deletes a custom page and takes it out of the navigation. Its address stops working. A deleted page can't be restored.",
	http: { method: "DELETE", path: "/pages/{id}" },
	destructive: true,
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: pageId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const page = await findPage(account, input.id);
		await SitePage.deleteOne(scoped(account, { _id: page._id }));
		const newsletter = await Newsletter.findOne(scoped(account, { _id: page.newsletterId })).select({ navigation: 1 }).lean();
		const kept = (newsletter?.navigation ?? []).filter((item) => item.pageId !== String(page._id));
		if (kept.length !== (newsletter?.navigation ?? []).length) await Newsletter.updateOne(scoped(account, { _id: page.newsletterId }), { $set: { navigation: kept } });
		revalidateArchive();
		return { id: String(page._id), deleted: true };
	},
});

async function toNavigationOutput(account, newsletter) {
	const pages = await SitePage.find(scoped(account, { newsletterId: newsletter._id })).select({ html: 0 }).lean();
	const urls = getArchiveUrls(newsletter);
	const links = new Map(getNavLinks(newsletter, pages.filter((page) => page.status === "published"), urls).map((link) => [link.id, link]));
	const byId = new Map(pages.map((page) => [String(page._id), page]));
	return {
		items: (newsletter.navigation ?? []).map((item) => ({
			id: item.id,
			kind: item.kind,
			label: item.label ?? "",
			text: links.get(item.id)?.label ?? item.label ?? byId.get(item.pageId)?.title ?? item.tag ?? "",
			page: item.pageId ?? null,
			tag: item.tag ?? null,
			url: item.url ?? null,
			href: links.get(item.id)?.href ?? null,
		})),
	};
}

const getNavigation = defineAction({
	name: "get_navigation",
	tryWithoutPlan: true,
	title: "Get the website's navigation",
	group: GROUP,
	description: `Gets the navigation bar of a newsletter's website: its links in order, each a page, a tag's page, the list of issues or any https:// address. Up to ${MAX_NAV_ITEMS} links.`,
	http: { method: "GET", path: "/navigation" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: z.object({ items: z.array(NavItemSchema) }),
	handler: async ({ account, input }) => toNavigationOutput(account, await findNewsletter(account, input.newsletter)),
});

const updateNavigation = defineAction({
	name: "update_navigation",
	tryWithoutPlan: true,
	title: "Update the website's navigation",
	group: GROUP,
	description: `Replaces the navigation bar of a newsletter's website with the links sent, in that order: up to ${MAX_NAV_ITEMS}. A link is a page (kind page, with page: its ID or slug), a tag's page (tag), the list of issues (archive) or an https:// address (link, with a label). Without a label, a page shows its title. A page that is a draft stays out of the bar until it is published. Send an empty list to clear the bar.`,
	http: { method: "PATCH", path: "/navigation" },
	idempotent: true,
	example: { items: [{ kind: "archive" }, { kind: "link", label: "Podcast", url: "https://example.com/podcast" }] },
	input: z.object({
		newsletter: newsletterInput,
		items: z
			.array(
				z.object({
					id: z.string().max(40).optional().describe("The link's ID from get_navigation, to keep it the same link when you reorder"),
					kind: z.enum(NAV_KINDS),
					label: z.string().trim().max(60).optional().describe("What the bar shows, 40 characters at most. Required for a link."),
					page: z.string().trim().max(120).optional().describe("For kind page: the page's ID or slug"),
					tag: z.string().trim().max(120).optional().describe("For kind tag: the tag, or its slug"),
					url: z.string().trim().max(500).optional().describe("For kind link: an https:// address"),
				})
			)
			.max(MAX_NAV_ITEMS + 1)
			.describe("The links in the order they show"),
	}),
	output: z.object({ items: z.array(NavItemSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const pages = await SitePage.find(scoped(account, { newsletterId: newsletter._id })).select({ html: 0 }).lean();
		const pageIds = new Set(pages.map((page) => String(page._id)));
		const resolved = input.items.map((item) => {
			if (item.kind !== "page") return item;
			const reference = item.page ?? "";
			const found = pages.find((page) => String(page._id) === reference || page.slug === reference.toLowerCase());
			return { ...item, pageId: found ? String(found._id) : reference };
		});
		const result = normalizeNavigation(resolved, { pageIds });
		if (result.problem) throw actionError("validation_failed", `items: ${result.problem}`);
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { navigation: result.items } });
		revalidateArchive();
		return toNavigationOutput(account, await Newsletter.findOne(scoped(account, { _id: newsletter._id })).lean());
	},
});

const listTags = defineAction({
	name: "list_issue_tags",
	tryWithoutPlan: true,
	title: "List issue tags",
	group: GROUP,
	description: "Lists the tags on a newsletter's published issues, most used first, with the address of each tag's page. Tag an issue with the tags of create_campaign, update_campaign or update_campaign_archive.",
	http: { method: "GET", path: "/issue-tags" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: z.object({
		tags: z.array(
			z.object({
				name: z.string(),
				slug: z.string(),
				issues: z.number().int().describe("Issues on the website that carry it"),
				url: z.string().nullable().describe("The tag's page, while the website is on"),
			})
		),
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const tags = await listIssueTags(newsletter);
		const urls = getArchiveUrls(newsletter);
		return { tags: tags.map((tag) => ({ ...tag, url: newsletter.archiveEnabled ? urls.absoluteTag(tag.slug) : null })) };
	},
});

export const websiteActions = [listPages, getPage, createPage, updatePage, deletePage, getNavigation, updateNavigation, listTags];
