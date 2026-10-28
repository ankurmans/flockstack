"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// The content calendar's forms. Each runs a registered action, as the API does: planning only, so nothing here sends,
// schedules or publishes, and approving is the owner's click on the item or the batch.

function refresh(id, batchId) {
	revalidatePath("/campaigns/calendar");
	if (id) revalidatePath(`/campaigns/calendar/items/${id}`);
	if (batchId) revalidatePath(`/campaigns/calendar/batches/${batchId}`);
}

function text(value, max = 10000) {
	return String(value ?? "").slice(0, max);
}

// The writable fields of the editor's form as the actions take them. Empty text clears a field.
function readFields(values) {
	return {
		title: text(values?.title, 200),
		obstacle: text(values?.obstacle, 1000),
		takeaway: text(values?.takeaway, 1000),
		pillar: text(values?.pillar, 60),
		hook: text(values?.hook, 300),
		body: text(values?.body),
		cta: text(values?.cta, 300),
		destinationUrl: text(values?.destinationUrl, 2000),
		notes: text(values?.notes),
		funnelStage: ["TOFU", "MOFU", "BOFU"].includes(values?.funnelStage) ? values.funnelStage : null,
		references: (Array.isArray(values?.references) ? values.references : [])
			.map((reference) => ({ label: text(reference?.label, 120), url: text(reference?.url, 2000), kind: reference?.kind === "evidence" ? "evidence" : "reference" }))
			.filter((reference) => reference.url.trim()),
	};
}

export async function createContentItem(newsletterId, values) {
	const { output, failure } = await runDashboardAction("create_content_item", {
		newsletter: String(newsletterId ?? ""),
		channel: values?.channel === "newsletter" ? "newsletter" : "linkedin",
		title: text(values?.title, 200),
		...(["TOFU", "MOFU", "BOFU"].includes(values?.funnelStage) && { funnelStage: values.funnelStage }),
		...(values?.plannedDate && { plannedDate: text(values.plannedDate, 10), timeZone: text(values?.timeZone, 64) || undefined }),
	});
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true, id: output.item.id };
}

// A draft campaign becomes a newsletter item linked to it. The campaign itself is not changed.
export async function planCampaignDraft(newsletterId, campaignId) {
	const { output, failure } = await runDashboardAction("create_content_item", { newsletter: String(newsletterId ?? ""), channel: "newsletter", campaign: String(campaignId ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true, id: output.item.id };
}

// A LinkedIn post drafted for an issue, kept in the plan as a post derived from it, to finish and review.
export async function savePostToPlan(newsletterId, campaignId, title, body) {
	const { output, failure } = await runDashboardAction("create_content_item", {
		newsletter: String(newsletterId ?? ""),
		channel: "linkedin",
		title: text(title, 200) || "LinkedIn post",
		body: text(body, 10000),
		campaign: String(campaignId ?? ""),
	});
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true, id: output.item.id };
}

export async function saveContentItem(id, values) {
	const { output, failure } = await runDashboardAction("update_content_item", {
		id: String(id ?? ""),
		...readFields(values),
		...(typeof values?.batch === "string" && { batch: values.batch || null }),
		...(["idea", "drafting"].includes(values?.state) && { state: values.state }),
	});
	if (failure) return toFormError(failure);
	refresh(id, output.item.batchId);
	return { ok: true, approvalWithdrawn: output.approvalWithdrawn };
}

// idea or drafting; an approved item set back to drafting loses its approval.
export async function setContentState(id, state) {
	const { failure } = await runDashboardAction("update_content_item", { id: String(id ?? ""), state: state === "idea" ? "idea" : "drafting" });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

// A day, and a time if one is given; an empty day sends the item back to the backlog.
export async function moveContentItem(id, values) {
	const date = text(values?.date, 10);
	const { failure } = await runDashboardAction("set_content_slot", {
		id: String(id ?? ""),
		date: date || null,
		...(date && { time: text(values?.time, 5) || null }),
		...(date && values?.timeZone && { timeZone: text(values.timeZone, 64) }),
		...(date && Number.isInteger(values?.position) && values.position > 0 && { position: values.position }),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function reorderContentItems(scope, ids, batchId) {
	const { failure } = await runDashboardAction("reorder_content_items", { scope: scope === "batch" ? "batch" : "day", ids: (Array.isArray(ids) ? ids : []).map(String) });
	if (failure) return toFormError(failure);
	refresh(null, batchId);
	return { ok: true };
}

export async function saveContentAssets(id, assets) {
	const { output, failure } = await runDashboardAction("set_content_assets", {
		id: String(id ?? ""),
		assets: (Array.isArray(assets) ? assets : []).map((asset) => ({ media: String(asset?.mediaId ?? ""), altText: text(asset?.altText, 420) })),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, approvalWithdrawn: output.approvalWithdrawn };
}

export async function attachContentAsset(id, mediaId) {
	const { output, failure } = await runDashboardAction("attach_content_asset", { id: String(id ?? ""), media: String(mediaId ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, approvalWithdrawn: output.approvalWithdrawn };
}

// campaignId empty takes the link off.
export async function linkContentCampaign(id, campaignId) {
	const { output, failure } = await runDashboardAction("link_content_campaign", { id: String(id ?? ""), campaign: campaignId ? String(campaignId) : null });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, approvalWithdrawn: output.approvalWithdrawn };
}

export async function requestContentReview(id) {
	const { failure } = await runDashboardAction("request_content_review", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

// decision: approve, or request_changes with a note.
export async function decideContentReview(id, decision, note) {
	const { output, failure } = await runDashboardAction("decide_content_review", {
		id: String(id ?? ""),
		decision: decision === "approve" ? "approve" : "request_changes",
		...(note && { note: text(note, 1000) }),
	});
	if (failure) return toFormError(failure);
	refresh(id, output.item.batchId);
	return { ok: true };
}

export async function recordContentPublication(id, values) {
	const deliveredAt = text(values?.deliveredAt, 40);
	const { failure } = await runDashboardAction("record_content_publication", {
		id: String(id ?? ""),
		...(values?.published === false ? { published: false } : { url: text(values?.url, 2000) || undefined, ...(deliveredAt && { deliveredAt }) }),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function restoreContentRevision(id, revisionId) {
	const { output, failure } = await runDashboardAction("restore_content_revision", { id: String(id ?? ""), revision: String(revisionId ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, skipped: output.skipped, approvalWithdrawn: output.approvalWithdrawn };
}

export async function deleteContentItem(id) {
	const { failure } = await runDashboardAction("delete_content_item", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	redirect("/campaigns/calendar");
}

export async function createEditorialBatch(newsletterId, name) {
	const { output, failure } = await runDashboardAction("create_editorial_batch", { newsletter: String(newsletterId ?? ""), name: text(name, 120) });
	if (failure) return toFormError(failure);
	refresh();
	return { ok: true, id: output.batch.id };
}

export async function requestBatchReview(id) {
	const { output, failure } = await runDashboardAction("request_batch_review", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh(null, id);
	return { ok: true, requested: output.requested.length, blocked: output.blocked.length };
}

// Approves every item of the batch that is in review and has nothing missing. Each is the owner's decision, made here.
export async function approveReadyItems(batchId) {
	const batch = await runDashboardAction("get_editorial_batch", { id: String(batchId ?? "") });
	if (batch.failure) return toFormError(batch.failure);
	let approved = 0;
	for (const item of batch.output.items.filter((one) => one.state === "ready_for_review" && one.canApprove)) {
		const { failure } = await runDashboardAction("decide_content_review", { id: item.id, decision: "approve" });
		if (failure) return toFormError(failure);
		approved++;
	}
	refresh(null, batchId);
	return { ok: true, approved };
}

// A pattern is saved on the batch, or only shown (preview) or applied to its items. Planning only: a slot is a planned day.
function readPattern(values) {
	const stages = (Array.isArray(values?.stages) ? values.stages : []).filter((stage) => ["TOFU", "MOFU", "BOFU"].includes(stage));
	const weekdays = (Array.isArray(values?.weekdays) ? values.weekdays : []).map(Number).filter((day) => day >= 1 && day <= 7);
	return {
		...(stages.length > 0 && { stages }),
		cadence: {
			...(weekdays.length > 0 ? { weekdays } : { everyDays: Math.max(1, Number(values?.everyDays) || 1) }),
			...(values?.time && { time: text(values.time, 5) }),
			...(values?.timeZone && { timeZone: text(values.timeZone, 64) }),
		},
		...(values?.issue === "briefing" && { issue: "briefing" }),
	};
}

export async function saveBatchPattern(id, values) {
	const hasPattern = values?.stages?.length > 0 || values?.issue === "briefing";
	const { failure } = await runDashboardAction("update_editorial_batch", { id: String(id ?? ""), pattern: hasPattern ? readPattern(values) : null });
	if (failure) return toFormError(failure);
	refresh(null, id);
	return { ok: true };
}

export async function applyBatchPattern(id, values) {
	const { output, failure } = await runDashboardAction("apply_editorial_pattern", {
		id: String(id ?? ""),
		startDate: text(values?.startDate, 10),
		pattern: readPattern(values),
		matchStages: values?.matchStages === true,
		dryRun: values?.dryRun === true,
	});
	if (failure) return toFormError(failure);
	if (values?.dryRun !== true) refresh(null, id);
	return { ok: true, result: output };
}

export async function deleteEditorialBatch(id) {
	const { failure } = await runDashboardAction("delete_editorial_batch", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	refresh();
	redirect("/campaigns/calendar");
}
