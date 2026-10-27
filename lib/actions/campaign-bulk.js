import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { EDITABLE_STATUSES, readTags, tagsInput } from "@/lib/actions/campaigns";
import { defineAction } from "@/lib/actions/define-action";
import { findNewsletter, idInput } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { isResend } from "@/lib/resend-rules";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Poll from "@/models/Poll";

const MAX_IDS = 100;
const OPERATIONS = ["delete", "unlist", "list", "move", "tag", "author"];

const ResultSchema = z.object({
	id: z.string(),
	status: z.enum(["done", "skipped"]),
	reason: z.string().nullable().describe("Why a campaign was skipped, or null"),
});

// Each operation on one campaign: a reason it can't be done, or null once it was.
const OPERATION_HANDLERS = {
	async tag(account, campaign, { input }) {
		if (!["draft", "scheduled", "sent"].includes(campaign.status)) return "Wait until the send is over";
		const current = campaign.tags ?? [];
		const tags = input.tagMode === "add" ? [...current, ...input.tags] : input.tagMode === "remove" ? current.filter((tag) => !input.tags.includes(tag)) : input.tags;
		let set;
		try { set = readTags(tags); } catch (error) { return error.message; }
		const result = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: campaign.status, updatedAt: campaign.updatedAt }), { $set: set });
		return result.matchedCount ? null : "The campaign changed; retry the operation";
	},
	async author(account, campaign, { input }) {
		try {
			const newsletter = await findNewsletter(account, String(campaign.newsletterId));
			await (await import("@/lib/authors")).setIssueAuthor(account, campaign, newsletter, input.authorId);
			return null;
		} catch (error) { return error.message; }
	},
	async delete(account, campaign) {
		if (!EDITABLE_STATUSES.includes(campaign.status)) return "Only drafts and scheduled campaigns can be deleted";
		const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: { $in: EDITABLE_STATUSES } }), {
			$set: { status: "canceled" },
			$unset: { scheduledAt: 1 },
		});
		if (!matchedCount) return "It started sending";
		// A discarded resend leaves its campaign free to be resent.
		if (isResend(campaign)) await Campaign.updateOne(scoped(account, { _id: campaign.resend.of, resentAs: campaign._id }), { $unset: { resentAs: 1 } });
		return null;
	},
	async unlist(account, campaign) {
		if (campaign.publishTo === "email") return "An email only issue has no web page to list";
		await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: { archiveListed: false }, $unset: { archivePinned: 1 } });
		return null;
	},
	async list(account, campaign) {
		if (campaign.publishTo === "email") return "An email only issue has no web page to list";
		await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: { archiveListed: true } });
		return null;
	},
	async move(account, campaign, { target }) {
		if (campaign.status !== "draft") return campaign.status === "scheduled" ? "Unschedule it first" : "A sent issue stays in the newsletter it went out from";
		if (String(campaign.newsletterId) === String(target._id)) return "It is already in that newsletter";
		// The old newsletter's segments don't exist in the new one, and paid readers only where it has a paid tier.
		const unset = { internalLinks: 1, internalLinkIds: 1, authorId: 1, listIds: 1, excludeListIds: 1, segmentId: 1, segmentIds: 1, excludeSegmentIds: 1, segmentSnapshot: 1 };
		const set = { newsletterId: target._id, ...(!target.paidTier?.enabled && campaign.audience && campaign.audience !== "all" && { audience: "all" }) };
		await Campaign.updateOne(scoped(account, { _id: campaign._id, status: "draft" }), { $set: set, $unset: unset });
		await Poll.updateMany(scoped(account, { campaignId: campaign._id }), { $set: { newsletterId: target._id } });
		return null;
	},
};

const bulkUpdateCampaigns = defineAction({
	name: "bulk_update_campaigns",
	tryWithoutPlan: true,
	title: "Update several campaigns at once",
	group: "Campaigns",
	description: `Does one thing to up to ${MAX_IDS} campaigns and says what happened to each. delete discards drafts and scheduled campaigns (sent ones are skipped, and a scheduled send never goes out). unlist and list take issues off and put them back in the website's list of issues (works on sent ones). move puts drafts in another newsletter of the account, leaving their segments behind (a scheduled or sent one is skipped). tag adds, removes or replaces tags on drafts and completed issues. author chooses a guest from each issue's newsletter, or clears the byline to the default writer. Neither changes sent emails. A campaign that can't take the operation is skipped with a reason; the others still happen.`,
	http: { method: "POST", path: "/campaigns/bulk" },
	destructive: true,
	idempotent: true,
	rateLimit: { limit: 60, window: "1 h" },
	example: { ids: ["6650f1c2e9b1d4a012345678"], operation: "unlist" },
	input: z.object({
		ids: z.array(idInput("campaign")).min(1).max(MAX_IDS).describe(`The campaigns' IDs, ${MAX_IDS} at most`),
		tags: tagsInput.optional().describe("With tag: tags to add, remove or replace"),
		tagMode: z.enum(["add", "remove", "replace"]).default("replace").describe("How tag changes the tags; default replaces them"),
		authorId: z.string().max(64).nullable().optional().describe("With author: an active guest author ID in each issue newsletter, or null for the default writer"),
		operation: z.enum(OPERATIONS).describe("delete, unlist, list, move, tag or author"),
		newsletter: z.string().trim().min(1).max(100).optional().describe("With move: the newsletter's ID or slug to move them to"),
	}),
	output: z.object({
		results: z.array(ResultSchema),
		done: z.number().int(),
		skipped: z.number().int(),
	}),
	handler: async ({ account, input }) => {
		if (input.operation === "tag" && input.tags === undefined) throw (await import("@/lib/actions/errors")).actionError("validation_failed", "tags is required for tag");
		if (input.operation === "author" && input.authorId === undefined) throw (await import("@/lib/actions/errors")).actionError("validation_failed", "authorId is required for author");
		if (input.operation === "tag") input.tags = readTags(input.tags).tags;
		const ids = [...new Set(input.ids)];
		const target = input.operation === "move" ? await findNewsletter(account, input.newsletter ?? "") : null;
		const valid = ids.filter(isObjectIdString);
		const campaigns = valid.length > 0 ? await Campaign.find(scoped(account, { _id: { $in: valid }, status: { $ne: "canceled" } })).lean() : [];
		const byId = new Map(campaigns.map((campaign) => [String(campaign._id), campaign]));

		const results = [];
		for (const id of ids) {
			const campaign = byId.get(id);
			const reason = campaign ? await OPERATION_HANDLERS[input.operation](account, campaign, { target, input }) : "Campaign not found";
			results.push({ id, status: reason ? "skipped" : "done", reason: reason ?? null });
		}
		const done = results.filter(({ status }) => status === "done").length;
		if (done > 0 && input.operation !== "move") revalidateArchive();
		return { results, done, skipped: results.length - done };
	},
});

export const campaignBulkActions = [bulkUpdateCampaigns];
