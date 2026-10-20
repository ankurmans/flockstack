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

// templateId: start from a saved template; without one, the newsletter's default style.
export async function createCampaign(newsletterId, templateId) {
	const { output, failure } = await runDashboardAction("create_campaign", {
		newsletter: String(newsletterId ?? ""),
		...(templateId && { template: String(templateId) }),
	});
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

// Email and web, email only or web only.
export async function setCampaignPublishTo(id, publishTo) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), publishTo: ["email", "web"].includes(publishTo) ? publishTo : "both" });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// Shown in the website's list of issues and its feed, or only at its link.
export async function toggleArchiveListed(id) {
	const current = await runDashboardAction("get_campaign", { id: String(id) });
	if (current.failure) return toFormError(current.failure);
	const { failure } = await runDashboardAction("update_campaign_archive", { id: String(id), listed: !current.output.archiveListed });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// Contacts in any of these segments, leaving out those in the others; empty lists go back to everyone and nobody.
export async function setCampaignSegments(id, { include = [], exclude = [] } = {}) {
	const { failure } = await runDashboardAction("update_campaign", {
		id: String(id),
		segments: include.map(String),
		excludeSegments: exclude.map(String),
	});
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// This issue's sender name; empty goes back to the newsletter's.
export async function setCampaignFromName(id, fromName) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), fromName: String(fromName ?? "").slice(0, 100) });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// Who the issue goes to, saved before the send so the list cleanup's count follows it.
export async function setCampaignAudience(id, audience) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), audience: readAudience(audience) });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function sendTestCampaign(id, to) {
	const addresses = Array.isArray(to) ? to.map((email) => String(email).trim()).filter(Boolean) : [];
	const { output, failure } = await runDashboardAction("send_test_email", { id: String(id), ...(addresses.length > 0 && { to: addresses }) });
	revalidatePath(`/campaigns/${id}`);
	if (failure) return toFormError(failure);
	return addresses.length > 0 ? { ok: true, sentTo: output.recipients.map(({ email }) => email), skipped: output.skipped.map(({ email }) => email) } : { ok: true };
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

// One page of who clicked a link of a sent campaign; cursor comes from the page before.
export async function listLinkClicks(id, link, cursor) {
	const { output, failure } = await runDashboardAction("list_link_clicks", { id: String(id), link: Number(link), ...(cursor && { cursor: String(cursor) }) });
	return failure ? toFormError(failure) : output;
}

// The campaign's subject line test, or null to remove it.
export async function setCampaignAbTest(id, abTest) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), abTest: abTest ?? null });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// A copy for the readers who didn't open (or click) a sent campaign, scheduled; its page opens next.
export async function resendCampaign(id, { subject, previewText, to, scheduledAt } = {}) {
	const { output, failure } = await runDashboardAction("resend_campaign", {
		id: String(id),
		subject: String(subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
		...(previewText && { previewText: String(previewText).slice(0, MAX_PREVIEW_TEXT_LENGTH) }),
		to: to === "unclicked" ? "unclicked" : "unopened",
		...(scheduledAt && { scheduledAt: String(scheduledAt) }),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, id: output.id };
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

// What search engines and social cards show for the issue's page; empty clears a field.
export async function setCampaignSeo(id, { title, description, image, noindex } = {}) {
	const { failure } = await runDashboardAction("update_campaign_archive", {
		id: String(id),
		seoTitle: String(title ?? ""),
		seoDescription: String(description ?? ""),
		socialImage: String(image ?? ""),
		noindex: noindex === true,
	});
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// Any issue, draft or sent, as a template for new ones.
export async function saveCampaignAsTemplate(id, name) {
	const { output, failure } = await runDashboardAction("create_template", { campaign: String(id ?? ""), name: String(name ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/templates");
	return { ok: true, template: output };
}

// The editor's RSS block shows what the feed has now.
export async function previewFeed(url, { count, order } = {}) {
	const { output, failure } = await runDashboardAction("preview_feed", { url: String(url ?? ""), count: readCount(count), order: order === "oldest" ? "oldest" : "newest" });
	if (failure) return toFormError(failure);
	return { items: output.items };
}
