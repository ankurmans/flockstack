// The content calendar's rules (lib/content-items.js keeps the records): channels, funnel stages, editorial states and what
// may move between them, what approval depends on, what a post needs before it can be approved, and the slots a recurring
// pattern makes. Plain JavaScript with no imports: the actions, the dashboard and the tests read it too.

export const CONTENT_CHANNELS = ["newsletter", "linkedin"];
export const CHANNEL_LABELS = { newsletter: "Newsletter", linkedin: "LinkedIn" };
// How each channel is delivered. Only a newsletter issue is sent by FlockStack, through its campaign; nothing posts to LinkedIn.
export const CHANNEL_DELIVERY = { newsletter: "campaign", linkedin: "manual" };
export const FUNNEL_STAGES = ["TOFU", "MOFU", "BOFU"];

export const CONTENT_STATES = ["idea", "drafting", "ready_for_review", "changes_requested", "approved", "delivered"];
export const STATE_LABELS = {
	idea: "Idea",
	drafting: "Drafting",
	ready_for_review: "Ready for review",
	changes_requested: "Changes requested",
	approved: "Approved",
	delivered: "Delivered",
};
// What an author, an agent or the dashboard's editor, may set by hand. The rest are decisions or facts: a review is asked
// for, the owner approves or asks for changes, and delivered is recorded with where the post went.
export const AUTHOR_STATES = ["idea", "drafting"];

export const LIMITS = {
	title: 200,
	obstacle: 1000,
	takeaway: 1000,
	pillar: 60,
	hook: 300,
	body: 10000,
	cta: 300,
	notes: 10000,
	url: 2000,
	label: 120,
	references: 20,
	assets: 20,
	altText: 420,
	name: 120,
	description: 1000,
	externalId: 100,
	itemsPerBatch: 200,
	batchesPerNewsletter: 200,
	itemsPerNewsletter: 5000,
	revisions: 50,
	moves: 10,
	imports: 25,
	rangeDays: 100,
	planEntries: 1000,
	patternStages: 14,
};

// LinkedIn refuses a post past this many characters.
export const LINKEDIN_MAX_CHARS = 3000;

export const CONTENT_FIELDS = ["title", "obstacle", "takeaway", "funnelStage", "pillar", "hook", "body", "cta", "destinationUrl", "references", "notes", "assets", "campaignId"];
// What a reader of the post would see differently. Changing one of these after approval takes the approval back; the rest
// (the reader's problem, the takeaway, the pillar, the references and the private notes) are planning, and a date moves freely.
export const APPROVAL_FIELDS = ["title", "hook", "body", "cta", "destinationUrl", "assets", "campaignId"];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDateKey(value) {
	if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

export function isTimeKey(value) {
	return typeof value === "string" && TIME_PATTERN.test(value);
}

export function isHttpUrl(value) {
	if (typeof value !== "string" || value.length > LIMITS.url) return false;
	try {
		const { protocol } = new URL(value);
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
}

// 1 (Monday) to 7 (Sunday), whatever the server's timezone.
export function getWeekday(dateKey) {
	return ((new Date(`${dateKey}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

function addDays(dateKey, days) {
	return new Date(Date.parse(`${dateKey}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// The words and records of an item that revisions keep and approval is about, in one shape whatever the item came from.
export function contentOf(item) {
	return {
		title: item.title ?? "",
		obstacle: item.obstacle ?? "",
		takeaway: item.takeaway ?? "",
		funnelStage: item.funnelStage ?? null,
		pillar: item.pillar ?? "",
		hook: item.hook ?? "",
		body: item.body ?? "",
		cta: item.cta ?? "",
		destinationUrl: item.destinationUrl ?? "",
		references: (item.references ?? []).map((reference) => ({ label: reference.label ?? "", url: reference.url, kind: reference.kind ?? "reference" })),
		notes: item.notes ?? "",
		assets: (item.assets ?? []).map((asset) => ({ mediaId: String(asset.mediaId), altText: asset.altText ?? "", kind: asset.kind ?? "image" })),
		campaignId: item.campaignId ? String(item.campaignId) : null,
	};
}

// The fields whose value differs.
export function getChangedFields(before, after) {
	const [left, right] = [contentOf(before), contentOf(after)];
	return CONTENT_FIELDS.filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]));
}

export function changesApproval(changedFields) {
	return changedFields.some((field) => APPROVAL_FIELDS.includes(field));
}

// What stops a post from being approved (blockers) and what is worth a look (warnings), from the item alone and the issue it
// is linked to. Shown in the editor and the batch review, and checked again when the review is asked for and when it is decided.
export function checkReadiness(item, { campaign = null, isCampaignMissing = false } = {}) {
	const blockers = [];
	const warnings = [];
	const block = (code, message) => blockers.push({ code, message });
	const warn = (code, message) => warnings.push({ code, message });
	const content = contentOf(item);
	if (!content.title.trim() && !campaign?.subject?.trim()) block("title", "Add a title.");
	if (item.channel === "newsletter") {
		if (!item.campaignId) block("campaign", "Link the issue's draft.");
		else if (isCampaignMissing) block("campaign_missing", "The linked issue was deleted: link another.");
		else if (!campaign?.subject?.trim()) block("subject", "The linked issue has no subject.");
	} else {
		if (!content.body.trim()) block("body", "Write the post.");
		else if (content.body.length > LINKEDIN_MAX_CHARS) block("body_length", `The post is ${content.body.length} characters: LinkedIn takes ${LINKEDIN_MAX_CHARS}.`);
		if (!content.cta.trim()) block("cta", "Add the call to action.");
		if (content.assets.length === 0) block("visual", "Attach a visual.");
		const missingAlt = content.assets.filter((asset) => asset.kind !== "pdf" && !asset.altText.trim()).length;
		if (missingAlt > 0) block("alt_text", missingAlt === 1 ? "A visual has no alt text." : `${missingAlt} visuals have no alt text.`);
		if (!content.hook.trim()) warn("hook", "No hook: the first line is what readers see before 'see more'.");
	}
	if (!content.funnelStage) warn("funnel_stage", "No funnel stage.");
	if (!content.pillar.trim()) warn("pillar", "No content pillar.");
	if (!item.plannedDate) warn("date", "No planned date.");
	return { blockers, warnings, canApprove: blockers.length === 0 };
}

// A recurring pattern: the funnel stages in the order they repeat (TOFU, MOFU, BOFU, TOFU, TOFU) and when slots fall. Kept
// per batch and applied only when asked; nothing here is for every account, and a slot is a planned day, never a send.
export function normalizeCadence(cadence = {}) {
	const weekdays = [...new Set(cadence.weekdays ?? [])].toSorted((a, b) => a - b);
	return {
		...(weekdays.length > 0 ? { weekdays } : { everyDays: cadence.everyDays ?? 1 }),
		perDay: cadence.perDay ?? 1,
		...(cadence.time && { time: cadence.time }),
		...(cadence.timeZone && { timeZone: cadence.timeZone }),
	};
}

// The first `count` slots from a day on: the days the cadence names, `perDay` slots each. A slot repeats the same wall-clock
// time, so across a clock change it is the same local hour and a different instant.
export function buildSlots(cadence, startDate, count) {
	const slots = [];
	const { weekdays, everyDays = 1, perDay = 1, time = null } = cadence;
	for (let offset = 0; slots.length < count && offset < 2000; offset++) {
		const date = addDays(startDate, offset);
		const isDay = weekdays ? weekdays.includes(getWeekday(date)) : offset % everyDays === 0;
		if (!isDay) continue;
		for (let slot = 0; slot < perDay && slots.length < count; slot++) slots.push({ date, time, slot });
	}
	return slots;
}

// Which items take which slots. In order: the n-th item takes the n-th slot, and an item whose stage isn't the pattern's for
// that slot is listed in `mismatches`. matchStages: each slot takes the first item with the stage the pattern wants there, and
// the items the pattern has no stage for come after, in their order.
export function assignPattern(items, stages, slots, { matchStages = false } = {}) {
	const pool = [...items];
	const order = [];
	if (matchStages) {
		for (let index = 0; index < slots.length && pool.length > 0; index++) {
			const wanted = stages[index % stages.length];
			const found = pool.findIndex((item) => item.funnelStage === wanted);
			order.push(...pool.splice(found === -1 ? 0 : found, 1));
		}
	} else order.push(...pool.splice(0, slots.length));
	const assigned = order.map((item, index) => ({ item, slot: slots[index], stage: stages[index % stages.length] }));
	return {
		assigned,
		mismatches: assigned.filter(({ item, stage }) => item.funnelStage && item.funnelStage !== stage).map(({ item, stage }) => ({ id: String(item._id), has: item.funnelStage, wants: stage })),
		left: pool,
	};
}
