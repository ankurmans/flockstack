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
export async function createCampaign(newsletterId, templateId, kind) {
	const { output, failure } = await runDashboardAction("create_campaign", {
		newsletter: String(newsletterId ?? ""),
		...(templateId && { template: String(templateId) }),
		...(kind === "note" && { kind: "note" }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	redirect(`/campaigns/${output.id}`);
}

export async function createShortPostDigest(newsletterId, externalId) {
	const { output, failure } = await runDashboardAction("create_short_post_digest", { newsletter: String(newsletterId), externalId: String(externalId) });
	if (failure) return toFormError(failure);
	refresh(output.id);
	redirect(`/campaigns/${output.id}`);
}

export async function saveShortPost(id, body, published) {
	const input = { id: String(id), content: String(body ?? ""), format: "markdown" };
	const result = published ? await runDashboardAction("update_published_issue", input) : await runDashboardAction("update_campaign", input);
	if (result.failure) return toFormError(result.failure);
	refresh(id);
	return { ok: true };
}

// The editor saves rich text, or the HTML of an imported issue; Markdown drafts open as rich text.
export async function saveCampaign(id, values) {
	const { output, failure } = await runDashboardAction("update_campaign", {
		id: String(id),
		...(values?.expectedContentHash && { expectedContentHash: values.expectedContentHash }),
		subject: String(values?.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
		previewText: String(values?.previewText ?? "").slice(0, MAX_PREVIEW_TEXT_LENGTH),
		content: String(values?.body ?? ""),
		...(values?.format && { format: values.format }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	return { ok: true, ...(values?.expectedContentHash && { contentHash: output.contentHash }) };
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

// Share buttons in this issue's email header: on, off, or null to follow the newsletter.
export async function setCampaignShareButtons(id, value) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), shareButtons: value === true ? true : value === false ? false : null });
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

// Only a random cohort is asked for by name: anything else is the most engaged first.
function readAudienceOrder(value) {
	return value === "random" ? "random" : "engaged";
}

export async function sendCampaign(id, { audienceLimit, audience, audienceOrder } = {}) {
	const { failure } = await runDashboardAction("send_campaign", { id: String(id), audienceLimit: readCount(audienceLimit), audience: readAudience(audience), audienceOrder: readAudienceOrder(audienceOrder) });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}

// The Send button: like sendCampaign, but the send waits the newsletter's undo window first (lib/send-hold.js). What it answers
// tells the bar at the bottom of the dashboard what to count down to, or what to celebrate when nothing waited.
export async function startSend(id, { audienceLimit, audience, audienceOrder } = {}) {
	const { output, failure } = await runDashboardAction("send_campaign", {
		id: String(id),
		audienceLimit: readCount(audienceLimit),
		audience: readAudience(audience),
		audienceOrder: readAudienceOrder(audienceOrder),
		holdForUndo: true,
	});
	refresh(id);
	if (failure) return toFormError(failure);
	return {
		ok: true,
		status: output.status,
		subject: output.subject,
		recipients: output.hold?.recipients ?? output.stats.recipients,
		...(output.hold && { sendAfter: output.hold.sendAfter, serverTime: new Date().toISOString() }),
	};
}

// Takes a held send back to a draft; answers whether it was still in time.
export async function undoSend(id) {
	const { failure } = await runDashboardAction("undo_campaign_send", { id: String(id) });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}

// The sends waiting for their undo window, for the bar at the bottom of every dashboard page.
export async function listHeldSends() {
	const { output, failure } = await runDashboardAction("list_campaigns", { status: "held", limit: 5 });
	if (failure) return toFormError(failure);
	return {
		now: new Date().toISOString(),
		holds: output.campaigns
			.filter(({ hold }) => hold)
			.map(({ id, subject, hold }) => ({ id, subject, sendAfter: hold.sendAfter, recipients: hold.recipients })),
	};
}

// A sent issue's web page: its title, subtitle, body, tags and search settings. The emails that went out stay as they were.
export async function savePublishedIssue(id, { title, subtitle, body, format, tags, seo } = {}) {
	const { failure } = await runDashboardAction("update_published_issue", {
		id: String(id),
		title: String(title ?? "").slice(0, MAX_SUBJECT_LENGTH),
		subtitle: String(subtitle ?? "").slice(0, MAX_PREVIEW_TEXT_LENGTH),
		content: String(body ?? ""),
		...(format && { format }),
		tags: String(tags ?? "")
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean),
		seoTitle: String(seo?.title ?? ""),
		seoDescription: String(seo?.description ?? ""),
		socialImage: String(seo?.image ?? ""),
		noindex: seo?.noindex === true,
	});
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	revalidatePath(`/campaigns/${id}/edit`);
	return { ok: true };
}

// What the bar and the report ask every few seconds while a send goes out.
export async function readProgress(id) {
	const { output, failure } = await runDashboardAction("get_campaign_progress", { id: String(id) });
	return failure ? toFormError(failure) : output;
}

// The review step's ready-to-send check (lib/ready-check.js).
export async function checkCampaign(id) {
	const { output, failure } = await runDashboardAction("check_campaign", { id: String(id) });
	return failure ? toFormError(failure) : output;
}

export async function scheduleCampaign(id, { scheduledAt, audienceLimit, audience, audienceOrder } = {}) {
	const { failure } = await runDashboardAction("schedule_campaign", {
		id: String(id),
		scheduledAt: String(scheduledAt ?? ""),
		audienceLimit: readCount(audienceLimit),
		audience: readAudience(audience),
		audienceOrder: readAudienceOrder(audienceOrder),
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
export async function previewCleanup(id, audienceOrder) {
	const { output, failure } = await runDashboardAction("preview_campaign_cleanup", { id: String(id), includeRanks: true, ...(audienceOrder && { audienceOrder: readAudienceOrder(audienceOrder) }) });
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

// The issue's tags, which the website shows on the issue and gives each a page. Separated by commas.
export async function setCampaignTags(id, text) {
	const tags = String(text ?? "")
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
	const { output, failure } = await runDashboardAction("update_campaign_archive", { id: String(id), tags });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, tags: output.tags };
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

// The AI writing tools. Each takes one request of the day (lib/ai-usage.js); the answer comes back as a suggestion the
// writer accepts or discards, and nothing in any campaign changes here.
export async function rewriteSelection({ text, style, language } = {}) {
	const { output, failure } = await runDashboardAction("rewrite_text", {
		text: String(text ?? ""),
		style: String(style ?? ""),
		...(language && { language: String(language) }),
	});
	return failure ? { error: failure.message, code: failure.code } : output;
}

export async function suggestSubjectLines(id) {
	const { output, failure } = await runDashboardAction("suggest_subject_lines", { campaign: String(id) });
	return failure ? { error: failure.message, code: failure.code } : output;
}

export async function suggestPreviewText(id, subject) {
	const { output, failure } = await runDashboardAction("suggest_preview_text", {
		campaign: String(id),
		...(subject && { subject: String(subject).slice(0, MAX_SUBJECT_LENGTH) }),
	});
	return failure ? { error: failure.message, code: failure.code } : output;
}

export async function draftSocialPosts(id, subject) {
	const { output, failure } = await runDashboardAction("draft_social_posts", {
		campaign: String(id),
		...(subject && { subject: String(subject).slice(0, MAX_SUBJECT_LENGTH) }),
	});
	return failure ? { error: failure.message, code: failure.code } : output;
}

// The earlier states kept of a draft, one to read before restoring it, and the restore.
export async function listCampaignVersions(id) {
	const { output, failure } = await runDashboardAction("list_campaign_versions", { id: String(id) });
	return failure ? toFormError(failure) : output;
}

export async function readCampaignVersion(id, version) {
	const { output, failure } = await runDashboardAction("get_campaign_version", { id: String(id), version: String(version) });
	return failure ? toFormError(failure) : output;
}

export async function restoreCampaignVersion(id, version) {
	const { failure } = await runDashboardAction("restore_campaign_version", { id: String(id), version: String(version) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

// The editor's stock photo picker (Unsplash): search, and picking one, which reports the use to Unsplash and brings back the
// credit the photo is shown with.
export async function searchStock(query, page) {
	const { output, failure } = await runDashboardAction("search_stock_photos", { query: String(query ?? "").slice(0, 100), page: readCount(page) ?? 1, perPage: 18 });
	return failure ? toFormError(failure) : output;
}

// The editor's GIF picker (GIPHY): a page of results from an offset.
export async function searchGifs(query, offset) {
	const { output, failure } = await runDashboardAction("search_gifs", { query: String(query ?? "").slice(0, 100), offset: Math.max(0, Math.min(4999, Math.trunc(Number(offset)) || 0)), perPage: 18 });
	return failure ? toFormError(failure) : output;
}

export async function pickStockPhoto(id) {
	const { output, failure } = await runDashboardAction("use_stock_photo", { id: String(id ?? "") });
	return failure ? toFormError(failure) : output;
}

// Delete, list, unlist or move several campaigns; the answer says what happened to each.
export async function bulkUpdateCampaigns(ids, operation, newsletter, options = {}) {
	const { output, failure } = await runDashboardAction("bulk_update_campaigns", {
		ids: Array.isArray(ids) ? ids.map(String) : [],
		operation: String(operation ?? ""),
		...(newsletter && { newsletter: String(newsletter) }),
		...(operation === "tag" && { tags: options.tags ?? [], tagMode: options.tagMode ?? "replace" }),
		...(operation === "author" && { authorId: options.authorId ?? null }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	revalidatePath("/");
	return { ok: true, done: output.done, skipped: output.skipped, reasons: [...new Set(output.results.map(({ reason }) => reason).filter(Boolean))] };
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

export async function setCampaignLists(id, _state, form) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), listIds: form.getAll("include").map(String), excludeListIds: form.getAll("exclude").map(String) });
	if (failure) return { error: failure.message }; revalidatePath(`/campaigns/${id}`); return { ok: true };
}

export async function searchIssueLinks(newsletter, search) {
	const { output, failure } = await runDashboardAction("list_campaigns", { newsletter: String(newsletter), search: String(search ?? "").slice(0, 100), status: "sent", limit: 20 });
	if (failure) return { error: failure.message, issues: [] };
	return { issues: output.campaigns.filter((issue) => issue.archiveUrl && issue.publishTo !== "email" && !issue.resend).map(({ id, subject, archiveUrl }) => ({ id, title: subject, url: archiveUrl })) };
}
export async function getIssueLinks(id) {
	const { output, failure } = await runDashboardAction("get_issue_links", { id: String(id) });
	return failure ? { error: failure.message } : output;
}
export async function indexIssueLinks(newsletter, after) {
	const { output, failure } = await runDashboardAction("index_issue_links", { newsletter: String(newsletter), ...(after && { after: String(after) }) });
	return failure ? { error: failure.message } : output;
}
