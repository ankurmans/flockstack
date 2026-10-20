import { scoped } from "@/lib/account-scope";
import { htmlToMarkdown } from "@/lib/html-to-markdown";
import { markdownToHtml } from "@/lib/markdown";
import CampaignVersion from "@/models/CampaignVersion";

// How many earlier states of a draft stay, and how far apart autosaves make them: the editor saves every second or so, so
// a state is kept at most every two minutes, and 30 of them reach back about an hour of steady writing.
export const KEEP_VERSIONS = 30;
export const VERSION_GAP_MS = 2 * 60 * 1000;

function contentOf(source) {
	return {
		subject: source.subject ?? "",
		previewText: source.previewText ?? "",
		format: source.format ?? "rich",
		markdown: source.markdown ?? "",
		html: source.html ?? "",
	};
}

function isSame(a, b) {
	const [left, right] = [contentOf(a), contentOf(b)];
	return Object.keys(left).every((key) => left[key] === right[key]);
}

function isEmpty(source) {
	return !source.subject?.trim() && !source.previewText?.trim() && !source.html?.trim() && !source.markdown?.trim();
}

// Keeps the draft as it is now, before an edit replaces it. Nothing is kept for an empty draft, one the same as the latest
// kept state, or (for an autosave) when the latest was kept less than two minutes ago. `changes` are the fields the edit
// sets: an edit that changes none of the content keeps nothing.
export async function recordVersion(account, campaign, { reason = "autosave", changes = null, now = new Date() } = {}) {
	if (changes && isSame(campaign, { ...campaign, ...changes })) return null;
	if (isEmpty(campaign)) return null;
	const latest = await CampaignVersion.findOne(scoped(account, { campaignId: campaign._id })).sort({ createdAt: -1, _id: -1 }).lean();
	if (latest && isSame(latest, campaign)) return null;
	if (reason === "autosave" && latest && now.getTime() - new Date(latest.createdAt).getTime() < VERSION_GAP_MS) return null;
	const version = await CampaignVersion.create({ accountId: account._id, campaignId: campaign._id, ...contentOf(campaign), reason });
	const old = await CampaignVersion.find(scoped(account, { campaignId: campaign._id })).sort({ createdAt: -1, _id: -1 }).skip(KEEP_VERSIONS).select({ _id: 1 }).lean();
	if (old.length > 0) await CampaignVersion.deleteMany(scoped(account, { _id: { $in: old.map(({ _id }) => _id) } }));
	return version;
}

// A kept state's words as plain text, for a list and a preview.
export function getVersionText(version) {
	const html = version.format === "markdown" ? markdownToHtml(version.markdown ?? "") : (version.html ?? "");
	return version.format === "html" ? htmlToMarkdown(html.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")).trim() : htmlToMarkdown(html).trim();
}

export function countWords(text) {
	return String(text ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}
