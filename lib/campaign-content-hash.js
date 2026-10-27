import { createHash } from "node:crypto";
export function campaignContentHash(campaign) {
	return createHash("sha256").update(JSON.stringify([campaign.format ?? "rich", campaign.subject ?? "", campaign.previewText ?? "", campaign.html ?? "", campaign.markdown ?? "", campaign.editorResetId ?? null])).digest("hex");
}
export function campaignContentCondition(campaign) {
	return Object.fromEntries(["format", "subject", "previewText", "html", "markdown", "editorResetId"].map(key => [key, campaign[key] === undefined ? { $exists: false } : campaign[key]]));
}
