import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, idInput } from "@/lib/actions/shared";
import { renderWebIssue } from "@/lib/web-issue";
import { splitAtPaywall } from "@/lib/editor-blocks";
import { markdownToHtml } from "@/lib/markdown";
import { fillMergeTags } from "@/lib/merge-tags";
import { makeTeaser } from "@/lib/paywall";
import { escapeHtml, htmlToText, renderEmail } from "@/lib/render-email";
import { isInPaidTiers, isPaidContact } from "@/lib/tiers";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";

const previewAsReader = defineAction({
	name: "preview_campaign_as_reader", title: "Preview an issue as a reader", group: "Campaigns", readOnly: true,
	description: "Renders a saved issue using one subscriber's fields and current paid-tier access, or a synthetic free/paid reader. The contact must belong to the same newsletter. Returns HTML for a sandboxed preview, never sends and never creates reader sign-in, unsubscribe or billing capabilities. Built-in account links are inert preview anchors. A draft may be previewed too; this does not say the contact is in the send's segment audience.",
	http: { method: "POST", path: "/campaigns/{id}/preview" }, rateLimit: { limit: 60, window: "1 h" },
	input: z.object({ id: idInput("campaign"), contactId: idInput("subscriber").optional(), email: z.string().trim().email().max(254).optional().describe("Subscriber email instead of contactId, within this issue newsletter"), tier: z.enum(["free", "paid"]).optional().describe("A synthetic reader when no contactId is supplied; default free"), mode: z.enum(["email", "web"]).default("email").describe("Which saved version to render") }),
	output: z.object({ campaignId: z.string(), contactId: z.string().nullable(), mode: z.string(), paidAccess: z.boolean(), subject: z.string(), previewText: z.string(), html: z.string(), text: z.string() }),
	handler: async ({ account, input }) => {
		if (!isObjectIdString(input.id)) throw actionError("not_found", "Campaign not found");
		const campaign = await Campaign.findOne(scoped(account, { _id: input.id, status: { $ne: "canceled" } })).lean();
		if (!campaign) throw actionError("not_found", "Campaign not found");
		if ((input.contactId || input.email) && input.tier) throw actionError("validation_failed", "Choose a subscriber or a synthetic tier, not both");
		if (input.contactId && input.email) throw actionError("validation_failed", "Choose contactId or email");
		if (input.contactId && !isObjectIdString(input.contactId)) throw actionError("not_found", "Subscriber not found");
		const newsletter = await findNewsletter(account, String(campaign.newsletterId));
		const contact = input.contactId || input.email ? await Contact.findOne(scoped(account, { ...(input.email ? { email: input.email.toLowerCase() } : { _id: input.contactId }), newsletterId: campaign.newsletterId })).lean() : null;
		if ((input.contactId || input.email) && !contact) throw actionError("not_found", "Subscriber not found in this newsletter");
		const paidAccess = input.mode === "web" && contact ? (await (await import("@/lib/metered-reading")).readerIssueEntitlement(newsletter, campaign, contact)).canReadFull : contact ? contact.status === "active" && isPaidContact(contact) && (campaign.audience !== "paid" || isInPaidTiers(contact, campaign.audienceTiers)) : input.tier === "paid";
		let source = campaign;
		if (campaign.audience === "paid" && !paidAccess) source = { ...campaign, format: "rich", html: makeTeaser(campaign) };
		else if (!paidAccess && campaign.format === "html") source = { ...campaign, html: splitAtPaywall(campaign.html ?? "").before };
		else if (!paidAccess && campaign.format === "markdown") source = { ...campaign, format: "rich", html: splitAtPaywall(markdownToHtml(campaign.markdown ?? "")).before };
		const subject = fillMergeTags(campaign.subject ?? "", contact);
		const previewText = fillMergeTags(campaign.previewText ?? "", contact);
		if (input.mode === "web") {
			const { html } = renderWebIssue({ newsletter, issue: source, recommendations: [], isUnlocked: paidAccess, reader: contact, readerTier: contact ? (isPaidContact(contact) ? "paid" : paidAccess ? "metered" : "free") : input.tier === "paid" ? "paid" : "free" });
			return { campaignId: input.id, contactId: contact ? String(contact._id) : null, mode: input.mode, paidAccess, subject, previewText, html, text: htmlToText(html) };
		}
		const rendered = renderEmail({ ...source, newsletter, subject, previewText, readerTier: paidAccess ? "paid" : "free", readerTierId: contact ? (await import("@/lib/tier-rules")).getContactTierId(contact) : null, unsubscribeUrl: "#preview-unsubscribe", preferencesUrl: "#preview-preferences", upgradeUrl: "#preview-upgrade" });
		return { campaignId: input.id, contactId: contact ? String(contact._id) : null, mode: input.mode, paidAccess, subject, previewText, html: fillMergeTags(rendered.html, contact, { escape: escapeHtml }), text: fillMergeTags(rendered.text, contact) };
	},
});
export const campaignPreviewActions = [previewAsReader];
