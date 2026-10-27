import "server-only";
// Configuration events carry references, never private perk codes, authored bodies or survey answers.
export async function emitRecordEvent(type, { accountId, newsletterId, id, parentId }) {
	return (await import("@/lib/webhooks")).emitWebhookEvent({ accountId, newsletterId, type, data: { id: String(id), newsletterId: String(newsletterId), ...(parentId && { parentId: String(parentId) }) } });
}
