import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { decodeBase64Image } from "@/lib/image-files";
import { formatNumber } from "@/lib/format";
import { CHUNK_POSTS, createPostImport, findPostImport, listPostImports, startPostImport } from "@/lib/post-import";
import { POST_SOURCES } from "@/lib/post-import-formats";
import { MAX_IMAGES_PER_IMPORT, MAX_IMPORT_FILE_BYTES } from "@/lib/post-import-report";
import { fetchRemoteFile } from "@/lib/remote-image";
import { POST_IMPORT_STATUSES } from "@/models/PostImport";

const GROUP = "Post import";
// Requests through the API carry the file as base64, a third larger than the file; bigger exports come by url.
const MAX_BASE64_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_BASE64_FILE_BYTES / 3) * 4 + 100;
const MB = 1024 * 1024;
const SOURCES = "Substack's export ZIP (posts.csv and posts/), beehiiv's posts CSV (Settings > Export data > Export all posts), WordPress's XML (Tools > Export) or Ghost's JSON (Settings > Labs > Export)";

const countsSchema = z.object({
	imported: z.number().int().describe("Posts that became issues"),
	existing: z.number().int().describe("Posts the newsletter had from an earlier import: skipped, their redirect kept"),
	overLimit: z.number().int().describe("Posts left out past the plan's posts per import"),
	failed: z.number().int().describe("Posts that couldn't become an issue: problems says why"),
	images: z.number().int().describe("Pictures copied to FlockStack's CDN"),
	imageFailures: z.number().int().describe("Pictures left at their old address: the link failed, it wasn't a picture, or a cap was reached"),
	imageBytes: z.number().int().describe("What the copied pictures weigh"),
	redirects: z.number().int().describe("Redirects added from the posts' old addresses"),
});

const PostImportSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	source: z.enum(POST_SOURCES),
	status: z
		.enum(POST_IMPORT_STATUSES)
		.describe("ready: read and previewed, waiting for start_post_import. queued and running: importing. done: finished, counts has the report. failed: it stopped, error says why; starting it again picks up the rest."),
	fileName: z.string().nullable(),
	siteUrl: z.string().nullable().describe("The old site's address, used for relative links and Ghost's pictures"),
	preview: z.object({
		posts: z.number().int().describe("Published posts in the export"),
		paid: z.number().int().describe("Of those, the ones for paid subscribers: they become issues for paid readers, with a teaser on the website"),
		titles: z.array(z.string()).describe("The newest posts' titles"),
		newest: dateOutput,
		oldest: dateOutput,
		skipped: z.object({
			drafts: z.number().int().describe("Drafts and unpublished posts, left out"),
			other: z.number().int().describe("Pages, podcasts and threads, left out"),
			missingContent: z.number().int().describe("Posts with no content or date in the export, left out"),
		}),
	}),
	limits: z
		.object({ posts: z.number().int(), imageBytes: z.number().int() })
		.nullable()
		.describe("The plan's caps the import runs with: new posts it may add, and what every import's pictures may weigh together. null on a self-hosted server, or before it starts."),
	progress: z.object({ done: z.number().int(), total: z.number().int() }).describe("Posts gone through so far"),
	counts: countsSchema,
	problems: z.array(z.object({ title: z.string(), problem: z.string() })).describe("The first posts that couldn't be imported, with why"),
	error: z.string().nullable(),
	createdAt: dateOutput,
	startedAt: dateOutput,
	finishedAt: dateOutput,
	emailed: z.boolean().describe("The account owner got the report by email"),
});

function toPostImport(postImport) {
	const total = postImport.preview?.posts ?? 0;
	const state = postImport.state;
	const done = postImport.status === "done" ? total : state ? Math.min(total, state.chunk * CHUNK_POSTS + state.index) : 0;
	const counts = postImport.counts ?? {};
	return {
		id: String(postImport._id),
		newsletterId: String(postImport.newsletterId),
		source: postImport.source,
		status: postImport.status,
		fileName: postImport.fileName ?? null,
		siteUrl: postImport.siteUrl ?? null,
		preview: {
			posts: total,
			paid: postImport.preview?.paid ?? 0,
			titles: postImport.preview?.titles ?? [],
			newest: toIso(postImport.preview?.newest),
			oldest: toIso(postImport.preview?.oldest),
			skipped: {
				drafts: postImport.preview?.skipped?.drafts ?? 0,
				other: postImport.preview?.skipped?.other ?? 0,
				missingContent: postImport.preview?.skipped?.missingContent ?? 0,
			},
		},
		limits: postImport.limits?.posts === undefined ? null : { posts: postImport.limits.posts, imageBytes: postImport.limits.imageBytes },
		progress: { done, total },
		counts: Object.fromEntries(Object.keys(countsSchema.shape).map((key) => [key, counts[key] ?? 0])),
		problems: (postImport.problems ?? []).map(({ title, problem }) => ({ title: String(title), problem: String(problem) })),
		error: postImport.error ?? null,
		createdAt: toIso(postImport.createdAt),
		startedAt: toIso(postImport.startedAt),
		finishedAt: toIso(postImport.finishedAt),
		emailed: Boolean(postImport.emailedAt),
	};
}

function readFileName(url) {
	try {
		return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || undefined;
	} catch {
		return undefined;
	}
}

async function requirePostImport(account, id) {
	const postImport = await findPostImport(account, id);
	if (!postImport) throw actionError("not_found", "Import not found");
	return postImport;
}

const createPostImportAction = defineAction({
	name: "create_post_import",
	title: "Upload a post archive",
	group: GROUP,
	description: `Reads an export of another platform's posts into a newsletter: ${SOURCES}. Send the file as base64 (under ${MAX_BASE64_FILE_BYTES / MB} MB) or an https:// link FlockStack downloads (under ${MAX_IMPORT_FILE_BYTES / MB} MB). Nothing is imported yet: the answer previews how many published posts the export has, how many are for paid subscribers and the newest titles. start_post_import then imports them. Drafts, pages and podcasts are left out.`,
	http: { method: "POST", path: "/post-imports", status: 201 },
	openWorld: true,
	rateLimit: { limit: 20, window: "1 h" },
	example: { url: "https://example.com/substack-export.zip" },
	input: z.object({
		newsletter: newsletterInput,
		source: z.enum(POST_SOURCES).optional().describe("The platform the export comes from. Default: told from the file."),
		base64: z.string().max(MAX_BASE64_LENGTH).optional().describe("The export file, base64 encoded"),
		url: z.string().max(2000).optional().describe("An https:// link to the export file"),
		fileName: z.string().max(200).optional().describe("The file's name, shown in the dashboard"),
		siteUrl: z
			.string()
			.max(300)
			.optional()
			.describe("The old site's address, e.g. https://news.example.com: Ghost exports need it to bring their pictures, and relative links resolve against it. WordPress's comes from its export."),
	}),
	// The dashboard's upload sends the file's bytes as they are.
	dashboardInput: z.object({ file: z.instanceof(Uint8Array).optional() }),
	output: PostImportSchema,
	handler: async ({ account, user, input, via }) => {
		const given = [input.file, input.base64, input.url].filter(Boolean);
		if (given.length !== 1) throw actionError("validation_failed", "Send the export as base64 or url");
		const newsletter = await findNewsletter(account, input.newsletter);
		let bytes = input.file;
		if (input.base64) {
			bytes = decodeBase64Image(input.base64);
			if (!bytes) throw actionError("validation_failed", "base64 isn't valid base64");
			if (bytes.length > MAX_BASE64_FILE_BYTES) throw actionError("validation_failed", `Send an export over ${MAX_BASE64_FILE_BYTES / MB} MB as a url`);
		} else if (input.url) {
			bytes = await fetchRemoteFile(input.url, { maxBytes: MAX_IMPORT_FILE_BYTES, label: "Exports" });
		}
		const fileName = input.fileName || (input.url ? readFileName(input.url) : undefined);
		const postImport = await createPostImport({ account, user, via, newsletter, bytes, fileName, source: input.source, siteUrl: input.siteUrl });
		return toPostImport(postImport);
	},
});

const startPostImportAction = defineAction({
	name: "start_post_import",
	title: "Start a post import",
	group: GROUP,
	description: `Imports the posts of an uploaded archive (create_post_import) in the background: each published post becomes an issue already sent on its original date, with its title, subtitle and author, listed on the newsletter's website. No email goes out and nothing counts toward the month's emails. Posts for paid subscribers become issues for paid readers. Pictures are copied to FlockStack's CDN (${formatNumber(MAX_IMAGES_PER_IMPORT)} per import at most, 4 MB each); one that can't be copied keeps its old link. Each post's old address (/p/<slug> on Substack and beehiiv, the permalink on WordPress, /<slug>/ on Ghost) redirects to its new page once that address points at FlockStack. A post the newsletter already has from an earlier import is skipped, so importing the same export again only adds what is missing. On FlockStack Cloud the plan caps the new posts of one import and what imported pictures may weigh. get_post_import follows its progress; the account owner gets the report by email.`,
	http: { method: "POST", path: "/post-imports/{id}/start", status: 202 },
	idempotent: true,
	openWorld: true,
	rateLimit: { limit: 20, window: "1 h" },
	input: z.object({ id: idInput("import") }),
	output: PostImportSchema.extend({ started: z.boolean().describe("False when it was already queued or running") }),
	handler: async ({ account, input }) => {
		const { postImport, isNew } = await startPostImport({ account, postImport: await requirePostImport(account, input.id) });
		return { ...toPostImport(postImport), started: isNew };
	},
});

const getPostImport = defineAction({
	name: "get_post_import",
	tryWithoutPlan: true,
	title: "Get a post import",
	group: GROUP,
	description: "Gets a post import: its preview, status, progress and, once done, its report of posts imported, skipped and left out, pictures copied and redirects added.",
	http: { method: "GET", path: "/post-imports/{id}" },
	readOnly: true,
	input: z.object({ id: idInput("import") }),
	output: PostImportSchema,
	handler: async ({ account, input }) => toPostImport(await requirePostImport(account, input.id)),
});

const listPostImportsAction = defineAction({
	name: "list_post_imports",
	tryWithoutPlan: true,
	title: "List post imports",
	group: GROUP,
	description: "Lists the account's post imports, newest first, the last 20.",
	http: { method: "GET", path: "/post-imports" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput }),
	output: z.object({ imports: z.array(PostImportSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		return { imports: (await listPostImports(account, { newsletterId: newsletter?._id })).map(toPostImport) };
	},
});

export const postImportActions = [createPostImportAction, startPostImportAction, getPostImport, listPostImportsAction];
