import "server-only";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { createAccountExportToken } from "@/lib/account-export-token";
import {
	EXPORT_LINK_DAYS,
	buildCampaignFiles,
	buildManifest,
	buildReadme,
	findImageUrls,
	getFileOrder,
	getImagePath,
	toNewsletterSettings,
} from "@/lib/account-export-files";
import { findOwnerEmail } from "@/lib/accounts";
import { sendAlert } from "@/lib/alerts";
import { getAppUrl } from "@/lib/config";
import { EXPORT_COLUMNS, getCsvHeader, toCell, toCsvRow } from "@/lib/contacts-csv";
import { connectDb } from "@/lib/db";
import { getExportPrefix, getExportStore } from "@/lib/export-storage";
import { formatDate } from "@/lib/format";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import { publishJob } from "@/lib/sending";
import { crc32, splitIntoVolumes } from "@/lib/zip";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";
import AccountExport from "@/models/AccountExport";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import ExportFile from "@/models/ExportFile";
import Newsletter from "@/models/Newsletter";
import Suppression from "@/models/Suppression";
import Upload from "@/models/Upload";

// A step works for this long, then hands the rest to the next job: a Worker request that runs for minutes gets cut off.
// EXPORT_STEP_MS shortens it, to one unit of work per job in tests.
function getStepMs() {
	return process.env.EXPORT_STEP_MS ? Number(process.env.EXPORT_STEP_MS) : 20_000;
}
const LOCK_MS = 3 * 60_000;
const STALE_MS = 60 * 60_000;
const MAX_ATTEMPTS = 3;
const CSV_ROWS = 2000;
const CAMPAIGNS_PER_UNIT = 20;
const IMAGES_PER_UNIT = 5;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
const MANIFEST_PAGE = 2000;
const ACTIVE_STATUSES = ["queued", "running"];
const encoder = new TextEncoder();

const SUPPRESSION_HEADER = "email,reason,detail,created_at\r\n";

function suppressionRow(suppression) {
	return `${[suppression.email, suppression.reason, suppression.detail, suppression.createdAt].map(toCell).join(",")}\r\n`;
}

// The CSVs: one per newsletter, then the account's suppression list. find reads the next rows after an ID.
function getCsvSources(account, newsletters) {
	const slugs = new Map(newsletters.map(({ _id, slug }) => [String(_id), slug]));
	return [
		...newsletters.map((newsletter) => ({
			path: `contacts/${newsletter.slug}.csv`,
			header: getCsvHeader(EXPORT_COLUMNS),
			row: (contact) => toCsvRow(contact, slugs, EXPORT_COLUMNS),
			find: (after) => Contact.find(scoped(account, { newsletterId: newsletter._id, ...(after && { _id: { $gt: after } }) })).sort({ _id: 1 }).limit(CSV_ROWS).lean(),
		})),
		{
			path: "suppressions.csv",
			header: SUPPRESSION_HEADER,
			row: suppressionRow,
			find: (after) => Suppression.find(scoped(account, after ? { _id: { $gt: after } } : {})).sort({ _id: 1 }).limit(CSV_ROWS).lean(),
		},
	];
}

function startState() {
	return { phase: "csv", n: 0, after: null, part: 0, crc: 0, size: 0, rows: 0, keys: [], counts: { contacts: 0, campaigns: 0, images: 0, missingImages: 0 } };
}

export function getExportJobUrl() {
	return `${getAppUrl()}/api/jobs/export-account`;
}

function publishStep(accountId, exportId) {
	return publishJob({ url: getExportJobUrl(), body: { accountId: String(accountId), exportId: String(exportId) } });
}

async function saveFile(exportDoc, { path, kind = "file", size = 0, crc = 0, keys, meta, state = "done" }) {
	await ExportFile.updateOne(
		scoped(exportDoc.accountId, { exportId: exportDoc._id, path }),
		{ $set: { order: getFileOrder(path), kind, size, crc, state, ...(keys && { keys }), ...(meta && { meta }) } },
		{ upsert: true }
	);
}

async function putFile(store, exportDoc, path, text) {
	const bytes = encoder.encode(text);
	const key = `${getExportPrefix(exportDoc.accountId, exportDoc._id)}files/${path}`;
	await store.put(key, bytes);
	return { bytes, key };
}

async function writeFile(store, exportDoc, { path, text, meta }) {
	const { bytes, key } = await putFile(store, exportDoc, path, text);
	await saveFile(exportDoc, { path, size: bytes.length, crc: crc32(bytes), keys: [key], meta });
	return bytes.length;
}

async function setState(exportDoc, state) {
	await AccountExport.updateOne(scoped(exportDoc.accountId, { _id: exportDoc._id }), { $set: { state, lockedUntil: new Date(Date.now() + LOCK_MS) } });
}

// One chunk of a CSV: up to CSV_ROWS rows as an object of their own; the file is these objects one after the other.
async function advanceCsv({ ctx, exportDoc, state }) {
	const source = ctx.sources[state.n];
	if (!source) return { ...state, phase: "campaigns", after: null };
	const rows = await source.find(state.after);
	const text = (state.part === 0 ? source.header : "") + rows.map(source.row).join("");
	const bytes = encoder.encode(text);
	const key = `${getExportPrefix(exportDoc.accountId, exportDoc._id)}parts/csv-${state.n}-${state.part}`;
	await ctx.store.put(key, bytes);
	const next = {
		...state,
		part: state.part + 1,
		crc: crc32(bytes, state.crc),
		size: state.size + bytes.length,
		rows: state.rows + rows.length,
		keys: [...state.keys, key],
		after: rows.length > 0 ? String(rows.at(-1)._id) : state.after,
	};
	if (rows.length === CSV_ROWS) return next;
	await saveFile(exportDoc, { path: source.path, size: next.size, crc: next.crc, keys: next.keys, meta: { rows: next.rows } });
	const isSuppressions = source.path === "suppressions.csv";
	return {
		...state,
		n: state.n + 1,
		after: null,
		part: 0,
		crc: 0,
		size: 0,
		rows: 0,
		keys: [],
		counts: { ...state.counts, contacts: state.counts.contacts + (isSuppressions ? 0 : next.rows) },
	};
}

// A path for an upload's file in the ZIP. Two uploads with the same name can't share one: the second has its ID in front.
async function claimImagePath(exportDoc, upload) {
	const path = getImagePath(upload);
	const taken = await ExportFile.findOne(scoped(exportDoc.accountId, { exportId: exportDoc._id, path })).select({ meta: 1 }).lean();
	if (!taken || taken.meta?.uploadId === String(upload._id)) return path;
	return path.replace("images/", `images/${upload._id}-`);
}

// The account's own uploads among the addresses: only these are ever fetched, whatever else an issue links to.
async function queueImages(exportDoc, urls) {
	if (urls.length === 0) return new Map();
	const uploads = await Upload.find(scoped(exportDoc.accountId, { url: { $in: urls } })).lean();
	const paths = new Map();
	for (const upload of uploads) {
		const path = await claimImagePath(exportDoc, upload);
		paths.set(upload.url, path);
		const existing = await ExportFile.findOne(scoped(exportDoc.accountId, { exportId: exportDoc._id, path })).select({ _id: 1 }).lean();
		if (existing) continue;
		await saveFile(exportDoc, {
			path,
			kind: "image",
			state: "pending",
			meta: { uploadId: String(upload._id), url: upload.url, contentType: upload.contentType, bytes: upload.bytes },
		});
	}
	return paths;
}

async function advanceCampaigns({ ctx, exportDoc, state }) {
	const newsletterImages = state.newsletterImages ?? (await queueNewsletterImages(ctx, exportDoc));
	const campaigns = await Campaign.find(scoped(exportDoc.accountId, state.after ? { _id: { $gt: state.after } } : {}))
		.sort({ _id: 1 })
		.limit(CAMPAIGNS_PER_UNIT)
		.lean();
	if (campaigns.length === 0) return { ...state, phase: "images", newsletterImages };

	const images = await queueImages(exportDoc, [...new Set(campaigns.flatMap(findImageUrls))]);
	for (const campaign of campaigns) {
		const newsletter = ctx.newsletters.get(String(campaign.newsletterId));
		if (!newsletter) continue;
		const used = new Map(findImageUrls(campaign).filter((url) => images.has(url)).map((url) => [url, images.get(url)]));
		const files = buildCampaignFiles({ campaign, newsletter, images: used });
		await writeFile(ctx.store, exportDoc, { path: files.markdown.path, text: files.markdown.text, meta: files.meta });
		await writeFile(ctx.store, exportDoc, { path: files.html.path, text: files.html.text });
	}
	return {
		...state,
		newsletterImages,
		after: String(campaigns.at(-1)._id),
		counts: { ...state.counts, campaigns: state.counts.campaigns + campaigns.length },
	};
}

// A newsletter's logo and its author's photo come along; the manifest says which file is which.
async function queueNewsletterImages(ctx, exportDoc) {
	const paths = {};
	for (const newsletter of ctx.newsletters.values()) {
		const urls = [newsletter.imageUrl, newsletter.author?.imageUrl].filter(Boolean);
		const queued = await queueImages(exportDoc, urls);
		paths[String(newsletter._id)] = { image: queued.get(newsletter.imageUrl) ?? null, authorImage: queued.get(newsletter.author?.imageUrl) ?? null };
	}
	return paths;
}

async function fetchImage(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
	if (!response.ok) return { error: `HTTP ${response.status}` };
	const declared = Number(response.headers.get("content-length"));
	if (declared > MAX_IMAGE_BYTES) return { error: "over 25 MB" };
	const bytes = new Uint8Array(await response.arrayBuffer());
	return bytes.length > MAX_IMAGE_BYTES ? { error: "over 25 MB" } : { bytes };
}

async function advanceImages({ ctx, exportDoc, state }) {
	const pending = await ExportFile.find(scoped(exportDoc.accountId, { exportId: exportDoc._id, state: "pending" })).sort({ _id: 1 }).limit(IMAGES_PER_UNIT).lean();
	if (pending.length === 0) return { ...state, phase: "finalize" };
	const counts = { ...state.counts };
	for (const file of pending) {
		let result;
		try {
			result = await fetchImage(file.meta.url);
		} catch (error) {
			result = { error: error?.name === "TimeoutError" ? "timed out" : "unreachable" };
		}
		if (result.error) {
			await ExportFile.updateOne(scoped(exportDoc.accountId, { _id: file._id }), { $set: { state: "missing", error: result.error } });
			counts.missingImages += 1;
			continue;
		}
		const key = `${getExportPrefix(exportDoc.accountId, exportDoc._id)}files/${file.path}`;
		await ctx.store.put(key, result.bytes);
		await ExportFile.updateOne(scoped(exportDoc.accountId, { _id: file._id }), { $set: { state: "done", size: result.bytes.length, crc: crc32(result.bytes), keys: [key] } });
		counts.images += 1;
	}
	return { ...state, counts };
}

const PHASES = { csv: advanceCsv, campaigns: advanceCampaigns, images: advanceImages };

async function* listFiles(exportDoc) {
	let after = null;
	for (;;) {
		const page = await ExportFile.find(scoped(exportDoc.accountId, { exportId: exportDoc._id, ...(after && { _id: { $gt: after } }) }))
			.sort({ _id: 1 })
			.limit(MANIFEST_PAGE)
			.lean();
		yield* page;
		if (page.length < MANIFEST_PAGE) return;
		after = page.at(-1)._id;
	}
}

async function finalize({ ctx, exportDoc, state }) {
	const exportedAt = new Date();
	const files = [];
	for await (const file of listFiles(exportDoc)) files.push(file);
	const counts = { newsletters: ctx.newsletters.size, ...state.counts };
	const manifest = buildManifest({
		exportedAt,
		accountId: exportDoc.accountId,
		newsletters: [...ctx.newsletters.values()].map((newsletter) => ({
			...toNewsletterSettings(newsletter),
			imageFile: state.newsletterImages?.[String(newsletter._id)]?.image ?? null,
			authorImageFile: state.newsletterImages?.[String(newsletter._id)]?.authorImage ?? null,
		})),
		files,
		counts,
	});
	// The README says how many ZIPs there are, which depends on the manifest's size: write the manifest first.
	const manifestFile = { path: "manifest.json", text: `${JSON.stringify(manifest, null, 2)}\n` };
	const manifestSize = await writeFile(ctx.store, exportDoc, manifestFile);
	const sizes = files.filter(({ state: fileState }) => fileState === "done").map(({ path, size }) => ({ path, size, order: getFileOrder(path) }));
	const draft = splitIntoVolumes([{ path: "README.txt", size: 800 }, { path: "manifest.json", size: manifestSize }, ...sizes.sort((a, b) => (a.order < b.order ? -1 : 1))]);
	await writeFile(ctx.store, exportDoc, { path: "README.txt", text: buildReadme({ exportedAt, volumes: draft.length }) });

	const ordered = [];
	for await (const file of listFiles(exportDoc)) if (file.state === "done") ordered.push(file);
	ordered.sort((a, b) => (a.order < b.order ? -1 : 1));
	const volumes = splitIntoVolumes(ordered);
	const bytes = ordered.reduce((total, { size }) => total + size, 0);
	const expiresAt = new Date(exportedAt.getTime() + EXPORT_LINK_DAYS * 24 * 60 * 60_000);
	await AccountExport.updateOne(scoped(exportDoc.accountId, { _id: exportDoc._id }), {
		$set: { status: "ready", readyAt: exportedAt, expiresAt, volumeStarts: volumes.map(([first]) => first.order), counts: { ...counts, bytes } },
		$unset: { state: 1, lockedUntil: 1, error: 1 },
	});
	const ready = await AccountExport.findOne(scoped(exportDoc.accountId, { _id: exportDoc._id })).lean();
	await expireSuperseded(ready);
	await emailExport(ready);
	return ready;
}

// Only the newest export is kept: an older one that is ready goes when this one is.
async function expireSuperseded(exportDoc) {
	const older = await AccountExport.find(scoped(exportDoc.accountId, { status: "ready", _id: { $ne: exportDoc._id } })).lean();
	for (const previous of older) await expireExport(previous);
}

async function expireExport(exportDoc, status = "expired") {
	const store = await getExportStore();
	await store?.deletePrefix(getExportPrefix(exportDoc.accountId, exportDoc._id));
	await ExportFile.deleteMany(scoped(exportDoc.accountId, { exportId: exportDoc._id }));
	await AccountExport.updateOne(scoped(exportDoc.accountId, { _id: exportDoc._id }), { $set: { status }, $unset: { state: 1, lockedUntil: 1, volumeStarts: 1 } });
}

export function getExportDownloadUrls(exportDoc) {
	if (exportDoc.status !== "ready" || !exportDoc.expiresAt || new Date(exportDoc.expiresAt) < new Date()) return [];
	const token = createAccountExportToken({ accountId: exportDoc.accountId, exportId: exportDoc._id, expiresAt: exportDoc.expiresAt });
	const volumes = exportDoc.volumeStarts?.length || 1;
	return Array.from({ length: volumes }, (_, index) => `${getAppUrl()}/api/v1/account/export.zip?token=${token}${volumes > 1 ? `&part=${index + 1}` : ""}`);
}

// The owner's email with the link. The export is ready whether or not it arrives; the dashboard shows the link too.
async function emailExport(exportDoc) {
	if (!canSendPlatformEmail()) return;
	try {
		const to = await findOwnerEmail(exportDoc.accountId);
		if (!to) return;
		const urls = getExportDownloadUrls(exportDoc);
		const until = formatDate(exportDoc.expiresAt);
		const links = urls.map((url, index) => (urls.length > 1 ? `Part ${index + 1} of ${urls.length}: ${url}` : url)).join("\n");
		await sendPlatformEmail({
			to,
			subject: "Your FlockStack export is ready",
			text: `Your export is ready: your contacts, issues and images in ${urls.length > 1 ? `${urls.length} ZIP files` : "one ZIP file"}.\n\n${links}\n\nThe link works until ${until}. Anyone with it can download your data, so don't share it.\n\nWhat's inside: ${getAppUrl()}/docs/export`,
		});
		await AccountExport.updateOne(scoped(exportDoc.accountId, { _id: exportDoc._id }), { $set: { emailedAt: new Date() } });
	} catch (error) {
		console.error(`[export] The email for export ${exportDoc._id} didn't go out:`, error.message);
	}
}

async function failExport(exportDoc, error) {
	const message = String(error?.message ?? error).slice(0, 300);
	await expireExport(exportDoc, "failed");
	await AccountExport.updateOne(scoped(exportDoc.accountId, { _id: exportDoc._id }), { $set: { error: message } });
	await sendAlert({
		accountId: exportDoc.accountId,
		key: `export-failed:${exportDoc._id}`,
		title: "Your export didn't finish",
		detail: `The export stopped: ${message}. Nothing is lost; export again to try once more.`,
		path: "/account",
		cooldownMinutes: 0,
	});
}

// Exports older than their link, whose files and records go. Run by the hourly cron, and before a new export starts.
export async function expireAccountExports(now = new Date()) {
	const due = await AccountExport.find({ status: "ready", expiresAt: { $lt: now } }).setOptions({ crossAccount: true }).lean();
	for (const exportDoc of due) await expireExport(exportDoc);
	return due.length;
}

// An account's purge: the files of every export it ever made, in storage. Their records go with the account's other data.
export async function removeAccountExportFiles(account) {
	const store = await getExportStore();
	await store?.deletePrefix(`exports/${account._id}/`);
}

// A step that stopped without saying so (a Worker cut off mid-step, a lost job) holds nothing for ever.
async function failStale(account) {
	const stale = await AccountExport.find(scoped(account, { status: { $in: ACTIVE_STATUSES }, updatedAt: { $lt: new Date(Date.now() - STALE_MS) } })).lean();
	for (const exportDoc of stale) await failExport(exportDoc, new Error("it stopped making progress"));
}

export async function findLatestExport(account) {
	await connectDb();
	return AccountExport.findOne(scoped(account)).sort({ createdAt: -1, _id: -1 }).lean();
}

export async function findExport(account, id) {
	if (!isObjectIdString(String(id))) return null;
	await connectDb();
	return AccountExport.findOne(scoped(account, { _id: id })).lean();
}

// Starts an export, or answers the one already running. It works for any account: blocked, paused or without a plan.
export async function startAccountExport({ account, user = null, via }) {
	await connectDb();
	if (!(await getExportStore())) {
		throw codedError({ code: "unavailable", message: "This server has nowhere to keep exports: it needs a private R2 bucket bound as EXPORTS" });
	}
	await expireAccountExports();
	await failStale(account);
	const running = await AccountExport.findOne(scoped(account, { status: { $in: ACTIVE_STATUSES } })).sort({ createdAt: -1 }).lean();
	if (running) return { exportDoc: running, isNew: false };

	const exportDoc = (await AccountExport.create({ accountId: account._id, requestedBy: user?.id, via, state: startState() })).toObject();
	try {
		await publishStep(account._id, exportDoc._id);
	} catch (error) {
		await AccountExport.updateOne(scoped(account, { _id: exportDoc._id }), { $set: { status: "failed", error: "The job queue didn't take it" } });
		throw error;
	}
	return { exportDoc, isNew: true };
}

async function loadContext(exportDoc) {
	const store = await getExportStore();
	if (!store) throw new Error("No storage for exports");
	const account = await Account.findById(exportDoc.accountId).lean();
	const newsletters = await Newsletter.find(scoped(account)).sort({ createdAt: 1, _id: 1 }).lean();
	return { store, account, newsletters: new Map(newsletters.map((newsletter) => [String(newsletter._id), newsletter])), sources: getCsvSources(account, newsletters) };
}

// One job of an export: claims the export, works for a while, saves where it got to and publishes the next job. A step that
// throws is tried again by QStash; the third time in a row, the export fails. Everything a step writes is keyed by
// where it is in the export, so a step run twice leaves the same files.
export async function runExportStep({ accountId, exportId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(exportId))) return { skipped: "invalid job" };
	await connectDb();
	const now = new Date();
	const claimed = await AccountExport.findOneAndUpdate(
		{ _id: exportId, accountId, status: { $in: ACTIVE_STATUSES }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
		{ $set: { status: "running", lockedUntil: new Date(now.getTime() + LOCK_MS) } },
		{ returnDocument: "after" }
	).lean();
	if (!claimed) {
		const current = await AccountExport.findOne({ _id: exportId, accountId }).lean();
		return current && ACTIVE_STATUSES.includes(current.status) ? { busy: true } : { skipped: current?.status ?? "not found" };
	}

	try {
		const ctx = await loadContext(claimed);
		let state = claimed.state ?? startState();
		const started = Date.now();
		const stepMs = getStepMs();
		do {
			state = await PHASES[state.phase]({ ctx, exportDoc: claimed, state });
			await setState(claimed, state);
		} while (state.phase !== "finalize" && Date.now() - started < stepMs);
		if (state.phase === "finalize") {
			const ready = await finalize({ ctx, exportDoc: claimed, state });
			return { ready: true, files: ready.counts };
		}
		await AccountExport.updateOne(scoped(claimed.accountId, { _id: claimed._id }), { $set: { attempts: 0 }, $unset: { lockedUntil: 1 } });
		await publishStep(claimed.accountId, claimed._id);
		return { continued: state.phase };
	} catch (error) {
		const attempts = (claimed.attempts ?? 0) + 1;
		if (attempts >= MAX_ATTEMPTS) {
			await failExport(claimed, error);
			return { failed: String(error?.message ?? error) };
		}
		await AccountExport.updateOne(scoped(claimed.accountId, { _id: claimed._id }), { $set: { attempts }, $unset: { lockedUntil: 1 } });
		throw error;
	}
}

// What the zip route reads: the files of one ZIP of a ready export, in the order they go in.
export async function findVolumeFiles(exportDoc, volume) {
	const starts = exportDoc.volumeStarts ?? [];
	const from = starts[volume - 1];
	if (from === undefined) return null;
	const until = starts[volume];
	return ExportFile.find(scoped(exportDoc.accountId, { exportId: exportDoc._id, state: "done", order: { $gte: from, ...(until !== undefined && { $lt: until }) } }))
		.sort({ order: 1 })
		.lean();
}
