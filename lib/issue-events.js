import "server-only";
import { emitRecordEvent } from "@/lib/record-events";

// A web publication is distinct from completed email delivery. Call only after its first successful publish write.
export async function emitIssuePublished(campaign, newsletter) {
	if (!newsletter?.archiveEnabled || campaign.publishTo === "email" || campaign.resend?.of) return 0;
	return emitRecordEvent("issue.published", { accountId: campaign.accountId, newsletterId: campaign.newsletterId, id: campaign._id });
}
