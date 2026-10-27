import crypto from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter } from "@/lib/actions/shared";
import { readReplyAddress } from "@/lib/reply-address";
import { isRateLimited } from "@/lib/rate-limit";
import { normalizeEmail } from "@/lib/validation";
import Account from "@/models/Account";
import { isDeletionPending } from "@/lib/account-state";
import Message from "@/models/Message";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Reply from "@/models/Reply";
export async function ingestReply(input) {
	const id = readReplyAddress(input.to);
	const message = id && await Message.findOne({ _id: id }).setOptions({ crossAccount: true }).lean();
	if (!message?.campaignId || +new Date(message.createdAt) < Date.now() - 90 * 86400000) throw actionError("not_found", "Reply address not found");
	const account = message.accountId;
	const ownerAccount = await Account.findById(account).select({ deletion: 1 }).lean();
	if (!ownerAccount || isDeletionPending(ownerAccount)) throw actionError("not_found", "Reply address not found");
	const [newsletter, contact] = await Promise.all([Newsletter.findOne(scoped(account, { _id: message.newsletterId })).lean(), Contact.findOne(scoped(account, { _id: message.contactId, newsletterId: message.newsletterId })).lean()]);
	if (!newsletter?.replyInbox || !contact || normalizeEmail(input.from) !== contact.email) throw actionError("not_found", "Reply address not found");
	const externalId = crypto.createHash("sha256").update(`${id}:${input.externalId}`).digest("hex");
	const existing = await Reply.findOne(scoped(account, { externalId })).select({ _id: 1 }).lean();
	if (existing) return { accepted: true };
	if (await isRateLimited({ name: "reader-reply", limit: 25, window: "1 d", key: id })) throw actionError("rate_limited", "Too many replies");
	let saved;
	try { saved = await Reply.updateOne(scoped(account, { externalId }), { $setOnInsert: { newsletterId: newsletter._id, campaignId: message.campaignId, contactId: contact._id, messageId: message._id, from: contact.email, subject: input.subject.slice(0, 300), text: input.text.slice(0, 30000) } }, { upsert: true }); } catch (error) { if (error?.code !== 11000) throw error; }
	if (saved?.upsertedId) await (await import("@/lib/record-events")).emitRecordEvent("reply.received", { accountId: account, newsletterId: newsletter._id, id: saved.upsertedId, parentId: message.campaignId });
	return { accepted: true };
}
export async function listReplies(account, input) {
	const newsletter = await findNewsletter(account, input.newsletter);
	const replies = await Reply.find(scoped(account, { newsletterId: newsletter._id, archived: Boolean(input.archived), ...(input.before && { _id: { $lt: input.before } }) })).sort({ _id: -1 }).limit(50).lean();
	return { replies: replies.map((reply) => ({ id: String(reply._id), from: reply.from, subject: reply.subject, text: reply.text, campaignId: String(reply.campaignId), contactId: String(reply.contactId), archived: reply.archived, receivedAt: reply.createdAt.toISOString() })), next: replies.length === 50 ? String(replies.at(-1)._id) : null };
}
export async function archiveReply(account, input) {
	const result = await Reply.updateOne(scoped(account, { _id: input.id }), { $set: { archived: input.archived } });
	if (!result.matchedCount) throw actionError("not_found", "Reply not found");
	return { updated: true };
}
