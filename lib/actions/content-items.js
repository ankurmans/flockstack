import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { GROUP, ItemSchema, ItemSummarySchema, channelInput, writableFields } from "@/lib/actions/content-shared";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, idInput, newsletterFilterInput, newsletterInput } from "@/lib/actions/shared";
import { buildItemFilter, getContentPlan } from "@/lib/content-plan";
import {
	applyContentChange,
	assertAuthorState,
	createItem,
	decideReview,
	deleteItem,
	describeActor,
	findBatchOf,
	findItem,
	getCampaigns,
	linkCampaign,
	listRevisions,
	placeInBatch,
	presentItem,
	presentRevision,
	presentSummary,
	readContentInput,
	recordPublication,
	reorderItems,
	requestReview,
	resolveAssets,
	restoreRevision,
	setSlot,
} from "@/lib/content-items";
import { AUTHOR_STATES, CONTENT_CHANNELS, CONTENT_STATES, FUNNEL_STAGES, LIMITS, isDateKey } from "@/lib/content-rules";
import { isObjectIdString } from "@/lib/validation";
import ContentItem from "@/models/ContentItem";

const itemId = idInput("content item");
const SORT = { createdAt: -1, _id: -1 };

const optional = (fields) => Object.fromEntries(Object.entries(fields).map(([name, schema]) => [name, schema.optional()]));
const dateKey = (about) => z.string().refine(isDateKey, "Use YYYY-MM-DD").describe(about);
const timeKey = (about) => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm, 24 hours").describe(about);
const timeZoneInput = z.string().trim().max(64).describe("An IANA timezone such as Europe/Paris. Default: the item's, else UTC.");
const externalIdInput = z.string().trim().min(1).max(LIMITS.externalId).describe("Your own key for it, unique in the account. Sending the same key again returns the item that has it, with created false, and changes nothing: safe to repeat an import.");
const batchInput = z.string().trim().min(1).max(LIMITS.externalId).describe("A batch's ID, or its externalId");

const AssetInput = z.object({
	media: z.string().trim().min(1).max(100).describe("A media library record's ID, from list_media, upload_image or upload_file"),
	altText: z.string().trim().max(LIMITS.altText).optional().describe("Alt text for the picture, which approval needs"),
});

const createFields = {
	channel: channelInput,
	...optional(writableFields),
	campaign: z.string().trim().min(1).max(100).optional().describe("An existing campaign's ID: the issue of a newsletter item, or the issue a post is derived from. It is linked, never copied or changed."),
	batch: batchInput.optional(),
	externalId: externalIdInput.optional(),
	plannedDate: dateKey("The day to plan it for, YYYY-MM-DD. Only a plan: it sends, schedules and publishes nothing. Without one it is in the backlog.").optional(),
	plannedTime: timeKey("The wall-clock time, HH:mm, in timeZone").optional(),
	timeZone: timeZoneInput.optional(),
	assets: z.array(AssetInput).max(LIMITS.assets).optional().describe("Visuals from the media library, in the order they are posted"),
	state: z.enum(AUTHOR_STATES).optional().describe("idea or drafting. Default: drafting when it has words or an issue, else idea."),
};

const createExample = { channel: "linkedin", title: "Why replies beat opens", funnelStage: "TOFU", externalId: "plan-2026-11-post-1" };

const PlanEntrySchema = z.object({
	kind: z.enum(["planned", "scheduled", "sending", "paused", "sent"]).describe("planned: only a plan, nothing goes out. scheduled, sending, paused, sent: the campaign's own delivery, at the time it really goes out or went out."),
	date: z.string().describe("The day it falls on, YYYY-MM-DD: a planned item's day in its own timezone, a delivery's day in the timezone asked"),
	plannedDate: z.string().nullable().describe("The day the item was planned for"),
	time: z.string().nullable(),
	at: z.string().nullable(),
	timeZone: z.string().nullable(),
	slot: z.number().int().nullable().describe("The place among the day's planned items, 1 first"),
	itemId: z.string().nullable().describe("The content item, or null for a campaign that is not in the plan"),
	campaignId: z.string().nullable(),
	channel: z.enum(CONTENT_CHANNELS).nullable(),
	title: z.string(),
	funnelStage: z.enum(FUNNEL_STAGES).nullable(),
	pillar: z.string().nullable(),
	state: z.enum(CONTENT_STATES).nullable(),
	batchId: z.string().nullable(),
	deliveryStatus: z.string().nullable(),
	isManual: z.boolean().describe("Posted by hand: FlockStack never posts it"),
	canApprove: z.boolean().nullable(),
	editedAfterApproval: z.boolean(),
	url: z.string(),
});

async function summaries(account, items) {
	const campaigns = await getCampaigns(account, items.map((item) => item.campaignId));
	return items.map((item) => presentSummary(item, { campaign: campaigns.get(String(item.campaignId)) ?? null }));
}

async function readCreate(account, input) {
	const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
	if (!input.title && !input.campaign) throw actionError("validation_failed", "title: say what the item is called, or link a campaign");
	return newsletter;
}

const createContentItem = defineAction({
	name: "create_content_item",
	tryWithoutPlan: true,
	title: "Create a content item",
	group: GROUP,
	description:
		"Adds a newsletter issue or a LinkedIn post to the content plan, with its copy, funnel stage, pillar, call to action, references, visuals and a planned day if you have one. A newsletter item links an existing campaign (never creates or changes one); a post can name the issue it is derived from. Planning only: nothing is sent, scheduled or published, and a LinkedIn post is always posted by hand. Send externalId to make it safe to repeat: the item that has it comes back with created false, and so does the item already linked to the same issue.",
	http: { method: "POST", path: "/content-items", status: (output) => (output.created ? 201 : 200) },
	idempotent: true,
	example: createExample,
	input: z.object({ newsletter: newsletterInput, ...createFields }),
	output: z.object({ created: z.boolean().describe("false: it already existed and was returned as it is"), item: ItemSchema }),
	handler: async ({ account, input, apiKey, connection }) => {
		const newsletter = await readCreate(account, input);
		const { item, created } = await createItem(account, newsletter, input, describeActor({ apiKey, connection }));
		return { created, item: await presentItem(account, item) };
	},
});

const importContentItems = defineAction({
	name: "import_content_items",
	tryWithoutPlan: true,
	title: "Import content items",
	group: GROUP,
	description: `Adds up to ${LIMITS.imports} content items in one call, each as create_content_item would, and returns them in order. Give each an externalId: an item that already exists comes back with created false and is not changed, so the same import can run again after a failure. Items before one that fails are kept.`,
	http: { method: "POST", path: "/content-items/import" },
	idempotent: true,
	example: { items: [createExample] },
	input: z.object({
		newsletter: newsletterInput,
		items: z.array(z.object(createFields)).min(1).max(LIMITS.imports).describe(`The items, ${LIMITS.imports} at most`),
	}),
	output: z.object({
		created: z.number().int(),
		existing: z.number().int(),
		items: z.array(z.object({ created: z.boolean(), item: ItemSummarySchema })),
	}),
	handler: async ({ account, input, apiKey, connection }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const by = describeActor({ apiKey, connection });
		const results = [];
		for (const [index, entry] of input.items.entries()) {
			if (!entry.title && !entry.campaign) throw actionError("validation_failed", `items.${index}.title: say what the item is called, or link a campaign`);
			const { item, created } = await createItem(account, newsletter, entry, by);
			results.push({ created, item: (await summaries(account, [item]))[0] });
		}
		const created = results.filter((result) => result.created).length;
		return { created, existing: results.length - created, items: results };
	},
});

const listContentItems = defineAction({
	name: "list_content_items",
	tryWithoutPlan: true,
	title: "List content items",
	group: GROUP,
	description:
		"Lists content items, newest first, 50 a page: a line each with its place in the plan, editorial state, whether it can be approved and the delivery of its issue. Filter by channel, funnel stage, pillar, batch, editorial state, linked campaign, whether it has a planned day (dated false is the backlog) or a range of planned days. get_content_item has the copy and the visuals. Pass nextCursor back as cursor for the next page.",
	http: { method: "GET", path: "/content-items" },
	readOnly: true,
	example: { dated: false, limit: 20 },
	input: z.object({
		newsletter: newsletterFilterInput,
		channel: channelInput.optional(),
		funnelStage: writableFields.funnelStage.optional(),
		pillar: z.string().trim().max(LIMITS.pillar).optional().describe("Only this content pillar, spelled as it was written"),
		batch: batchInput.optional(),
		state: z.enum(CONTENT_STATES).optional().describe("Only this editorial state"),
		campaign: z.string().trim().max(100).optional().describe("Only items linked to this campaign's ID"),
		dated: z.boolean().optional().describe("true: only items with a planned day. false: only the backlog. Default: both."),
		from: dateKey("Only items planned on or after this day, YYYY-MM-DD").optional(),
		to: dateKey("Only items planned on or before this day, YYYY-MM-DD").optional(),
		limit: z.number().int().min(1).max(100).optional().describe("Items per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({ items: z.array(ItemSummarySchema), nextCursor: z.string().nullable().describe("null on the last page") }),
	handler: async ({ account, input }) => {
		const limit = input.limit ?? 50;
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const batch = input.batch ? await findBatchOf(account, newsletter?._id ?? null, input.batch) : null;
		const filter = buildItemFilter({ newsletterId: newsletter?._id, channel: input.channel, funnelStage: input.funnelStage, pillar: input.pillar, batchId: batch?._id, state: input.state });
		if (input.campaign) {
			if (!isObjectIdString(input.campaign)) throw actionError("validation_failed", "campaign: use an ID from list_campaigns");
			filter.campaignId = input.campaign;
		}
		const and = [];
		if (input.dated === false) filter.plannedDate = { $exists: false };
		else if (input.dated === true || input.from || input.to) filter.plannedDate = { $exists: true };
		if ((input.from || input.to) && input.dated !== false) and.push({ plannedDate: { ...(input.from && { $gte: input.from }), ...(input.to && { $lte: input.to }) } });
		if (input.cursor) and.push(afterCursor(input.cursor, "createdAt"));
		const items = await ContentItem.find(scoped(account, { ...filter, ...(and.length > 0 && { $and: and }) })).sort(SORT).limit(limit + 1).lean();
		const page = items.slice(0, limit);
		const last = page.at(-1);
		return { items: await summaries(account, page), nextCursor: items.length > limit ? encodeCursor(last.createdAt, last._id) : null };
	},
});

const getContentItem = defineAction({
	name: "get_content_item",
	tryWithoutPlan: true,
	title: "Get a content item",
	group: GROUP,
	description:
		"Reads one content item whole: copy, hook, call to action, notes, references, visuals with their files to download (url) and alt text in order, the linked issue as it is now, the plan and its moves, the review (including whether it was edited after approval) and what is missing before it can be approved. The delivery is separate from the editorial state: an issue's is its campaign's status, a LinkedIn post's is not_posted until the owner records where it went.",
	http: { method: "GET", path: "/content-items/{id}" },
	readOnly: true,
	input: z.object({ id: itemId }),
	output: ItemSchema,
	handler: async ({ account, input }) => presentItem(account, await findItem(account, input.id)),
});

const updateContentItem = defineAction({
	name: "update_content_item",
	tryWithoutPlan: true,
	title: "Update a content item",
	group: GROUP,
	description:
		"Changes an item's copy, hook, call to action, destination, funnel stage, pillar, reader obstacle, takeaway, references or private notes, moves it to a batch, or sets its state to idea or drafting. Only the fields sent change. Every change keeps a revision. Changing the title, hook, body, call to action, destination or visuals of an approved item takes the approval back (the item becomes changes_requested, marked edited after approval); notes, pillar and the like don't. Use set_content_slot for the day, attach_content_asset for visuals, request_content_review to ask for approval.",
	http: { method: "PATCH", path: "/content-items/{id}" },
	idempotent: true,
	example: { body: "Most newsletters ask for replies and never answer them.", cta: "Read the issue" },
	input: z.object({
		id: itemId,
		...optional(writableFields),
		funnelStage: writableFields.funnelStage.nullable().optional().describe("TOFU, MOFU or BOFU, or null to clear it"),
		batch: batchInput.nullable().optional().describe("Move it to this batch (ID or externalId), or null to take it out of its batch"),
		state: z.enum(AUTHOR_STATES).optional().describe("idea or drafting. An approved item set back to drafting loses its approval."),
	}),
	output: z.object({
		item: ItemSchema,
		changedFields: z.array(z.string()).describe("The content fields that changed"),
		approvalWithdrawn: z.boolean().describe("It was approved, and this change took the approval back"),
	}),
	handler: async ({ account, input, apiKey, connection }) => {
		const item = await findItem(account, input.id);
		assertAuthorState(item, input.state);
		const batch = input.batch ? await findBatchOf(account, item.newsletterId, input.batch) : null;
		const result = await applyContentChange(account, item, readContentInput(input), { by: describeActor({ apiKey, connection }), state: input.state });
		if (input.batch !== undefined) await placeInBatch(account, result.item, batch);
		const fresh = await findItem(account, input.id);
		return { item: await presentItem(account, fresh), changedFields: result.changedFields, approvalWithdrawn: result.invalidatedApproval || (item.state === "approved" && fresh.state !== "approved") };
	},
});

const deleteContentItem = defineAction({
	name: "delete_content_item",
	tryWithoutPlan: true,
	title: "Delete a content item",
	group: GROUP,
	description: "Deletes a content item and its revisions. The linked campaign, the media library's files and the batch are not touched. Can't be undone.",
	http: { method: "DELETE", path: "/content-items/{id}" },
	destructive: true,
	input: z.object({ id: itemId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		await deleteItem(account, await findItem(account, input.id));
		return { id: input.id, deleted: true };
	},
});

const setContentSlot = defineAction({
	name: "set_content_slot",
	tryWithoutPlan: true,
	title: "Set a content item's planned day",
	group: GROUP,
	description:
		"Plans an item for a day, with a wall-clock time in an IANA timezone if you want one, or sends it back to the backlog with date null. position puts it at that place among the day's items (1 first), else last. Moving is only editorial: it never sends, schedules or publishes, never changes a linked campaign, and keeps an approval. A time the clock skips on a spring-forward day is moved to the first time that exists. The item's moves record where it was.",
	http: { method: "POST", path: "/content-items/{id}/slot" },
	idempotent: true,
	example: { date: "2026-11-10", time: "09:00", timeZone: "Europe/Paris" },
	input: z.object({
		id: itemId,
		date: dateKey("The day").nullable().describe("The day, YYYY-MM-DD, or null to send the item back to the backlog"),
		time: timeKey("The time").nullable().optional().describe("The wall-clock time in timeZone, HH:mm. null removes the time. Left out, the item keeps its time."),
		timeZone: timeZoneInput.optional(),
		position: z.number().int().min(1).max(100).optional().describe("Its place among the day's items, 1 first. Default: last."),
	}),
	output: z.object({
		item: ItemSummarySchema,
		previous: z.object({ plannedDate: z.string().nullable(), plannedTime: z.string().nullable(), timeZone: z.string().nullable() }),
		approvalKept: z.boolean().describe("It is approved, and moving it didn't change that"),
	}),
	handler: async ({ account, input, apiKey, connection }) => {
		const item = await findItem(account, input.id);
		const moved = await setSlot(account, item, input, describeActor({ apiKey, connection }));
		return {
			item: (await summaries(account, [moved]))[0],
			previous: { plannedDate: item.plannedDate ?? null, plannedTime: item.plannedTime ?? null, timeZone: item.timeZone ?? null },
			approvalKept: moved.state === "approved",
		};
	},
});

const reorderContentItems = defineAction({
	name: "reorder_content_items",
	tryWithoutPlan: true,
	title: "Reorder content items",
	group: GROUP,
	description:
		"Puts the listed items first, in the order given, either among a day's items (scope day: they must all be planned for the same day) or in their batch (scope batch: they must all be in the same batch). The other items there keep their order after them. Returns the whole day's or batch's items in their new order. Only the order changes.",
	http: { method: "POST", path: "/content-items/reorder" },
	idempotent: true,
	example: { scope: "day", ids: ["6650f1c2e9b1d4a012345678"] },
	input: z.object({
		scope: z.enum(["day", "batch"]).describe("day: the order of a day's items. batch: the order of a batch's items."),
		ids: z.array(itemId).min(1).max(LIMITS.itemsPerBatch).describe("The items' IDs, in the order they should come"),
	}),
	output: z.object({ items: z.array(ItemSummarySchema) }),
	handler: async ({ account, input }) => {
		const ids = [...new Set(input.ids)];
		if (!ids.every(isObjectIdString)) throw actionError("validation_failed", "ids: use IDs from list_content_items");
		const found = await ContentItem.find(scoped(account, { _id: { $in: ids } })).lean();
		if (found.length !== ids.length) throw actionError("not_found", "A content item isn't in this account");
		const byId = new Map(found.map((item) => [String(item._id), item]));
		return { items: await summaries(account, await reorderItems(account, ids.map((id) => byId.get(id)), input.scope)) };
	},
});

function toAssetEntries(item) {
	return (item.assets ?? []).map((asset) => ({ media: String(asset.mediaId), altText: asset.altText ?? "" }));
}

const attachContentAsset = defineAction({
	name: "attach_content_asset",
	tryWithoutPlan: true,
	title: "Attach a visual to a content item",
	group: GROUP,
	description:
		`Attaches a picture or a PDF carousel from the media library (upload it first with upload_image or upload_file, or pick one from list_media): nothing is copied, the item points at the same file. position puts it at that place (1 first), else last; a file already attached keeps its place unless position says otherwise and gets the new alt text. Up to ${LIMITS.assets} visuals; a LinkedIn post takes pictures or one PDF, not both. Attaching or changing a visual of an approved item takes the approval back.`,
	http: { method: "POST", path: "/content-items/{id}/assets" },
	idempotent: true,
	example: { media: "6650f1c2e9b1d4a012345678", altText: "A chart of reply rates by subject length" },
	input: z.object({
		id: itemId,
		media: AssetInput.shape.media,
		altText: AssetInput.shape.altText,
		position: z.number().int().min(1).max(LIMITS.assets).optional().describe("Its place among the visuals, 1 first. Default: last."),
	}),
	output: z.object({ item: ItemSchema, approvalWithdrawn: z.boolean() }),
	handler: async ({ account, input, apiKey, connection }) => {
		const item = await findItem(account, input.id);
		const entries = toAssetEntries(item);
		const index = entries.findIndex((entry) => entry.media === input.media);
		const [entry] = index === -1 ? [{ media: input.media, altText: "" }] : entries.splice(index, 1);
		if (input.altText !== undefined) entry.altText = input.altText;
		const place = input.position ? input.position - 1 : index === -1 ? entries.length : index;
		entries.splice(Math.min(place, entries.length), 0, entry);
		return writeAssets(account, item, entries, describeActor({ apiKey, connection }));
	},
});

async function writeAssets(account, item, entries, by) {
	const assets = await resolveAssets(account, item.channel, entries);
	const result = await applyContentChange(account, item, { assets }, { by });
	return { item: await presentItem(account, result.item), approvalWithdrawn: result.invalidatedApproval };
}

const setContentAssets = defineAction({
	name: "set_content_assets",
	tryWithoutPlan: true,
	title: "Set a content item's visuals",
	group: GROUP,
	description: "Replaces the item's visuals with this list, in this order, each with its alt text; an empty list takes them all off. The files stay in the media library. The same rules as attach_content_asset.",
	http: { method: "PATCH", path: "/content-items/{id}/assets" },
	idempotent: true,
	example: { assets: [{ media: "6650f1c2e9b1d4a012345678", altText: "A chart of reply rates" }] },
	input: z.object({ id: itemId, assets: z.array(AssetInput).max(LIMITS.assets).describe("The visuals in the order they are posted") }),
	output: z.object({ item: ItemSchema, approvalWithdrawn: z.boolean() }),
	handler: async ({ account, input, apiKey, connection }) => {
		const item = await findItem(account, input.id);
		return writeAssets(account, item, input.assets.map((asset) => ({ media: asset.media, altText: asset.altText ?? "" })), describeActor({ apiKey, connection }));
	},
});

const linkContentCampaign = defineAction({
	name: "link_content_campaign",
	tryWithoutPlan: true,
	title: "Link a campaign to a content item",
	group: GROUP,
	description:
		"Links an existing campaign of the same newsletter: a newsletter item's issue (an issue belongs to one item), or the issue a LinkedIn post is derived from. Null takes the link off. The campaign is only read: it is not copied, scheduled or changed, and sending stays with the campaign's own actions. Linking a different issue to an approved item takes the approval back.",
	http: { method: "POST", path: "/content-items/{id}/campaign" },
	idempotent: true,
	example: { campaign: "6650f1c2e9b1d4a012345678" },
	input: z.object({ id: itemId, campaign: z.string().trim().min(1).max(100).nullable().describe("The campaign's ID from list_campaigns, or null to take the link off") }),
	output: z.object({ item: ItemSchema, approvalWithdrawn: z.boolean() }),
	handler: async ({ account, input, apiKey, connection }) => {
		const item = await findItem(account, input.id);
		const result = await linkCampaign(account, item, input.campaign, describeActor({ apiKey, connection }));
		return { item: await presentItem(account, result.item), approvalWithdrawn: result.invalidatedApproval };
	},
});

const requestContentReview = defineAction({
	name: "request_content_review",
	tryWithoutPlan: true,
	title: "Request a review of a content item",
	group: GROUP,
	description:
		"Puts the item in front of the owner as ready_for_review. Refused (conflict) while something stops it from being approved, and the message says what: missing copy, call to action, visual or alt text, a post over LinkedIn's limit, an issue not linked. It doesn't approve anything: only the owner approves, in the dashboard, and approval sends, schedules and publishes nothing. Read the result with get_content_item.",
	http: { method: "POST", path: "/content-items/{id}/review" },
	idempotent: true,
	input: z.object({ id: itemId }),
	output: z.object({ item: ItemSchema, requested: z.boolean().describe("false: it was already in review or approved") }),
	handler: async ({ account, input, apiKey, connection }) => {
		const { item, changed } = await requestReview(account, await findItem(account, input.id), describeActor({ apiKey, connection }));
		return { item: await presentItem(account, item), requested: changed };
	},
});

const decideContentReview = defineAction({
	name: "decide_content_review",
	tryWithoutPlan: true,
	title: "Approve a content item or ask for changes",
	group: GROUP,
	description:
		"The owner's decision on an item in review: approve it, or ask for changes with a note. Approving needs nothing missing, and records the version approved; an edit to the words, visuals or linked issue afterwards takes the approval back. Dashboard only: no key or connected app can approve.",
	http: { method: "POST", path: "/content-items/{id}/decision" },
	dashboardOnly: true,
	input: z.object({
		id: itemId,
		decision: z.enum(["approve", "request_changes"]).describe("approve, or request_changes"),
		note: z.string().trim().max(1000).optional().describe("What to change, or a word with the approval"),
	}),
	output: z.object({ item: ItemSchema }),
	handler: async ({ account, input }) => {
		const item = await decideReview(account, await findItem(account, input.id), input, "dashboard");
		return { item: await presentItem(account, item) };
	},
});

const recordContentPublication = defineAction({
	name: "record_content_publication",
	tryWithoutPlan: true,
	title: "Record where a content item was published",
	group: GROUP,
	description:
		"Records that an approved item went out, and where. For a LinkedIn post, posted by hand: the address of the post on LinkedIn (url) and when (deliveredAt, default now). For a newsletter item: only once its campaign is sent, with the campaign's send time. It moves the editorial state to delivered; FlockStack posts nothing. published false takes the record back and returns the item to approved.",
	http: { method: "POST", path: "/content-items/{id}/publication" },
	idempotent: true,
	example: { url: "https://www.linkedin.com/posts/example-123", deliveredAt: "2026-11-10T09:05:00Z" },
	input: z.object({
		id: itemId,
		url: z.string().trim().max(LIMITS.url).optional().describe("The address of the published post. Required for LinkedIn."),
		deliveredAt: z.string().datetime({ offset: true }).optional().describe("When it went out, ISO 8601. Default: now, or the campaign's send time."),
		published: z.boolean().optional().describe("false takes the record back. Default true."),
	}),
	output: z.object({ item: ItemSchema }),
	handler: async ({ account, input, apiKey, connection }) => {
		const item = await recordPublication(
			account,
			await findItem(account, input.id),
			{ url: input.url, deliveredAt: input.deliveredAt ? new Date(input.deliveredAt) : undefined, published: input.published },
			describeActor({ apiKey, connection })
		);
		return { item: await presentItem(account, item) };
	},
});

const listContentRevisions = defineAction({
	name: "list_content_revisions",
	tryWithoutPlan: true,
	title: "List a content item's revisions",
	group: GROUP,
	description: `Lists the states an item's content was in after each change, newest first, up to ${LIMITS.revisions} kept: the version, what changed, who changed it and the title. includeContent adds the copy, visuals and notes of each. restore_content_revision brings one back.`,
	http: { method: "GET", path: "/content-items/{id}/revisions" },
	readOnly: true,
	input: z.object({
		id: itemId,
		limit: z.number().int().min(1).max(LIMITS.revisions).optional().describe("How many, 20 by default"),
		includeContent: z.boolean().optional().describe("Include each revision's copy, visuals and notes. Default false."),
	}),
	output: z.object({
		revisions: z.array(
			z.object({
				id: z.string(),
				version: z.number().int(),
				reason: z.enum(["create", "edit", "restore"]),
				changedFields: z.array(z.string()),
				by: z.string().nullable(),
				createdAt: dateOutput,
				title: z.string(),
				content: z.record(z.string(), z.unknown()).optional(),
			})
		),
	}),
	handler: async ({ account, input }) => ({
		revisions: (await listRevisions(account, await findItem(account, input.id), { limit: input.limit ?? 20 })).map((revision) => presentRevision(revision, { includeContent: input.includeContent })),
	}),
});

const restoreContentRevision = defineAction({
	name: "restore_content_revision",
	tryWithoutPlan: true,
	title: "Restore a content item's revision",
	group: GROUP,
	description:
		"Brings an earlier state of the item's content back, as a new revision: copy, hook, call to action, references, notes, visuals and the linked issue, those that are still there (a visual removed from the media library or an issue now linked elsewhere is skipped, and listed). Restoring over an approved item's words takes the approval back. The plan and the batch don't change.",
	http: { method: "POST", path: "/content-items/{id}/revisions/{revision}/restore" },
	idempotent: true,
	input: z.object({ id: itemId, revision: idInput("revision") }),
	output: z.object({ item: ItemSchema, skipped: z.array(z.string()).describe("What could not be restored"), approvalWithdrawn: z.boolean() }),
	handler: async ({ account, input, apiKey, connection }) => {
		const item = await findItem(account, input.id);
		const result = await restoreRevision(account, item, input.revision, describeActor({ apiKey, connection }));
		return { item: await presentItem(account, result.item), skipped: result.skipped, approvalWithdrawn: result.invalidatedApproval };
	},
});

const getContentPlanAction = defineAction({
	name: "get_content_plan",
	tryWithoutPlan: true,
	title: "Get the content plan for a range of days",
	group: GROUP,
	description:
		"The calendar for up to 100 days, from and to included: planned items on their days in order, and the campaigns that are really scheduled, sending, paused or sent, at the time they go out or went out, so a plan is never mistaken for a delivery. A planned issue shows as planned while its campaign is a draft, and as the campaign's own status once it is scheduled or sent. includeBacklog adds the items with no day. Filter by channel, funnel stage, pillar, batch and editorial state. Drafts appear on their planned day without being scheduled.",
	http: { method: "GET", path: "/content-plan" },
	readOnly: true,
	example: { from: "2026-11-01", to: "2026-11-30", includeBacklog: true },
	input: z.object({
		from: dateKey("The first day, YYYY-MM-DD"),
		to: dateKey("The last day, YYYY-MM-DD, at most 100 days after from"),
		timeZone: z.string().trim().max(64).optional().describe("An IANA timezone, for which day a campaign's send time falls on. Default UTC. A planned item stays on the day it was planned for."),
		newsletter: newsletterFilterInput,
		channel: channelInput.optional(),
		funnelStage: writableFields.funnelStage.optional(),
		pillar: z.string().trim().max(LIMITS.pillar).optional().describe("Only this content pillar"),
		batch: batchInput.optional(),
		state: z.enum(CONTENT_STATES).optional().describe("Only this editorial state"),
		includeBacklog: z.boolean().optional().describe("Add the items with no planned day (200 at most). Default false."),
		includeDeliveries: z.boolean().optional().describe("Add the campaigns that are scheduled, sending, paused or sent. Default true."),
	}),
	output: z.object({
		from: z.string(),
		to: z.string(),
		timeZone: z.string(),
		entries: z.array(PlanEntrySchema),
		backlog: z.array(ItemSummarySchema),
		counts: z.object({ planned: z.number().int(), delivery: z.number().int(), backlog: z.number().int() }),
	}),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const batch = input.batch ? await findBatchOf(account, newsletter?._id ?? null, input.batch) : null;
		return getContentPlan(account, {
			from: input.from,
			to: input.to,
			timeZone: input.timeZone,
			filters: { newsletterId: newsletter?._id, channel: input.channel, funnelStage: input.funnelStage, pillar: input.pillar, batchId: batch?._id, state: input.state },
			includeBacklog: input.includeBacklog,
			includeDeliveries: input.includeDeliveries ?? true,
		});
	},
});

export const contentItemActions = [
	createContentItem,
	importContentItems,
	listContentItems,
	getContentItem,
	updateContentItem,
	deleteContentItem,
	setContentSlot,
	reorderContentItems,
	attachContentAsset,
	setContentAssets,
	linkContentCampaign,
	requestContentReview,
	decideContentReview,
	recordContentPublication,
	listContentRevisions,
	restoreContentRevision,
	getContentPlanAction,
];
