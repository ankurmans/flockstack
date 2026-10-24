import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getAppUrl } from "@/lib/config";
import {
	AUTHOR_STATES,
	CHANNEL_DELIVERY,
	LIMITS,
	changesApproval,
	checkReadiness,
	composePost,
	contentOf,
	getChangedFields,
	isDateKey,
	isHttpUrl,
	isTimeKey,
} from "@/lib/content-rules";
import { getMediaName } from "@/lib/media-rules";
import { toDateKey, toTimeKey, zonedTimeToInstant } from "@/lib/time-zone";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import ContentItem from "@/models/ContentItem";
import ContentRevision from "@/models/ContentRevision";
import EditorialBatch from "@/models/EditorialBatch";
import Upload from "@/models/Upload";

// The content calendar's records: items (a newsletter issue, a post for LinkedIn), their visuals, plan, review and
// revisions. Everything here is editorial. Nothing sends, schedules or publishes: a linked campaign is read, never changed,
// and delivery stays with the campaign's own actions.

const DELIVERY_STATUSES = ["scheduled", "sending", "paused", "sent"];
const CAMPAIGN_FIELDS = { subject: 1, status: 1, scheduledAt: 1, startedAt: 1, sentAt: 1, newsletterId: 1 };

function iso(value) {
	return value ? new Date(value).toISOString() : null;
}

function id(value) {
	return value ? String(value) : null;
}

// Who made a change, as the records keep it: a key, a connected app or the dashboard, by name.
export function describeActor({ apiKey = null, connection = null } = {}) {
	if (apiKey) return `key: ${apiKey.name}`.slice(0, 120);
	if (connection) return `app: ${connection.name ?? "An app"}`.slice(0, 120);
	return "dashboard";
}

export function getItemUrl(item) {
	return `${getAppUrl()}/campaigns/calendar/items/${item._id}`;
}

export function getBatchUrl(batch) {
	return `${getAppUrl()}/campaigns/calendar/batches/${batch._id}`;
}

export function isTimeZone(value) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return typeof value === "string" && value.length <= 64;
	} catch {
		return false;
	}
}

// ---- Looking things up

export async function findItem(account, itemId) {
	const item = isObjectIdString(String(itemId ?? "")) ? await ContentItem.findOne(scoped(account, { _id: itemId })).lean() : null;
	if (!item) throw actionError("not_found", "Content item not found");
	return item;
}

// By ID or externalId, in the newsletter if one is given.
export async function findBatchOf(account, newsletterId, reference) {
	const value = String(reference ?? "").trim();
	const batch = value
		? await EditorialBatch.findOne(scoped(account, isObjectIdString(value) ? { $or: [{ _id: value }, { externalId: value }] } : { externalId: value })).lean()
		: null;
	if (!batch || (newsletterId && String(batch.newsletterId) !== String(newsletterId))) throw actionError("not_found", "Batch not found");
	return batch;
}

// A deleted campaign (status canceled) is gone as far as a caller can tell.
export async function getCampaigns(account, ids, fields = CAMPAIGN_FIELDS) {
	const wanted = [...new Set(ids.filter(Boolean).map(String))].filter(isObjectIdString);
	if (wanted.length === 0) return new Map();
	const campaigns = await Campaign.find(scoped(account, { _id: { $in: wanted }, status: { $ne: "canceled" } })).select(fields).lean();
	return new Map(campaigns.map((campaign) => [String(campaign._id), campaign]));
}

async function getMedia(account, ids) {
	const wanted = [...new Set(ids.map(String))].filter(isObjectIdString);
	if (wanted.length === 0) return new Map();
	const uploads = await Upload.find(scoped(account, { _id: { $in: wanted } })).lean();
	return new Map(uploads.map((upload) => [String(upload._id), upload]));
}

async function findLinkableCampaign(account, newsletterId, campaignId) {
	if (!isObjectIdString(String(campaignId ?? ""))) throw actionError("validation_failed", "campaign: use an ID from list_campaigns");
	const campaign = (await getCampaigns(account, [campaignId])).get(String(campaignId));
	if (!campaign) throw actionError("not_found", "Campaign not found");
	if (String(campaign.newsletterId) !== String(newsletterId)) throw actionError("validation_failed", "campaign: that issue belongs to another newsletter");
	return campaign;
}

// ---- Presenting

export function presentCampaign(campaign) {
	if (!campaign) return null;
	return {
		id: String(campaign._id),
		subject: campaign.subject ?? "",
		status: campaign.status,
		scheduledAt: iso(campaign.scheduledAt),
		sentAt: iso(campaign.sentAt),
		url: `${getAppUrl()}/campaigns/${campaign._id}`,
	};
}

// The moment a campaign goes out or went out, which is when the calendar places it; null for one with no time (a draft).
export function getCampaignTime(campaign) {
	if (!campaign) return null;
	if (campaign.status === "scheduled") return campaign.scheduledAt ?? null;
	return DELIVERY_STATUSES.includes(campaign.status) ? (campaign.sentAt ?? campaign.startedAt ?? null) : null;
}

// How the item is delivered, apart from where it is in review. A newsletter issue is sent by its campaign; a post for LinkedIn is
// posted by hand, so FlockStack only ever knows what was recorded.
export function getDelivery(item, campaign) {
	if (CHANNEL_DELIVERY[item.channel] === "manual") {
		const isPosted = item.state === "delivered";
		return { mode: "manual", status: isPosted ? "posted" : "not_posted", at: isPosted ? iso(item.deliveredAt) : null, url: isPosted ? (item.publicationUrl ?? null) : null };
	}
	if (!item.campaignId) return { mode: "campaign", status: "no_issue", at: null, url: null };
	if (!campaign) return { mode: "campaign", status: "issue_missing", at: null, url: null };
	return { mode: "campaign", status: campaign.status, at: iso(getCampaignTime(campaign)), url: null };
}

function presentReview(item, { campaignChanged = null } = {}) {
	const review = item.review ?? {};
	const wasEdited = Boolean(review.editedAfterApprovalAt) || campaignChanged === true;
	return {
		requestedAt: iso(review.requestedAt),
		requestedBy: review.requestedBy ?? null,
		decision: review.decision ?? null,
		decidedAt: iso(review.decidedAt),
		note: review.note ?? null,
		approvedAt: iso(review.approvedAt),
		approvedVersion: review.approvedVersion ?? null,
		editedAfterApproval: wasEdited,
		editedAfterApprovalAt: iso(review.editedAfterApprovalAt),
		approvalValid: item.state === "approved" && !wasEdited,
	};
}

function presentPlan(item) {
	return {
		plannedDate: item.plannedDate ?? null,
		plannedTime: item.plannedTime ?? null,
		timeZone: item.timeZone ?? null,
		plannedAt: iso(item.plannedAt),
		slot: item.plannedDate ? (item.slotOrder ?? 0) + 1 : null,
	};
}

// A line of the item for lists and the calendar: no copy, notes or visuals, but what they need to be placed and judged.
export function presentSummary(item, { campaign = null } = {}) {
	const { blockers, canApprove } = checkReadiness(item, { campaign, isCampaignMissing: Boolean(item.campaignId) && !campaign });
	return {
		id: String(item._id),
		newsletterId: String(item.newsletterId),
		channel: item.channel,
		externalId: item.externalId ?? null,
		title: item.title || campaign?.subject || "",
		funnelStage: item.funnelStage ?? null,
		pillar: item.pillar || null,
		batchId: id(item.batchId),
		state: item.state,
		...presentPlan(item),
		campaign: presentCampaign(campaign),
		assetCount: (item.assets ?? []).length,
		canApprove,
		blockerCount: blockers.length,
		review: presentReview(item),
		delivery: getDelivery(item, campaign),
		url: getItemUrl(item),
		updatedAt: iso(item.updatedAt),
	};
}

export function presentAssets(item, media) {
	return (item.assets ?? []).map((asset, index) => {
		const upload = media.get(String(asset.mediaId));
		return {
			position: index + 1,
			mediaId: String(asset.mediaId),
			kind: asset.kind,
			altText: asset.altText ?? "",
			url: upload?.url ?? null,
			name: upload ? getMediaName(upload) : null,
			contentType: upload?.contentType ?? null,
			bytes: upload?.bytes ?? null,
			isMissing: !upload,
		};
	});
}

// The whole item: copy, notes, references, visuals with their files, review with what is missing, and its history of moves.
export async function presentItem(account, item, { campaignDigest = true } = {}) {
	const [campaigns, media] = await Promise.all([
		getCampaigns(account, [item.campaignId], campaignDigest ? { ...CAMPAIGN_FIELDS, previewText: 1, format: 1, html: 1, markdown: 1 } : CAMPAIGN_FIELDS),
		getMedia(account, (item.assets ?? []).map((asset) => asset.mediaId)),
	]);
	const campaign = campaigns.get(String(item.campaignId)) ?? null;
	const readiness = checkReadiness(item, { campaign, isCampaignMissing: Boolean(item.campaignId) && !campaign });
	let campaignChanged = null;
	if (campaignDigest && campaign && item.review?.campaignDigest) campaignChanged = (await digestCampaign(campaign)) !== item.review.campaignDigest;
	const content = contentOf(item);
	return {
		...presentSummary(item, { campaign }),
		obstacle: content.obstacle,
		takeaway: content.takeaway,
		hook: content.hook,
		body: content.body,
		cta: content.cta,
		destinationUrl: content.destinationUrl,
		postText: composePost(content),
		references: content.references,
		notes: content.notes,
		assets: presentAssets(item, media),
		version: item.contentVersion ?? 1,
		review: presentReview(item, { campaignChanged }),
		readiness: { canApprove: readiness.canApprove, blockers: readiness.blockers, warnings: readiness.warnings },
		publicationUrl: item.publicationUrl ?? null,
		deliveredAt: iso(item.deliveredAt),
		deliveredBy: item.deliveredBy ?? null,
		moves: (item.moves ?? []).map((move) => ({ at: iso(move.at), by: move.by, from: move.from || null, to: move.to || null })),
		createdBy: item.createdBy ?? null,
		createdAt: iso(item.createdAt),
	};
}

// What an issue says, to tell later whether it changed after it was approved: the words live on the campaign, not on the item.
export async function digestCampaign(campaign) {
	const text = [campaign.subject ?? "", campaign.previewText ?? "", campaign.format ?? "", campaign.format === "markdown" ? (campaign.markdown ?? "") : (campaign.html ?? "")].join("\u0000");
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(hash)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// One update, leaving out a $set or $unset with nothing in it.
async function writeItem(account, item, set, unset = {}) {
	const update = { ...(Object.keys(set).length > 0 && { $set: set }), ...(Object.keys(unset).length > 0 && { $unset: unset }) };
	if (Object.keys(update).length > 0) await ContentItem.updateOne(scoped(account, { _id: item._id }), update);
}

// ---- The plan

// A planned day, and a wall-clock time in a timezone if there is one, with the instant that is. A time the clock skips on a
// spring-forward day is moved to the first time that exists, and the item keeps the time that exists.
export function resolvePlan({ date, time = null, timeZone = null }) {
	if (!isDateKey(date)) throw actionError("validation_failed", "date: use YYYY-MM-DD");
	if (time !== null && !isTimeKey(time)) throw actionError("validation_failed", "time: use HH:mm, 24 hours");
	if (timeZone !== null && !isTimeZone(timeZone)) throw actionError("validation_failed", "timeZone: use an IANA timezone such as Europe/Paris");
	const zone = timeZone ?? "UTC";
	if (!time) return { plannedDate: date, timeZone: zone };
	const instant = zonedTimeToInstant(date, time, zone);
	return { plannedDate: toDateKey(instant, zone), plannedTime: toTimeKey(instant, zone), timeZone: zone, plannedAt: instant };
}

const PLAN_FIELDS = ["plannedDate", "plannedTime", "timeZone", "plannedAt", "slotOrder"];

function describePlan(item) {
	if (!item.plannedDate) return "";
	return [item.plannedDate, item.plannedTime, item.timeZone].filter(Boolean).join(" ");
}

async function getDayItems(account, newsletterId, date, exceptId = null) {
	return ContentItem.find(scoped(account, { newsletterId, plannedDate: date, ...(exceptId && { _id: { $ne: exceptId } }) }))
		.sort({ slotOrder: 1, createdAt: 1, _id: 1 })
		.select({ slotOrder: 1 })
		.lean();
}

// Writes the order of a day's items: the ones listed in their order, then any other in the order they were in.
async function writeSlotOrder(account, ordered) {
	const writes = ordered.flatMap((item, index) => (item.slotOrder === index ? [] : [{ updateOne: { filter: scoped(account, { _id: item._id }), update: { $set: { slotOrder: index } } } }]));
	if (writes.length > 0) await ContentItem.bulkWrite(writes);
}

// Gives the item a planned day (or takes it back to the backlog with date null). Only the plan changes: not the state, not
// the approval, and never a linked campaign. position puts it at that place (1 first) among the day's items, else last.
export async function setSlot(account, item, { date, time, timeZone, position }, by) {
	const previous = describePlan(item);
	let set = {};
	let unset = {};
	let next = "";
	if (date === null) unset = Object.fromEntries(PLAN_FIELDS.map((field) => [field, 1]));
	else {
		const plan = resolvePlan({ date, time: time === undefined ? (item.plannedTime ?? null) : time, timeZone: timeZone ?? item.timeZone ?? null });
		next = describePlan(plan);
		const day = await getDayItems(account, item.newsletterId, plan.plannedDate, item._id);
		const place = Math.min(Math.max((position ?? day.length + 1) - 1, 0), day.length);
		const isSameDay = item.plannedDate === plan.plannedDate;
		await writeSlotOrder(account, [...day.slice(0, place), { _id: item._id, slotOrder: isSameDay ? item.slotOrder : -1 }, ...day.slice(place)]);
		set = { ...plan, slotOrder: place };
		if (!plan.plannedTime) unset = { plannedTime: 1, plannedAt: 1 };
	}
	if (previous !== next) set.moves = [...(item.moves ?? []), { at: new Date(), by, from: previous, to: next }].slice(-LIMITS.moves);
	await writeItem(account, item, set, unset);
	return ContentItem.findOne(scoped(account, { _id: item._id })).lean();
}

// Puts the listed items first in the order given, on a day or in a batch; the others there keep their order after them.
// Answers the day's or the batch's items in their new order.
export async function reorderItems(account, items, scope) {
	const [first] = items;
	if (scope === "day") {
		if (!first.plannedDate || items.some((item) => item.plannedDate !== first.plannedDate || String(item.newsletterId) !== String(first.newsletterId))) {
			throw actionError("validation_failed", "ids: they must all be planned for the same day of the same newsletter");
		}
		const rest = await getDayItems(account, first.newsletterId, first.plannedDate);
		const listed = new Set(items.map((item) => String(item._id)));
		await writeSlotOrder(account, [...items.map((item) => ({ _id: item._id, slotOrder: item.slotOrder })), ...rest.filter((item) => !listed.has(String(item._id)))]);
		return ContentItem.find(scoped(account, { newsletterId: first.newsletterId, plannedDate: first.plannedDate })).sort({ slotOrder: 1, createdAt: 1, _id: 1 }).lean();
	}
	if (!first.batchId || items.some((item) => String(item.batchId) !== String(first.batchId))) throw actionError("validation_failed", "ids: they must all be in the same batch");
	const rest = await ContentItem.find(scoped(account, { batchId: first.batchId })).sort({ batchPosition: 1, createdAt: 1, _id: 1 }).select({ batchPosition: 1 }).lean();
	const listed = new Set(items.map((item) => String(item._id)));
	const ordered = [...items.map((item) => ({ _id: item._id, batchPosition: item.batchPosition })), ...rest.filter((item) => !listed.has(String(item._id)))];
	const writes = ordered.flatMap((item, index) => (item.batchPosition === index ? [] : [{ updateOne: { filter: scoped(account, { _id: item._id }), update: { $set: { batchPosition: index } } } }]));
	if (writes.length > 0) await ContentItem.bulkWrite(writes);
	return ContentItem.find(scoped(account, { batchId: first.batchId })).sort({ batchPosition: 1, createdAt: 1, _id: 1 }).lean();
}

// The batch an item is put in, at its end.
export async function placeInBatch(account, item, batch) {
	if (!batch) {
		await ContentItem.updateOne(scoped(account, { _id: item._id }), { $unset: { batchId: 1, batchPosition: 1 } });
		return;
	}
	if (String(item.batchId) === String(batch._id)) return;
	const members = await ContentItem.find(scoped(account, { batchId: batch._id })).sort({ batchPosition: -1 }).limit(1).select({ batchPosition: 1 }).lean();
	const count = await ContentItem.countDocuments(scoped(account, { batchId: batch._id }));
	if (count >= LIMITS.itemsPerBatch) throw actionError("validation_failed", `A batch holds up to ${LIMITS.itemsPerBatch} items`);
	await ContentItem.updateOne(scoped(account, { _id: item._id }), { $set: { batchId: batch._id, batchPosition: (members[0]?.batchPosition ?? -1) + 1 } });
}

// ---- Visuals

// Pictures and PDFs from the media library, in the order given. A post for LinkedIn is pictures or one PDF (a carousel), not both.
export async function resolveAssets(account, channel, entries) {
	if (entries.length > LIMITS.assets) throw actionError("validation_failed", `assets: up to ${LIMITS.assets} visuals`);
	const ids = entries.map((entry) => String(entry.media));
	if (!ids.every(isObjectIdString)) throw actionError("validation_failed", "assets: use IDs from list_media");
	if (new Set(ids).size !== ids.length) throw actionError("validation_failed", "assets: a file can be attached once");
	const media = await getMedia(account, ids);
	if (ids.some((mediaId) => !media.has(mediaId))) throw actionError("not_found", "A file isn't in this account's media library");
	const assets = entries.map((entry) => {
		const upload = media.get(String(entry.media));
		const kind = upload.contentType?.startsWith("image/") ? "image" : upload.contentType === "application/pdf" ? "pdf" : null;
		if (!kind) throw actionError("validation_failed", `${getMediaName(upload)} is not a picture or a PDF`);
		return { mediaId: upload._id, altText: entry.altText ?? "", kind };
	});
	const pdfs = assets.filter((asset) => asset.kind === "pdf").length;
	if (channel === "linkedin" && (pdfs > 1 || (pdfs === 1 && assets.length > 1))) {
		throw actionError("validation_failed", "assets: a LinkedIn post takes pictures or one PDF carousel, not both and not two PDFs");
	}
	return assets;
}

// ---- Changing content

// Every change to an item's words, visuals or link goes through here: it records a revision, counts the version, and takes an
// approval back when what readers would see changed. The plan (dates, order) and the batch are not content and don't come here.
export async function applyContentChange(account, item, patch, { by, reason = "edit", state = null } = {}) {
	const next = { ...item, ...patch };
	const changedFields = getChangedFields(item, next);
	const newState = state && state !== item.state ? state : null;
	if (changedFields.length === 0 && !newState) return { item, changedFields, invalidatedApproval: false };
	const now = new Date();
	const set = {};
	const unset = {};
	for (const field of changedFields) {
		const value = patch[field];
		if (value === null || value === undefined) unset[field] = 1;
		else set[field] = value;
	}
	const invalidatedApproval = item.state === "approved" && changesApproval(changedFields);
	if (invalidatedApproval) {
		set.state = "changes_requested";
		set["review.editedAfterApprovalAt"] = now;
		unset["review.decision"] = 1;
	}
	if (newState) {
		set.state = newState;
		if (item.state === "approved") unset["review.decision"] = 1;
	}
	if (changedFields.length > 0) set.contentVersion = (item.contentVersion ?? 1) + 1;
	try {
		await writeItem(account, item, set, unset);
	} catch (error) {
		if (error?.code === 11000) throw actionError("conflict", "That issue is already linked to another content item");
		throw error;
	}
	const fresh = await ContentItem.findOne(scoped(account, { _id: item._id })).lean();
	if (changedFields.length > 0) await recordRevision(account, fresh, { reason, changedFields, by });
	return { item: fresh, changedFields, invalidatedApproval };
}

export async function recordRevision(account, item, { reason, changedFields, by }) {
	await ContentRevision.create({ accountId: account._id, itemId: item._id, version: item.contentVersion ?? 1, reason, changedFields, by, snapshot: contentOf(item) });
	const old = await ContentRevision.find(scoped(account, { itemId: item._id })).sort({ createdAt: -1, _id: -1 }).skip(LIMITS.revisions).select({ _id: 1 }).lean();
	if (old.length > 0) await ContentRevision.deleteMany(scoped(account, { _id: { $in: old.map(({ _id }) => _id) } }));
}

// What an author's input sets, as the record keeps it.
export function readContentInput(input) {
	const patch = {};
	for (const field of ["title", "obstacle", "takeaway", "pillar", "hook", "body", "cta", "notes"]) {
		if (input[field] !== undefined) patch[field] = input[field].trim();
	}
	if (input.destinationUrl !== undefined) patch.destinationUrl = input.destinationUrl.trim();
	if (input.funnelStage !== undefined) patch.funnelStage = input.funnelStage;
	if (input.references !== undefined) patch.references = input.references.map((reference) => ({ label: reference.label?.trim() ?? "", url: reference.url, kind: reference.kind ?? "reference" }));
	return patch;
}

export function assertAuthorState(item, state) {
	if (!state) return;
	if (!AUTHOR_STATES.includes(state)) throw actionError("validation_failed", `state: set idea or drafting here. Ask for a review with request_content_review; the owner approves in the dashboard.`);
	if (item.state === "delivered") throw actionError("conflict", "This item is delivered: its state doesn't change");
}

// The item is created, or, when its externalId (or the issue it links) is already an item, that item and created false: a
// repeated import never makes a second one.
export async function createItem(account, newsletter, input, by) {
	const newsletterId = newsletter._id;
	const [byExternal, byCampaign] = await Promise.all([
		input.externalId ? ContentItem.findOne(scoped(account, { externalId: input.externalId })).lean() : null,
		input.channel === "newsletter" && input.campaign && isObjectIdString(input.campaign) ? ContentItem.findOne(scoped(account, { campaignId: input.campaign, channel: "newsletter" })).lean() : null,
	]);
	if (byExternal && byCampaign && String(byExternal._id) !== String(byCampaign._id)) {
		throw actionError("conflict", "The externalId belongs to one content item and the issue is linked to another");
	}
	const existing = byExternal ?? byCampaign;
	if (existing) {
		if (String(existing.newsletterId) !== String(newsletterId)) throw actionError("conflict", "The externalId or the issue is used in another newsletter");
		return { item: existing, created: false };
	}
	if ((await ContentItem.countDocuments(scoped(account, { newsletterId }))) >= LIMITS.itemsPerNewsletter) {
		throw actionError("validation_failed", `A newsletter holds up to ${LIMITS.itemsPerNewsletter} content items`);
	}
	const [campaign, batch] = await Promise.all([
		input.campaign ? findLinkableCampaign(account, newsletterId, input.campaign) : null,
		input.batch ? findBatchOf(account, newsletterId, input.batch) : null,
	]);
	const assets = input.assets ? await resolveAssets(account, input.channel, input.assets) : [];
	const patch = readContentInput(input);
	if (patch.funnelStage === null) delete patch.funnelStage;
	if (input.plannedTime && !input.plannedDate) throw actionError("validation_failed", "plannedTime: give plannedDate too");
	const plan = input.plannedDate ? resolvePlan({ date: input.plannedDate, time: input.plannedTime ?? null, timeZone: input.timeZone ?? null }) : null;
	if (input.state) assertAuthorState({ state: "idea" }, input.state);
	const hasWords = Boolean(patch.body || patch.hook || campaign);
	const day = plan ? await getDayItems(account, newsletterId, plan.plannedDate) : [];
	const created = {
		accountId: account._id,
		newsletterId,
		channel: input.channel,
		...(input.externalId && { externalId: input.externalId }),
		...patch,
		assets,
		...(campaign && { campaignId: campaign._id }),
		...(plan && { ...plan, slotOrder: day.length }),
		state: input.state ?? (hasWords ? "drafting" : "idea"),
		contentVersion: 1,
		createdBy: by,
	};
	let item;
	try {
		item = await ContentItem.findOne(scoped(account, { _id: (await ContentItem.create(created))._id })).lean();
	} catch (error) {
		if (error?.code !== 11000) throw error;
		const again = await ContentItem.findOne(scoped(account, input.externalId ? { externalId: input.externalId } : { campaignId: campaign._id, channel: "newsletter" })).lean();
		if (!again || String(again.newsletterId) !== String(newsletterId)) throw actionError("conflict", "The externalId or the issue is used in another newsletter");
		return { item: again, created: false };
	}
	if (batch) await placeInBatch(account, item, batch);
	await recordRevision(account, item, { reason: "create", changedFields: [], by });
	return { item: batch ? await ContentItem.findOne(scoped(account, { _id: item._id })).lean() : item, created: true };
}

// Links an existing campaign: the issue of a newsletter item, or the issue a post is derived from. null takes the link off.
export async function linkCampaign(account, item, campaignId, by) {
	if (campaignId === null) return applyContentChange(account, item, { campaignId: null }, { by });
	const campaign = await findLinkableCampaign(account, item.newsletterId, campaignId);
	if (item.channel === "newsletter") {
		const holder = await ContentItem.findOne(scoped(account, { campaignId: campaign._id, channel: "newsletter", _id: { $ne: item._id } })).select({ title: 1 }).lean();
		if (holder) throw actionError("conflict", `That issue is already the issue of another content item (${holder._id})`);
	}
	return applyContentChange(account, item, { campaignId: campaign._id }, { by });
}

// ---- Review

export async function getReadiness(account, item) {
	const campaign = item.campaignId ? ((await getCampaigns(account, [item.campaignId])).get(String(item.campaignId)) ?? null) : null;
	return { campaign, ...checkReadiness(item, { campaign, isCampaignMissing: Boolean(item.campaignId) && !campaign }) };
}

function listBlockers(blockers) {
	return blockers.map(({ message }) => message).join(" ");
}

// Puts the item in front of the owner. Refused while something stops it from being approved, and for a delivered item. An
// approved one is left alone, unless the issue it links has changed since: then it is up for review again.
export async function requestReview(account, item, by) {
	if (item.state === "delivered") throw actionError("conflict", "This item is delivered");
	if (item.state === "ready_for_review") return { item, changed: false };
	const wasApproved = item.state === "approved";
	if (wasApproved && !(await hasCampaignChanged(account, item))) return { item, changed: false };
	const readiness = await getReadiness(account, item);
	if (!readiness.canApprove) throw actionError("conflict", `Not ready for review. ${listBlockers(readiness.blockers)}`);
	await writeItem(
		account,
		item,
		{ state: "ready_for_review", "review.requestedAt": new Date(), "review.requestedBy": by, ...(wasApproved && { "review.editedAfterApprovalAt": new Date() }) },
		{ "review.decision": 1, "review.note": 1 }
	);
	return { item: await ContentItem.findOne(scoped(account, { _id: item._id })).lean(), changed: true };
}

async function hasCampaignChanged(account, item) {
	if (!item.campaignId || !item.review?.campaignDigest) return false;
	const digest = await digestOf(account, item.campaignId);
	return digest !== null && digest !== item.review.campaignDigest;
}

// The owner's decision, from the dashboard only. Approving needs the review asked for, with nothing missing, and records what
// the approval is for; asking for changes also takes an approval back.
export async function decideReview(account, item, { decision, note }, by) {
	const now = new Date();
	if (decision === "approve") {
		if (item.state !== "ready_for_review") throw actionError("conflict", `Only an item that is ready for review can be approved, and this one is ${item.state.replaceAll("_", " ")}`);
		const readiness = await getReadiness(account, item);
		if (!readiness.canApprove) throw actionError("conflict", `Can't approve yet. ${listBlockers(readiness.blockers)}`);
		const campaignDigest = readiness.campaign ? await digestOf(account, readiness.campaign._id) : null;
		await writeItem(
			account,
			item,
			{
				state: "approved",
				"review.decision": "approved",
				"review.decidedAt": now,
				"review.approvedAt": now,
				"review.approvedVersion": item.contentVersion ?? 1,
				"review.decidedBy": by,
				...(note && { "review.note": note }),
				...(campaignDigest && { "review.campaignDigest": campaignDigest }),
			},
			{ "review.editedAfterApprovalAt": 1, ...(!note && { "review.note": 1 }), ...(!campaignDigest && { "review.campaignDigest": 1 }) }
		);
	} else {
		if (!["ready_for_review", "approved"].includes(item.state)) throw actionError("conflict", `Changes can be asked for on an item in review or approved, and this one is ${item.state.replaceAll("_", " ")}`);
		await writeItem(
			account,
			item,
			{ state: "changes_requested", "review.decision": "changes_requested", "review.decidedAt": now, "review.decidedBy": by, ...(note && { "review.note": note }) },
			note ? {} : { "review.note": 1 }
		);
	}
	return ContentItem.findOne(scoped(account, { _id: item._id })).lean();
}

async function digestOf(account, campaignId) {
	const campaign = (await getCampaigns(account, [campaignId], { subject: 1, previewText: 1, format: 1, html: 1, markdown: 1 })).get(String(campaignId));
	return campaign ? digestCampaign(campaign) : null;
}

// ---- Publication

const LINKEDIN_HOSTS = /(^|\.)linkedin\.com$|^lnkd\.in$/;

// Records that the owner posted by hand, with the address of the post, or takes the record back. Only an approved item is
// recorded, and a newsletter issue only once its campaign is sent: FlockStack records what happened, it never posts.
export async function recordPublication(account, item, { url, deliveredAt, published = true }, by) {
	if (!published) {
		if (item.state !== "delivered") throw actionError("conflict", "This item isn't recorded as delivered");
		await writeItem(account, item, { state: "approved" }, { publicationUrl: 1, deliveredAt: 1, deliveredBy: 1 });
		return ContentItem.findOne(scoped(account, { _id: item._id })).lean();
	}
	if (!["approved", "delivered"].includes(item.state)) throw actionError("conflict", `Only an approved item can be recorded as delivered, and this one is ${item.state.replaceAll("_", " ")}`);
	const set = { state: "delivered", deliveredBy: by };
	const unset = {};
	if (item.channel === "linkedin") {
		if (!url || !isHttpUrl(url) || !LINKEDIN_HOSTS.test(new URL(url).hostname)) throw actionError("validation_failed", "url: the address of the post on LinkedIn");
		set.publicationUrl = url;
		set.deliveredAt = deliveredAt ?? item.deliveredAt ?? new Date();
	} else {
		const campaign = item.campaignId ? (await getCampaigns(account, [item.campaignId])).get(String(item.campaignId)) : null;
		if (!campaign || campaign.status !== "sent") throw actionError("conflict", "The issue hasn't been sent. Send it with the campaign's own controls first.");
		if (url) set.publicationUrl = url;
		else unset.publicationUrl = 1;
		set.deliveredAt = deliveredAt ?? campaign.sentAt ?? new Date();
	}
	if (set.deliveredAt.getTime() > Date.now() + 5 * 60_000) throw actionError("validation_failed", "deliveredAt: that time hasn't happened yet");
	await writeItem(account, item, set, unset);
	return ContentItem.findOne(scoped(account, { _id: item._id })).lean();
}

// ---- Revisions

export async function listRevisions(account, item, { limit = 20 } = {}) {
	return ContentRevision.find(scoped(account, { itemId: item._id })).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
}

export function presentRevision(revision, { includeContent = false } = {}) {
	return {
		id: String(revision._id),
		version: revision.version,
		reason: revision.reason,
		changedFields: revision.changedFields ?? [],
		by: revision.by ?? null,
		createdAt: iso(revision.createdAt),
		title: revision.snapshot?.title ?? "",
		...(includeContent && { content: revision.snapshot }),
	};
}

// Brings an earlier state back as a new change: the visuals and the issue link that are still there, everything else as it was.
export async function restoreRevision(account, item, revisionId, by) {
	const revision = isObjectIdString(String(revisionId ?? "")) ? await ContentRevision.findOne(scoped(account, { _id: revisionId, itemId: item._id })).lean() : null;
	if (!revision) throw actionError("not_found", "Revision not found");
	const snapshot = revision.snapshot;
	const media = await getMedia(account, (snapshot.assets ?? []).map((asset) => asset.mediaId));
	const assets = (snapshot.assets ?? []).filter((asset) => media.has(String(asset.mediaId))).map((asset) => ({ mediaId: asset.mediaId, altText: asset.altText ?? "", kind: asset.kind }));
	const skipped = [];
	if (assets.length < (snapshot.assets ?? []).length) skipped.push("a visual that is no longer in the media library");
	let campaignId = snapshot.campaignId ?? null;
	if (campaignId && campaignId !== String(item.campaignId ?? "")) {
		const campaign = (await getCampaigns(account, [campaignId])).get(campaignId);
		const holder = campaign && item.channel === "newsletter" ? await ContentItem.findOne(scoped(account, { campaignId, channel: "newsletter", _id: { $ne: item._id } })).select({ _id: 1 }).lean() : null;
		if (!campaign || holder) {
			skipped.push("the linked issue");
			campaignId = item.campaignId ? String(item.campaignId) : null;
		}
	}
	const patch = { ...snapshot, assets, campaignId };
	const result = await applyContentChange(account, item, patch, { by, reason: "restore" });
	return { ...result, skipped };
}

export async function deleteItem(account, item) {
	await ContentItem.deleteOne(scoped(account, { _id: item._id }));
	await ContentRevision.deleteMany(scoped(account, { itemId: item._id }));
}
