import "server-only";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { findOwnerEmail } from "@/lib/accounts";
import { sendAlert } from "@/lib/alerts";
import { revalidateArchive } from "@/lib/archive-data";
import { uniqueArchiveSlug } from "@/lib/archive-slugs";
import { cleanRichHtml } from "@/lib/clean-html";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { getExportStore } from "@/lib/export-storage";
import { detectImageType } from "@/lib/image-files";
import { deleteImages, getImageStorageProblem, putImage } from "@/lib/image-storage";
import { getImportLimits } from "@/lib/plans";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import { countRelativeImages, decodeEntities, parseExport, prepareImportedHtml, resolveImportedUrl } from "@/lib/post-import-formats";
import { MAX_IMAGES_PER_IMPORT, MAX_IMPORT_FILE_BYTES, SOURCE_NAMES, describeImportCounts } from "@/lib/post-import-report";
import { saveImportRedirect } from "@/lib/redirects";
import { fetchRemoteImage } from "@/lib/remote-image";
import { publishJob } from "@/lib/sending";
import { slugify } from "@/lib/slug";
import { firstImageUrl } from "@/lib/thumbnail";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-image";
import { MAX_BODY_BYTES, isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";
import PostImport from "@/models/PostImport";
import Upload from "@/models/Upload";

// A post with more pictures keeps the rest where they were.
const MAX_IMAGES_PER_POST = 60;
const IMAGE_CONCURRENCY = 4;
export const CHUNK_POSTS = 25;
const PREVIEW_TITLES = 5;
const MAX_PROBLEMS = 20;
const LOCK_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const MAX_ATTEMPTS = 3;
const ACTIVE_STATUSES = ["queued", "running"];
const encoder = new TextEncoder();

// A step works for this long, then hands the rest to the next job: a Worker request that runs for minutes gets cut off.
// IMPORT_STEP_MS shortens it, to one post per job in tests.
function getStepMs() {
	return process.env.IMPORT_STEP_MS ? Number(process.env.IMPORT_STEP_MS) : 20_000;
}

function importError(code, message) {
	return codedError({ code, message });
}

// The export and its parsed posts wait in the private EXPORTS bucket, whose lifecycle rule deletes them after 8 days
// if nothing else does.
export function getImportPrefix(accountId, importId) {
	return `imports/${accountId}/${importId}/`;
}

function chunkKey(postImport, chunk) {
	return `${getImportPrefix(postImport.accountId, postImport._id)}posts-${chunk}.json`;
}

async function requireStore() {
	const store = await getExportStore();
	if (!store) throw importError("unavailable", "This server has nowhere to keep imports: it needs a private R2 bucket bound as EXPORTS");
	return store;
}

function readSiteUrl(value) {
	if (!value) return null;
	try {
		const url = new URL(value);
		return /^https?:$/.test(url.protocol) ? url.origin : null;
	} catch {
		return null;
	}
}

export function getImportJobUrl() {
	return `${getAppUrl()}/api/jobs/import-posts`;
}

function publishStep(accountId, importId) {
	return publishJob({ url: getImportJobUrl(), body: { accountId: String(accountId), importId: String(importId) } });
}

// Reads the export, keeps its posts in chunks and answers the import with its preview: nothing is imported until
// startPostImport. Throws validation_failed with the reason when the file can't be read.
export async function createPostImport({ account, user = null, via, newsletter, bytes, fileName, source, siteUrl }) {
	await connectDb();
	if (!bytes?.length) throw importError("validation_failed", "The file is empty");
	if (bytes.length > MAX_IMPORT_FILE_BYTES) throw importError("validation_failed", `Exports must be under ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB`);
	const store = await requireStore();
	const parsed = await parseExport(bytes, { expected: source });
	if (parsed.posts.length === 0) throw importError("validation_failed", `This ${SOURCE_NAMES[parsed.source]} export has no published posts`);

	const { posts } = parsed;
	const postImport = (
		await PostImport.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			userId: user?.id,
			via,
			source: parsed.source,
			fileName: fileName?.slice(0, 200),
			fileBytes: bytes.length,
			siteUrl: readSiteUrl(siteUrl) ?? readSiteUrl(parsed.siteUrl) ?? undefined,
			chunks: Math.ceil(posts.length / CHUNK_POSTS),
			preview: {
				posts: posts.length,
				paid: posts.filter(({ paid }) => paid).length,
				titles: posts.slice(0, PREVIEW_TITLES).map(({ title }) => title),
				newest: posts[0].publishedAt,
				oldest: posts.at(-1).publishedAt,
				skipped: parsed.skipped,
			},
		})
	).toObject();
	try {
		await store.put(`${getImportPrefix(account._id, postImport._id)}source`, bytes);
		for (let chunk = 0; chunk < postImport.chunks; chunk += 1) {
			await store.put(chunkKey(postImport, chunk), encoder.encode(JSON.stringify(posts.slice(chunk * CHUNK_POSTS, (chunk + 1) * CHUNK_POSTS))));
		}
	} catch (error) {
		await store.deletePrefix(getImportPrefix(account._id, postImport._id)).catch(() => {});
		await PostImport.deleteOne(scoped(account, { _id: postImport._id }));
		throw error;
	}
	return postImport;
}

export async function findPostImport(account, id) {
	if (!isObjectIdString(String(id))) return null;
	await connectDb();
	return PostImport.findOne(scoped(account, { _id: id })).lean();
}

export async function listPostImports(account, { newsletterId, limit = 20 } = {}) {
	await connectDb();
	await failStale(account);
	return PostImport.find(scoped(account, newsletterId ? { newsletterId } : {}))
		.sort({ createdAt: -1, _id: -1 })
		.limit(limit)
		.lean();
}

// What the account's earlier imports stored in pictures: the plan's cap counts them all.
async function countImportedImageBytes(account, exceptId) {
	const imports = await PostImport.find(scoped(account, { _id: { $ne: exceptId } })).select({ "counts.imageBytes": 1 }).lean();
	return imports.reduce((total, { counts }) => total + (counts?.imageBytes ?? 0), 0);
}

function startState(bytesBefore) {
	return { chunk: 0, index: 0, bytesBefore };
}

const ZERO_COUNTS = { imported: 0, existing: 0, overLimit: 0, failed: 0, images: 0, imageFailures: 0, imageBytes: 0, redirects: 0 };

// Starts a previewed import, or one that failed: it goes over every post again, and the ones already imported are
// skipped. One import runs at a time in an account.
export async function startPostImport({ account, postImport }) {
	await connectDb();
	await failStale(account);
	if (ACTIVE_STATUSES.includes(postImport.status)) return { postImport, isNew: false };
	if (postImport.status === "done") throw importError("conflict", "This import is done: upload the export again to import it once more");
	const imageProblem = getImageStorageProblem();
	if (imageProblem) throw importError("unavailable", imageProblem);
	const running = await PostImport.exists(scoped(account, { status: { $in: ACTIVE_STATUSES } }));
	if (running) throw importError("conflict", "Another import is running: start this one when it's done");
	const newsletter = await Newsletter.exists(scoped(account, { _id: postImport.newsletterId }));
	if (!newsletter) throw importError("not_found", "The newsletter of this import was deleted");

	const limits = getImportLimits(account);
	const now = new Date();
	await PostImport.updateOne(scoped(account, { _id: postImport._id, status: postImport.status }), {
		$set: {
			status: "queued",
			state: startState(await countImportedImageBytes(account, postImport._id)),
			counts: ZERO_COUNTS,
			attempts: 0,
			startedAt: now,
			...(limits && { limits: { posts: limits.posts, imageBytes: limits.imageBytes } }),
		},
		$unset: { error: 1, finishedAt: 1, problems: 1, lockedUntil: 1, ...(!limits && { limits: 1 }) },
	});
	try {
		await publishStep(account._id, postImport._id);
	} catch (error) {
		await PostImport.updateOne(scoped(account, { _id: postImport._id }), { $set: { status: "failed", error: "The job queue didn't take it" } });
		throw error;
	}
	return { postImport: await findPostImport(account, postImport._id), isNew: true };
}

async function readChunk(store, postImport, chunk) {
	const object = await store.get(chunkKey(postImport, chunk));
	if (!object) throw Object.assign(new Error("its file is gone from storage (exports are kept 8 days): upload it again"), { isFinal: true });
	return JSON.parse(await new Response(object.body).text());
}

function addProblem(ctx, post, problem) {
	if (ctx.problems.length < MAX_PROBLEMS) ctx.problems.push({ title: post.title, problem });
}

// The account's own copy of a picture, or null when it stays where it was: the link failed, it isn't a picture, or a cap
// was reached. A picture seen before, in this import or another, is the same copy.
async function rehostImage(ctx, url) {
	const cdn = process.env.IMAGES_CDN_URL?.replace(/\/+$/, "");
	if (cdn && url.startsWith(`${cdn}/`)) return url;
	const known = await Upload.findOne(scoped(ctx.account, { sourceUrl: url })).select({ url: 1 }).lean();
	if (known) return known.url;
	const { counts, postImport } = ctx;
	const imageLimit = postImport.limits?.imageBytes;
	if (counts.images >= MAX_IMAGES_PER_IMPORT) return null;
	if (imageLimit !== undefined && ctx.bytesBefore + counts.imageBytes >= imageLimit) return null;
	let bytes;
	try {
		bytes = await fetchRemoteImage(url, { maxBytes: MAX_UPLOAD_BYTES });
	} catch {
		return null;
	}
	const type = detectImageType(bytes);
	if (!type) return null;
	if (imageLimit !== undefined && ctx.bytesBefore + counts.imageBytes + bytes.length > imageLimit) return null;
	// Taken before the upload, so pictures copied at the same time can't pass the cap together.
	counts.imageBytes += bytes.length;
	counts.images += 1;
	try {
		const name = slugify(fileNameOf(url).replace(/\.[a-z0-9]+$/i, ""), 60) || "image";
		const stored = await putImage(`accounts/${ctx.account._id}/images/${name}.${type.extension}`, bytes, type.contentType);
		try {
			await Upload.create({ accountId: ctx.account._id, url: stored.url, pathname: stored.pathname, contentType: type.contentType, bytes: bytes.length, sourceUrl: url });
		} catch (error) {
			await deleteImages([stored]).catch((deleteError) => console.error(`[post-import] ${stored.pathname} stays without a record:`, deleteError));
			throw error;
		}
		return stored.url;
	} catch (error) {
		counts.imageBytes -= bytes.length;
		counts.images -= 1;
		throw error;
	}
}

// The picture's own file name, also when the address wraps another (Substack's image/fetch/<options>/<encoded URL>).
function fileNameOf(url) {
	try {
		return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").split("/").pop() ?? "";
	} catch {
		return "";
	}
}

function findImageSources(html) {
	return [...html.matchAll(/<img\b[^>]*?\bsrc="(https?:\/\/[^"]+)"/gi)].map(([, encoded]) => encoded);
}

// Every picture of the post copied into the images bucket, its links changed to the copies. A picture that can't be
// copied keeps its original link and counts in imageFailures.
async function rehostPostImages(ctx, html, thumbnailUrl) {
	const encoded = [...new Set(findImageSources(html))];
	const urls = [...new Set([...encoded.map(decodeEntities), ...(thumbnailUrl && /^https?:\/\//.test(thumbnailUrl) ? [thumbnailUrl] : [])])];
	const copies = new Map();
	const wanted = urls.slice(0, MAX_IMAGES_PER_POST);
	ctx.counts.imageFailures += urls.length - wanted.length;
	for (let start = 0; start < wanted.length; start += IMAGE_CONCURRENCY) {
		const group = wanted.slice(start, start + IMAGE_CONCURRENCY);
		const results = await Promise.all(group.map((url) => rehostImage(ctx, url)));
		group.forEach((url, index) => {
			if (results[index]) copies.set(url, results[index]);
			else ctx.counts.imageFailures += 1;
		});
	}
	let body = html;
	for (const value of encoded) {
		const copy = copies.get(decodeEntities(value));
		if (copy) body = body.replaceAll(`src="${value}"`, `src="${copy}"`);
	}
	return { html: body, thumbnailUrl: (thumbnailUrl && copies.get(thumbnailUrl)) || null };
}

async function createIssue(ctx, post, fields) {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return (await Campaign.create({ ...fields, archiveSlug: await uniqueArchiveSlug(post.slug, { newsletterId: fields.newsletterId }) })).toObject();
		} catch (error) {
			// Another writer took the slug between the check and the insert: the next free one.
			if (error?.code !== 11000 || /importKey/.test(error.message) || attempt === 2) throw error;
		}
	}
}

// One post: skipped when the newsletter has it already (its redirect still made), left out past the plan's cap,
// otherwise a sent issue with its pictures copied and a redirect from its old address. Running it twice adds nothing.
async function importPost(ctx, post) {
	const { account, newsletter, postImport, counts } = ctx;
	const importKey = `${postImport.source}:${post.sourceId}`;
	const filter = scoped(account, { newsletterId: newsletter._id, importKey });
	const existing = await Campaign.findOne(filter).select({ archiveSlug: 1 }).lean();
	if (existing) {
		counts.existing += 1;
		if (post.oldPath && existing.archiveSlug) await saveRedirect(ctx, post, existing);
		return;
	}
	if (postImport.limits?.posts !== undefined && counts.imported >= postImport.limits.posts) {
		counts.overLimit += 1;
		return;
	}
	const prepared = prepareImportedHtml(post.html, { source: postImport.source, siteUrl: postImport.siteUrl });
	const cleaned = cleanRichHtml(prepared);
	if (!cleaned) {
		counts.failed += 1;
		addProblem(ctx, post, "It has no text FlockStack can show");
		return;
	}
	counts.imageFailures += countRelativeImages(prepared);
	const { html, thumbnailUrl } = await rehostPostImages(ctx, cleaned, resolveImportedUrl(post.thumbnailUrl, postImport.siteUrl));
	if (encoder.encode(html).length > MAX_BODY_BYTES) {
		counts.failed += 1;
		addProblem(ctx, post, "It is over 500 KB of text");
		return;
	}
	const publishedAt = new Date(post.publishedAt);
	let campaign;
	try {
		campaign = await createIssue(ctx, post, {
			accountId: account._id,
			newsletterId: newsletter._id,
			subject: post.title,
			previewText: post.subtitle,
			format: "rich",
			html,
			status: "sent",
			audience: post.paid ? "paid" : "all",
			source: "import",
			startedAt: publishedAt,
			sentAt: publishedAt,
			thumbnailUrl: thumbnailUrl ?? firstImageUrl({ format: "rich", html }) ?? undefined,
			importKey,
			importedFrom: {
				source: postImport.source,
				...(post.oldPath && postImport.siteUrl && { url: `${postImport.siteUrl}${post.oldPath}` }),
				...(post.author && { author: post.author }),
			},
		});
	} catch (error) {
		if (error?.code !== 11000) throw error;
		counts.existing += 1;
		return;
	}
	counts.imported += 1;
	if (post.oldPath) await saveRedirect(ctx, post, campaign);
}

async function saveRedirect(ctx, post, campaign) {
	const added = await saveImportRedirect({
		accountId: ctx.account._id,
		newsletterId: ctx.newsletter._id,
		oldPath: post.oldPath,
		campaign,
		importId: ctx.postImport._id,
	});
	if (added) ctx.counts.redirects += 1;
}

async function saveProgress(ctx, state) {
	await PostImport.updateOne(scoped(ctx.account, { _id: ctx.postImport._id }), {
		$set: { state, counts: ctx.counts, problems: ctx.problems, lockedUntil: new Date(Date.now() + LOCK_MS) },
	});
}

async function finish(ctx) {
	const { account, postImport } = ctx;
	await PostImport.updateOne(scoped(account, { _id: postImport._id }), {
		$set: { status: "done", finishedAt: new Date(), counts: ctx.counts, problems: ctx.problems },
		$unset: { state: 1, lockedUntil: 1, error: 1 },
	});
	await ctx.store.deletePrefix(getImportPrefix(account._id, postImport._id));
	revalidateArchive();
	const done = await PostImport.findOne(scoped(account, { _id: postImport._id })).lean();
	await emailDone(done, ctx.newsletter);
	return done;
}

// The owner's email when an import is done. The import is done whether or not it arrives; the page shows it too.
async function emailDone(postImport, newsletter) {
	if (!canSendPlatformEmail()) return;
	try {
		const to = await findOwnerEmail(postImport.accountId);
		if (!to) return;
		await sendPlatformEmail({
			to,
			subject: `Your ${SOURCE_NAMES[postImport.source]} archive is in ${newsletter.name}`,
			text: `Your import is done: ${describeImportCounts(postImport.counts)}.\n\nNo emails went out: the posts are on your website as issues sent on their original dates.\n\nThe report: ${getAppUrl()}/newsletters/import\nPoint your old address at FlockStack so its links keep working: ${getAppUrl()}/docs/moving`,
		});
		await PostImport.updateOne(scoped(postImport.accountId, { _id: postImport._id }), { $set: { emailedAt: new Date() } });
	} catch (error) {
		console.error(`[post-import] The email for import ${postImport._id} didn't go out:`, error.message);
	}
}

async function failImport(postImport, error) {
	const message = String(error?.message ?? error).slice(0, 300);
	await PostImport.updateOne(scoped(postImport.accountId, { _id: postImport._id }), {
		$set: { status: "failed", error: message, finishedAt: new Date() },
		$unset: { lockedUntil: 1 },
	});
	await sendAlert({
		accountId: postImport.accountId,
		key: `post-import-failed:${postImport._id}`,
		title: "Your archive import stopped",
		detail: `The import stopped: ${message}. The posts it imported stay, and starting it again picks up the rest.`,
		path: "/newsletters/import",
		cooldownMinutes: 0,
	});
}

// A step that stopped without saying so (a Worker cut off mid-step, a lost job) holds the account's imports for ever.
async function failStale(account) {
	const stale = await PostImport.find(scoped(account, { status: { $in: ACTIVE_STATUSES }, updatedAt: { $lt: new Date(Date.now() - STALE_MS) } })).lean();
	for (const postImport of stale) await failImport(postImport, new Error("it stopped making progress"));
}

// An account's purge: the files of every import it uploaded. Their records go with the account's other data.
export async function removeAccountImportFiles(account) {
	const store = await getExportStore();
	await store?.deletePrefix(`imports/${account._id}/`);
}

// One job of an import: claims it, imports posts for a while, saves where it got to after each and publishes the next job.
// A step that throws is tried again by QStash; the third time in a row, the import fails. A post is imported or skipped
// whole, and skipped when its issue exists, so a step run twice adds nothing.
export async function runImportStep({ accountId, importId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(importId))) return { skipped: "invalid job" };
	await connectDb();
	const now = new Date();
	const claimed = await PostImport.findOneAndUpdate(
		{ _id: importId, accountId, status: { $in: ACTIVE_STATUSES }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
		{ $set: { status: "running", lockedUntil: new Date(now.getTime() + LOCK_MS) } },
		{ returnDocument: "after" }
	).lean();
	if (!claimed) {
		const current = await PostImport.findOne({ _id: importId, accountId }).lean();
		return current && ACTIVE_STATUSES.includes(current.status) ? { busy: true } : { skipped: current?.status ?? "not found" };
	}

	try {
		const account = await Account.findById(claimed.accountId).lean();
		const newsletter = account && (await Newsletter.findOne(scoped(account, { _id: claimed.newsletterId })).lean());
		if (!newsletter) throw Object.assign(new Error("the newsletter was deleted"), { isFinal: true });
		const ctx = {
			account,
			newsletter,
			postImport: claimed,
			store: await requireStore(),
			counts: { ...ZERO_COUNTS, ...claimed.counts },
			problems: claimed.problems ?? [],
			bytesBefore: claimed.state?.bytesBefore ?? 0,
		};
		let state = claimed.state ?? startState(0);
		const started = Date.now();
		const stepMs = getStepMs();
		let posts = null;
		while (state.chunk < claimed.chunks) {
			posts ??= await readChunk(ctx.store, claimed, state.chunk);
			const post = posts[state.index];
			if (post) await importPost(ctx, post);
			state = post ? { ...state, index: state.index + 1 } : { ...state, chunk: state.chunk + 1, index: 0 };
			if (!post) posts = null;
			await saveProgress(ctx, state);
			if (Date.now() - started >= stepMs) break;
		}
		if (state.chunk >= claimed.chunks) {
			const done = await finish(ctx);
			return { done: true, counts: done.counts };
		}
		await PostImport.updateOne(scoped(claimed.accountId, { _id: claimed._id }), { $set: { attempts: 0 }, $unset: { lockedUntil: 1 } });
		await publishStep(claimed.accountId, claimed._id);
		return { continued: state };
	} catch (error) {
		const attempts = (claimed.attempts ?? 0) + 1;
		if (error?.isFinal || attempts >= MAX_ATTEMPTS) {
			await failImport(claimed, error);
			return { failed: String(error?.message ?? error) };
		}
		await PostImport.updateOne(scoped(claimed.accountId, { _id: claimed._id }), { $set: { attempts }, $unset: { lockedUntil: 1 } });
		throw error;
	}
}
