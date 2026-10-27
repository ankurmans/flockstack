import "server-only";
import { emitWebhookEvent } from "@/lib/webhooks";

// Calendar events carry identifiers and editorial state. Private copy, notes, references and media addresses stay in the API.
export function emitContentEvent(type, item) {
	return emitWebhookEvent({ accountId: item.accountId, newsletterId: item.newsletterId, type, data: {
		item: { id: String(item._id), newsletterId: String(item.newsletterId), channel: item.channel, state: item.state, version: item.contentVersion ?? 1,
			plannedDate: item.plannedDate ?? null, plannedTime: item.plannedTime ?? null, timeZone: item.timeZone ?? null,
			campaignId: item.campaignId ? String(item.campaignId) : null, batchId: item.batchId ? String(item.batchId) : null },
	} });
}
export function emitBatchEvent(type, batch) {
	return emitWebhookEvent({ accountId: batch.accountId, newsletterId: batch.newsletterId, type, data: { batch: { id: String(batch._id), newsletterId: String(batch.newsletterId), status: batch.status ?? "active" } } });
}
export function emitPlanChanged(account, newsletterId, reason) {
	return emitWebhookEvent({ accountId: account._id, newsletterId, type: "content_plan.changed", data: { newsletterId: String(newsletterId), reason } });
}
