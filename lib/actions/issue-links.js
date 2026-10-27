import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { findNewsletter, idInput, newsletterInput } from "@/lib/actions/shared";
import { findCampaign } from "@/lib/actions/campaigns";
import { getIssueLinks } from "@/lib/issue-links";
import { readIssueLinkRefs } from "@/lib/issue-link-rules";
import Campaign from "@/models/Campaign";
const link = z.object({ id: z.string(), title: z.string(), status: z.string(), url: z.string().nullable() });
export const issueLinkActions = [
	defineAction({ name: "get_issue_links", title: "Get an issue's internal links", group: "Campaigns", readOnly: true, description: "Incoming and outgoing issue links inserted with [[ in the editor. Each target and source belongs to the same account and newsletter, and the recorded href must match its current public page. Up to 100 outgoing references and 50 incoming candidates. Older issues need index_issue_links before incoming links are complete; unindexedIssues says how many. This is an owner view, never a public backlinks list.", http: { method: "GET", path: "/campaigns/{id}/internal-links" }, input: z.object({ id: idInput("campaign") }), output: z.object({ incoming: z.array(link), outgoing: z.array(link), hasMoreIncoming: z.boolean(), unindexedIssues: z.number().int() }), handler: async ({ account, input }) => { const campaign = await findCampaign(account, input.id); return getIssueLinks(account, await findNewsletter(account, String(campaign.newsletterId)), campaign); } }),
	defineAction({ name: "index_issue_links", title: "Index existing issue links", group: "Campaigns", idempotent: true, description: "Indexes internal link references on up to 10 existing issues in one newsletter, in ID order. Pass the returned next ID as after to continue; null means this pass is complete. Only metadata changes: copy, audience, scheduling, sending and publication are unchanged. New saves maintain this metadata automatically. A concurrent content edit is skipped and counted; run another pass for skipped records.", http: { method: "POST", path: "/campaigns/internal-links/index" }, input: z.object({ newsletter: newsletterInput, after: z.string().regex(/^[a-f0-9]{24}$/).optional().describe("Next ID from the preceding batch; omit to start") }), output: z.object({ indexed: z.number().int(), skipped: z.number().int(), next: z.string().nullable() }), handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const records = await Campaign.find(scoped(account, { newsletterId: newsletter._id, ...(input.after && { _id: { $gt: input.after } }) })).sort({ _id: 1 }).limit(11).select("html updatedAt").lean();
		let indexed = 0, skipped = 0;
		for (const issue of records.slice(0, 10)) { const saved = await Campaign.updateOne(scoped(account, { _id: issue._id, newsletterId: newsletter._id, updatedAt: issue.updatedAt }), { $set: { internalLinks: readIssueLinkRefs(issue.html), internalLinkIds: readIssueLinkRefs(issue.html).map(({ id }) => id) } }); if (saved.matchedCount) indexed++; else skipped++; }
		return { indexed, skipped, next: records.length > 10 ? String(records[9]._id) : null };
	} }),
];
