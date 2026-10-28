import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, newsletterInput } from "@/lib/actions/shared";
import { getIssueContentHtml } from "@/lib/archive-content";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { escapeHtml } from "@/lib/escape-html";
import { getReaderText } from "@/lib/reader-languages";
import { shortPostFields } from "@/lib/short-post-rules";
import Campaign from "@/models/Campaign";

function result(campaign) {
	return { id: String(campaign._id), noteIds: campaign.shortPostDigest.noteIds, from: campaign.shortPostDigest.from, to: campaign.shortPostDigest.to, status: campaign.status };
}
const draftDigest = defineAction({
	name: "create_short_post_digest", title: "Draft a short-post digest", group: "Campaigns",
	description: "Creates an ordinary newsletter draft containing this newsletter's public, listed short posts from the last seven days, or a shorter window you choose. Includes full public post bodies and their links, oldest first. Up to 20 posts; if there are more, choose fewer days. No email is sent and no job is queued. Review and edit the draft, then use the existing send or scheduling action with its normal checks and agent approval. This does not enable automatic recurring sends.",
	http: { method: "POST", path: "/short-posts/digest", status: 201 }, idempotent: true,
	input: z.object({ newsletter: newsletterInput, externalId: z.string().trim().min(1).max(100).describe("A unique retry key for this digest; a repeat returns the original draft unchanged"), days: z.number().int().min(1).max(7).optional().describe("Look back this many days from now, default seven"), subject: z.string().trim().min(1).max(200).optional().describe("The digest email's subject. Default: This week’s short posts.") }),
	output: z.object({ id: z.string().describe("The normal campaign ID to review, edit and schedule"), noteIds: z.array(z.string()), from: z.string(), to: z.string(), status: z.string() }),
	handler: async ({ account, input, via }) => {
		const newsletter = await findNewsletter(account, input.newsletter, "accountId name slug language archiveEnabled archiveHost mount");
		const externalId = `short-digest:${input.externalId}`;
		const findExisting = () => Campaign.findOne(scoped(account, { externalId })).lean();
		const reuse = (existing) => {
			if (!existing.shortPostDigest || String(existing.newsletterId) !== String(newsletter._id)) throw actionError("conflict", "This retry key belongs to another draft");
			return result(existing);
		};
		const existing = await findExisting(); if (existing) return reuse(existing);
		if (!newsletter.archiveEnabled) throw actionError("validation_failed", "Turn on this newsletter's website first");
		const to = new Date(); const from = new Date(to.getTime() - (input.days ?? 7) * 86400000);
		const notes = await Campaign.find(scoped(account, { newsletterId: newsletter._id, kind: "note", status: "sent", publishTo: "web", archiveListed: { $ne: false }, archiveSlug: { $type: "string" }, audience: "all", sentAt: { $gte: from, $lte: to } })).sort({ sentAt: 1, _id: 1 }).limit(21).select("kind format markdown html archiveSlug sentAt authorId").lean();
		if (!notes.length) throw actionError("validation_failed", "No public short posts in this date window");
		if (notes.length > 20) throw actionError("validation_failed", "More than 20 short posts in this window. Choose fewer days to keep the digest complete.");
		const urls = getArchiveUrls(newsletter);
		for (const note of notes) shortPostFields(note);
		const html = notes.map((note) => `${getIssueContentHtml(note, { readerTier: "free", isUnlocked: false })}<p><a href="${escapeHtml(urls.absolutePost(note.archiveSlug))}">${escapeHtml(getReaderText(newsletter)("Read short post"))}</a></p>`).join("<hr>");
		const data = { accountId: account._id, newsletterId: newsletter._id, externalId, kind: "issue", status: "draft", subject: input.subject ?? "This week’s short posts", format: "rich", html, publishTo: "both", audience: "all", shortPostDigest: { from: from.toISOString(), to: to.toISOString(), noteIds: notes.map((note) => String(note._id)) }, source: via === "dashboard" ? "dashboard" : "api" };
		try { return result((await Campaign.create(data)).toObject()); }
		catch (error) { if (error?.code !== 11000) throw error; const saved = await findExisting(); if (!saved) throw error; return reuse(saved); }
	},
});
export const shortPostActions = [draftDigest];
