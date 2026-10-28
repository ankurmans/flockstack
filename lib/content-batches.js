import { emitBatchEvent, emitPlanChanged } from "@/lib/content-events";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getIssueSkeleton } from "@/lib/briefing-issue-pattern";
import { LIMITS, assignPattern, buildSlots, checkReadiness, normalizeCadence } from "@/lib/content-rules";
import { applyContentChange, getBatchUrl, getCampaigns, getItemUrl, presentSummary, resolvePlan } from "@/lib/content-items";
import { isObjectIdString } from "@/lib/validation";
import ContentItem from "@/models/ContentItem";
import EditorialBatch from "@/models/EditorialBatch";

// Editorial batches: a group of content items with, if wanted, a recurring pattern. Planning only, like the items: applying a
// pattern gives items planned days, and asking for a batch review asks the owner to look, nothing more.

function iso(value) {
	return value ? new Date(value).toISOString() : null;
}

// A pattern is its stages, an issue (lib/briefing-issue-pattern.js), or both.
function hasPattern(pattern) {
	return Boolean(pattern?.stages?.length || pattern?.issue);
}

export function presentPattern(pattern) {
	if (!hasPattern(pattern)) return null;
	const cadence = normalizeCadence(pattern.cadence ?? {});
	return {
		stages: pattern.stages ?? [],
		cadence: {
			weekdays: cadence.weekdays ?? null,
			everyDays: cadence.everyDays ?? null,
			perDay: cadence.perDay,
			time: cadence.time ?? null,
			timeZone: cadence.timeZone ?? null,
		},
		...(pattern.issue && { issue: pattern.issue }),
		...(pattern.issue && pattern.sections?.length && { sections: pattern.sections }),
	};
}

// Counts of a batch's items by editorial state.
export async function countByState(account, batchIds) {
	const counts = new Map(batchIds.map((batchId) => [String(batchId), {}]));
	if (batchIds.length === 0) return counts;
	const rows = await ContentItem.aggregate([{ $match: scoped(account, { batchId: { $in: batchIds } }) }, { $group: { _id: { batch: "$batchId", state: "$state" }, count: { $sum: 1 } } }]);
	for (const { _id, count } of rows) counts.get(String(_id.batch))[_id.state] = count;
	return counts;
}

export function presentBatch(batch, counts = {}) {
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	return {
		id: String(batch._id),
		newsletterId: String(batch.newsletterId),
		name: batch.name,
		description: batch.description ?? "",
		externalId: batch.externalId ?? null,
		status: batch.status ?? "active",
		pattern: presentPattern(batch.pattern),
		itemCount: total,
		counts,
		reviewRequestedAt: iso(batch.review?.requestedAt),
		reviewUrl: getBatchUrl(batch),
		createdAt: iso(batch.createdAt),
		updatedAt: iso(batch.updatedAt),
	};
}

export function storePattern(pattern) {
	if (!pattern) return null;
	if (!hasPattern(pattern)) throw actionError("validation_failed", "A pattern needs its stages, or issue: briefing");
	if (pattern.sections?.length && !pattern.issue) throw actionError("validation_failed", "sections go with issue: briefing");
	const cadence = normalizeCadence(pattern.cadence ?? {});
	return { ...(pattern.stages?.length && { stages: pattern.stages }), cadence, ...(pattern.issue && { issue: pattern.issue }), ...(pattern.issue && pattern.sections?.length && { sections: [...new Set(pattern.sections)] }) };
}

export async function findBatch(account, batchId) {
	const batch = isObjectIdString(String(batchId ?? "")) ? await EditorialBatch.findOne(scoped(account, { _id: batchId })).lean() : null;
	if (!batch) throw actionError("not_found", "Batch not found");
	return batch;
}

// The batch, or, when its externalId is already one, that batch and created false.
export async function createBatch(account, newsletter, input, by) {
	if (input.externalId) {
		const existing = await EditorialBatch.findOne(scoped(account, { externalId: input.externalId })).lean();
		if (existing) {
			if (String(existing.newsletterId) !== String(newsletter._id)) throw actionError("conflict", "The externalId is used in another newsletter");
			return { batch: existing, created: false };
		}
	}
	if ((await EditorialBatch.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= LIMITS.batchesPerNewsletter) {
		throw actionError("validation_failed", `A newsletter holds up to ${LIMITS.batchesPerNewsletter} batches: archive or delete one`);
	}
	try {
		const made = await EditorialBatch.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			name: input.name,
			description: input.description ?? "",
			...(input.externalId && { externalId: input.externalId }),
			...(input.pattern && { pattern: storePattern(input.pattern) }),
			createdBy: by,
		});
		const saved = await EditorialBatch.findOne(scoped(account, { _id: made._id })).lean();
		await emitBatchEvent("editorial_batch.created", saved);
		return { batch: saved, created: true };
	} catch (error) {
		if (error?.code !== 11000 || !input.externalId) throw error;
		const existing = await EditorialBatch.findOne(scoped(account, { externalId: input.externalId })).lean();
		if (!existing || String(existing.newsletterId) !== String(newsletter._id)) throw actionError("conflict", "The externalId is used in another newsletter");
		return { batch: existing, created: false };
	}
}

export async function updateBatch(account, batch, input) {
	const set = {};
	const unset = {};
	if (input.name !== undefined) set.name = input.name;
	if (input.description !== undefined) set.description = input.description;
	if (input.status !== undefined) set.status = input.status;
	if (input.pattern === null) unset.pattern = 1;
	else if (input.pattern !== undefined) set.pattern = storePattern(input.pattern);
	const update = { ...(Object.keys(set).length > 0 && { $set: set }), ...(Object.keys(unset).length > 0 && { $unset: unset }) };
	if (Object.keys(update).length > 0) await EditorialBatch.updateOne(scoped(account, { _id: batch._id }), update);
	const saved = await EditorialBatch.findOne(scoped(account, { _id: batch._id })).lean();
	if (Object.keys(update).length) await emitBatchEvent("editorial_batch.updated", saved);
	return saved;
}

// The items stay, outside any batch.
export async function deleteBatch(account, batch) {
	await ContentItem.updateMany(scoped(account, { batchId: batch._id }), { $unset: { batchId: 1, batchPosition: 1 } });
	await EditorialBatch.deleteOne(scoped(account, { _id: batch._id }));
	await emitBatchEvent("editorial_batch.deleted", batch);
	await emitPlanChanged(account, batch.newsletterId, "batch_deleted");
}

export async function getBatchItems(account, batch) {
	return ContentItem.find(scoped(account, { batchId: batch._id })).sort({ batchPosition: 1, createdAt: 1, _id: 1 }).limit(LIMITS.itemsPerBatch).lean();
}

export async function presentBatchWithItems(account, batch) {
	const items = await getBatchItems(account, batch);
	const campaigns = await getCampaigns(account, items.map((item) => item.campaignId));
	const counts = {};
	for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
	return {
		...presentBatch(batch, counts),
		items: items.map((item) => presentSummary(item, { campaign: campaigns.get(String(item.campaignId)) ?? null })),
	};
}

// Gives the batch's items planned days from a pattern's slots. Only planning: no state changes, no campaign is touched, and
// nothing is sent or scheduled. dryRun shows the assignment without writing it.
export async function applyPattern(account, batch, input, by) {
	const pattern = input.pattern ? storePattern(input.pattern) : batch.pattern;
	if (!hasPattern(pattern)) throw actionError("validation_failed", "This batch has no pattern: pass one, or set one with update_editorial_batch");
	const cadence = normalizeCadence(pattern.cadence ?? {});
	const listed = input.itemIds ? new Set(input.itemIds) : null;
	const all = await getBatchItems(account, batch);
	if (listed && all.filter((item) => listed.has(String(item._id))).length !== listed.size) throw actionError("not_found", "An item isn't in this batch");
	const candidates = all.filter(
		(item) => item.state !== "delivered" && (!listed || listed.has(String(item._id))) && (!input.channel || item.channel === input.channel) && (input.includePlanned || listed || !item.plannedDate)
	);
	const slots = buildSlots(cadence, input.startDate, candidates.length);
	const { assigned, mismatches, left } = assignPattern(candidates, pattern.stages ?? [], slots, { matchStages: input.matchStages });
	const timeZone = cadence.timeZone ?? input.timeZone ?? "UTC";
	const plans = assigned.map(({ slot }) => resolvePlan({ date: slot.date, time: slot.time, timeZone }));
	const dates = [...new Set(plans.map((plan) => plan.plannedDate))];
	const taken = new Map();
	if (dates.length > 0) {
		const planned = await ContentItem.find(scoped(account, { newsletterId: batch.newsletterId, plannedDate: { $in: dates } })).select({ plannedDate: 1 }).lean();
		const moving = new Set(assigned.map(({ item }) => String(item._id)));
		for (const other of planned) if (!moving.has(String(other._id))) taken.set(other.plannedDate, (taken.get(other.plannedDate) ?? 0) + 1);
	}
	const writes = [];
	const result = assigned.map(({ item, stage }, index) => {
		const plan = plans[index];
		const slotOrder = taken.get(plan.plannedDate) ?? 0;
		taken.set(plan.plannedDate, slotOrder + 1);
		const from = [item.plannedDate, item.plannedTime, item.timeZone].filter(Boolean).join(" ");
		const to = [plan.plannedDate, plan.plannedTime, plan.timeZone].filter(Boolean).join(" ");
		const moves = [...(item.moves ?? []), { at: new Date(), by, from, to }].slice(-LIMITS.moves);
		writes.push({
			updateOne: {
				filter: scoped(account, { _id: item._id }),
				update: { $set: { ...plan, slotOrder, moves }, ...(!plan.plannedTime && { $unset: { plannedTime: 1, plannedAt: 1 } }) },
			},
		});
		return { id: String(item._id), title: item.title, channel: item.channel, funnelStage: item.funnelStage ?? null, patternStage: stage, date: plan.plannedDate, time: plan.plannedTime ?? null, timeZone: plan.timeZone, slot: slotOrder + 1, url: getItemUrl(item) };
	});
	const issue = getIssueSkeleton(pattern);
	const toFill = issue ? assigned.map(({ item }) => item).filter(canTakeSkeleton) : [];
	if (!input.dryRun && writes.length > 0) await ContentItem.bulkWrite(writes);
	// The skeleton goes in as an edit, with its revision, like any other change to an item's words.
	if (!input.dryRun) for (const item of toFill) await applyContentChange(account, item, { body: issue.markdown }, { by });
	if (!input.dryRun && writes.length) await emitPlanChanged(account, batch.newsletterId, "pattern");
	return {
		dryRun: Boolean(input.dryRun),
		applied: input.dryRun ? 0 : writes.length,
		assignments: result,
		mismatches,
		unassigned: left.map((item) => String(item._id)),
		issue,
		skeletonFor: toFill.map((item) => String(item._id)),
	};
}

// Who gets the Briefing issue skeleton: a newsletter item still being written, with no words yet and no linked issue (a linked
// issue's words are its campaign's). An item with a body, in review or approved keeps what it has.
function canTakeSkeleton(item) {
	return item.channel === "newsletter" && !item.campaignId && !String(item.body ?? "").trim() && ["idea", "drafting"].includes(item.state ?? "idea");
}

// Asks the owner to review the batch: every item that can be approved moves to ready for review, and the others are listed with
// what is missing. Items already in review or approved stay as they are.
export async function requestBatchReview(account, batch, by) {
	const items = await getBatchItems(account, batch);
	const campaigns = await getCampaigns(account, items.map((item) => item.campaignId));
	const now = new Date();
	const requested = [];
	const alreadyInReview = [];
	const blocked = [];
	const writes = [];
	for (const item of items) {
		if (["ready_for_review", "approved", "delivered"].includes(item.state)) {
			alreadyInReview.push({ id: String(item._id), title: item.title, state: item.state });
			continue;
		}
		const campaign = campaigns.get(String(item.campaignId)) ?? null;
		const readiness = checkReadiness(item, { campaign, isCampaignMissing: Boolean(item.campaignId) && !campaign });
		if (!readiness.canApprove) {
			blocked.push({ id: String(item._id), title: item.title || campaign?.subject || "", state: item.state, blockers: readiness.blockers });
			continue;
		}
		requested.push({ id: String(item._id), title: item.title || campaign?.subject || "" });
		writes.push({
			updateOne: {
				filter: scoped(account, { _id: item._id, state: item.state, contentVersion: item.contentVersion ?? 1 }),
				update: { $set: { state: "ready_for_review", "review.requestedAt": now, "review.requestedBy": by }, $unset: { "review.decision": 1, "review.note": 1 } },
			},
		});
	}
	if (writes.length > 0) await ContentItem.bulkWrite(writes);
	await EditorialBatch.updateOne(scoped(account, { _id: batch._id }), { $set: { "review.requestedAt": now, "review.requestedBy": by } });
	await emitPlanChanged(account, batch.newsletterId, "review_requested");
	return { requested, alreadyInReview, blocked };
}
