"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

const MAX_SUBJECT_LENGTH = 200;
const MAX_PREVIEW_TEXT_LENGTH = 300;

function readCount(value) {
	const count = Number(value);
	return Number.isInteger(count) && count > 0 ? count : undefined;
}

function refresh(id) {
	revalidatePath("/campaigns");
	if (id) revalidatePath(`/campaigns/${id}`);
}

export async function createCampaign(newsletterId) {
	const { output, failure } = await runDashboardAction("create_campaign", { newsletter: String(newsletterId ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	redirect(`/campaigns/${output.id}`);
}

// The editor saves rich text, or the HTML of an imported issue; Markdown drafts open as rich text.
export async function saveCampaign(id, values) {
	const { failure } = await runDashboardAction("update_campaign", {
		id: String(id),
		subject: String(values?.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
		previewText: String(values?.previewText ?? "").slice(0, MAX_PREVIEW_TEXT_LENGTH),
		content: String(values?.body ?? ""),
		...(values?.format && { format: values.format }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	return { ok: true };
}

// Who the issue goes to, saved before the send so the list cleanup's count follows it.
export async function setCampaignAudience(id, audience) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), audience: readAudience(audience) });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// Everyone, or one of the newsletter's saved segments (null clears it).
export async function setCampaignSegment(id, segmentId) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), segment: segmentId ? String(segmentId) : null });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function sendTestCampaign(id) {
	const { failure } = await runDashboardAction("send_test_email", { id: String(id) });
	revalidatePath(`/campaigns/${id}`);
	return failure ? toFormError(failure) : { ok: true };
}

function readAudience(value) {
	return ["free", "paid"].includes(value) ? value : "all";
}

export async function sendCampaign(id, { audienceLimit, audience } = {}) {
	const { failure } = await runDashboardAction("send_campaign", { id: String(id), audienceLimit: readCount(audienceLimit), audience: readAudience(audience) });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}

export async function scheduleCampaign(id, { scheduledAt, audienceLimit, audience } = {}) {
	const { failure } = await runDashboardAction("schedule_campaign", {
		id: String(id),
		scheduledAt: String(scheduledAt ?? ""),
		audienceLimit: readCount(audienceLimit),
		audience: readAudience(audience),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function unscheduleCampaign(id) {
	const { failure } = await runDashboardAction("unschedule_campaign", { id: String(id) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

// The send dialogs ask when they open: it walks the whole list.
export async function previewCleanup(id) {
	const { output, failure } = await runDashboardAction("preview_campaign_cleanup", { id: String(id), includeRanks: true });
	if (failure) return toFormError(failure);
	return output.enabled ? { enabled: true, ...output.ranks } : { enabled: false };
}

// Without a number, the campaign goes to everyone who hasn't received it yet.
export async function sendCampaignToMore(id, { additional } = {}) {
	const { failure } = await runDashboardAction("send_campaign_to_more", { id: String(id), additional: readCount(additional) });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}

export async function resumeCampaign(id) {
	const { failure } = await runDashboardAction("resume_campaign", { id: String(id) });
	revalidatePath(`/campaigns/${id}`);
	return failure ? toFormError(failure) : { ok: true };
}

export async function pauseCampaign(id) {
	const { failure } = await runDashboardAction("pause_campaign", { id: String(id) });
	revalidatePath(`/campaigns/${id}`);
	return failure ? toFormError(failure) : { ok: true };
}

export async function toggleArchivePin(id) {
	const current = await runDashboardAction("get_campaign", { id: String(id) });
	if (current.failure) return toFormError(current.failure);
	const { failure } = await runDashboardAction("update_campaign_archive", { id: String(id), pinned: !current.output.archivePinned });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function duplicateCampaign(id) {
	const { output, failure } = await runDashboardAction("duplicate_campaign", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	redirect(`/campaigns/${output.id}`);
}

// Discarded campaigns keep everything: canceled hides them from the lists and stops a scheduled send.
export async function discardCampaign(id) {
	const { failure } = await runDashboardAction("delete_campaign", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/");
	revalidatePath("/campaigns");
	return { ok: true };
}

// The page lives at /p/<slug> once the issue goes out. A draft without one gets the subject's slug then.
export async function updateArchiveSlug(id, value) {
	const { output, failure } = await runDashboardAction("update_campaign_archive", { id: String(id), slug: String(value ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, archiveSlug: output.archiveSlug ?? "" };
}

// The editor's poll block: { question, options: [{ label, tag }], fieldKey, showResults, followUp }.
function readPoll(values) {
	return {
		question: String(values?.question ?? ""),
		options: (Array.isArray(values?.options) ? values.options : []).map(({ label, tag }) => ({ label: String(label ?? ""), ...(tag && { tag: String(tag) }) })),
		fieldKey: values?.fieldKey ? String(values.fieldKey) : null,
		showResults: values?.showResults !== false,
		followUp: values?.followUp ? String(values.followUp) : null,
	};
}

export async function createPoll(newsletterId, campaignId, values) {
	const { output, failure } = await runDashboardAction("create_poll", {
		newsletter: String(newsletterId ?? ""),
		...(campaignId && { campaign: String(campaignId) }),
		...readPoll(values),
	});
	return failure ? toFormError(failure) : { poll: output };
}

export async function updatePoll(id, values) {
	const { output, failure } = await runDashboardAction("update_poll", { id: String(id ?? ""), ...readPoll(values) });
	return failure ? toFormError(failure) : { poll: output };
}

export async function getPoll(id) {
	const { output, failure } = await runDashboardAction("get_poll", { id: String(id ?? "") });
	return failure ? toFormError(failure) : { poll: output };
}

// Who picked an answer, for the report; option null for everyone.
export async function listPollVoters(id, option, cursor) {
	const { output, failure } = await runDashboardAction("list_poll_voters", {
		id: String(id ?? ""),
		...(Number.isInteger(option) && { option }),
		...(cursor && { cursor: String(cursor) }),
	});
	return failure ? toFormError(failure) : output;
}
