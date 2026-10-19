import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, idInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { formatNumber } from "@/lib/format";
import { MAX_REDIRECTS_PER_NEWSLETTER, MAX_REDIRECT_CSV_ROWS } from "@/lib/redirect-paths";
import { addRedirect, countRedirects, importRedirects } from "@/lib/redirects";
import { isObjectIdString } from "@/lib/validation";
import Redirect, { REDIRECT_SOURCES } from "@/models/Redirect";

const GROUP = "Redirects";
const SORT = { createdAt: -1, _id: -1 };
const HOW_THEY_WORK = "A redirect answers a request for its from path on the newsletter's website (its own domain or its FlockStack address) with a permanent redirect (301) to its to, keeping the query string. from matches without case, query or trailing slash. The website's fixed pages (/, /feed.xml, /sitemap.xml, /shop, /subscribe…) can't redirect; a redirect from an issue's /p/<slug> wins over the issue. A change takes up to a minute to show.";

const RedirectSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	from: z.string().describe("The path on the newsletter's website, e.g. /p/old-post"),
	to: z.string().describe("A path on the same website or an https:// address"),
	source: z.enum(REDIRECT_SOURCES).describe("import: added by a post import from the post's old address. manual: added by hand or by CSV."),
	createdAt: dateOutput,
});

function toRedirect(redirect) {
	return {
		id: String(redirect._id),
		newsletterId: String(redirect.newsletterId),
		from: redirect.path,
		to: redirect.to,
		source: redirect.source ?? "manual",
		createdAt: toIso(redirect.createdAt),
	};
}

const fromInput = z.string().trim().min(1).max(2000).describe("The old path, e.g. /p/old-post or /2023/05/old-post/. A full URL keeps its path.");
const toInput = z.string().trim().min(1).max(2000).describe("Where it goes: a path on the same website (/p/new-post) or an https:// address");

const listRedirects = defineAction({
	name: "list_redirects",
	tryWithoutPlan: true,
	title: "List redirects",
	group: GROUP,
	description: `Lists a newsletter's website redirects, newest first, 50 a page, those post imports added and those added by hand. Pass nextCursor back as cursor for the next page. ${HOW_THEY_WORK}`,
	http: { method: "GET", path: "/redirects" },
	readOnly: true,
	input: z.object({
		newsletter: newsletterInput,
		search: z.string().trim().toLowerCase().max(300).optional().describe("Redirects whose from starts with this"),
		limit: z.number().int().min(1).max(100).optional().describe("Redirects per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		redirects: z.array(RedirectSchema),
		nextCursor: z.string().nullable().describe("null on the last page"),
		total: z.number().int().describe(`The newsletter's redirects, ${formatNumber(MAX_REDIRECTS_PER_NEWSLETTER)} at most`),
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const limit = input.limit ?? 50;
		const search = input.search ? (input.search.startsWith("/") ? input.search : `/${input.search}`) : null;
		const filter = scoped(account, {
			newsletterId: newsletter._id,
			...(search && { path: { $gte: search, $lt: `${search}￿` } }),
			...(input.cursor && afterCursor(input.cursor, "createdAt")),
		});
		const [redirects, total] = await Promise.all([Redirect.find(filter).sort(SORT).limit(limit + 1).lean(), countRedirects(account, newsletter._id)]);
		const page = redirects.slice(0, limit);
		const last = page.at(-1);
		return {
			redirects: page.map(toRedirect),
			nextCursor: redirects.length > limit ? encodeCursor(last.createdAt, last._id) : null,
			total,
		};
	},
});

const addRedirectAction = defineAction({
	name: "add_redirect",
	title: "Add a redirect",
	group: GROUP,
	description: `Adds a redirect to a newsletter's website, e.g. from an old platform's address of a post to its issue. A from that already redirects answers conflict: delete it first, or use import_redirects, which replaces. ${HOW_THEY_WORK}`,
	http: { method: "POST", path: "/redirects", status: 201 },
	rateLimit: { limit: 300, window: "1 h" },
	example: { from: "/p/old-post", to: "/p/new-post" },
	input: z.object({ newsletter: newsletterInput, from: fromInput, to: toInput }),
	output: RedirectSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		return toRedirect(await addRedirect({ account, newsletterId: newsletter._id, from: input.from, to: input.to }));
	},
});

const deleteRedirect = defineAction({
	name: "delete_redirect",
	title: "Delete a redirect",
	group: GROUP,
	description: "Deletes one redirect of a newsletter's website: its old path answers as it would without it, usually page not found.",
	http: { method: "DELETE", path: "/redirects/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: idInput("redirect") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		if (!isObjectIdString(input.id)) throw actionError("not_found", "Redirect not found");
		const { deletedCount } = await Redirect.deleteOne(scoped(account, { _id: input.id }));
		if (!deletedCount) throw actionError("not_found", "Redirect not found");
		return { id: input.id, deleted: true };
	},
});

const importRedirectsAction = defineAction({
	name: "import_redirects",
	title: "Import redirects",
	group: GROUP,
	description: `Adds redirects from CSV text, ${MAX_REDIRECT_CSV_ROWS} rows at most per call: two columns, from and to, with or without a header row. A from that already redirects takes the new to. Rows that can't be a redirect are left out and counted, the first ones listed with why. ${HOW_THEY_WORK}`,
	http: { method: "POST", path: "/redirects/import" },
	idempotent: true,
	rateLimit: { limit: 60, window: "1 h" },
	example: { csv: "from,to\n/p/old-post,/p/new-post\n/2023/05/launch/,/p/launch" },
	input: z.object({
		newsletter: newsletterInput,
		csv: z.string().max(300_000).describe("The rows: from,to on each line"),
	}),
	output: z.object({
		added: z.number().int(),
		updated: z.number().int().describe("Paths that redirected already and now go to the new to"),
		invalid: z.number().int(),
		problems: z.array(z.object({ line: z.number().int(), problem: z.string() })).describe("The first rows left out, with why"),
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		return importRedirects({ account, newsletterId: newsletter._id, csv: input.csv });
	},
});

export const redirectActions = [listRedirects, addRedirectAction, deleteRedirect, importRedirectsAction];
