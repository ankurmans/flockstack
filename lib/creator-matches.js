import "server-only";
import { createHash } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { ACCESS_FIELDS, hasActiveSubscription, isBlocked, isDeletionPending } from "@/lib/account-state";
import { findOwnerEmail } from "@/lib/accounts";
import { actionError } from "@/lib/actions/errors";
import { toIso } from "@/lib/actions/shared";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { MATCH_WINDOW, normalizeTopics, rankCreator } from "@/lib/creator-match-rules";
import { connectDb } from "@/lib/db";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import { isRateLimited } from "@/lib/rate-limit";
import { getSubscriberRange } from "@/lib/recommendation-rules";
import { eligibleCreatorNewsletters } from "@/lib/recommendations";
import { isObjectIdString } from "@/lib/validation";
import { emitWebhookEvent } from "@/lib/webhooks";
import Account from "@/models/Account";
import Alert from "@/models/Alert";
import Contact from "@/models/Contact";
import CreatorConversation from "@/models/CreatorConversation";
import CreatorMessage from "@/models/CreatorMessage";
import Newsletter from "@/models/Newsletter";
import Recommendation from "@/models/Recommendation";

const FIELDS = "accountId name slug description imageUrl language creatorMatch recommendations archiveEnabled archiveHost fromEmail replyTo requireConfirmation sharedSender";
const notFound = () => actionError("not_found", "Conversation not found");
const unavailable = () => actionError("validation_failed", "This creator cannot receive introductions right now");
export function creatorProfile(newsletter) {
	return { enabled: newsletter.creatorMatch?.enabled === true, topics: newsletter.creatorMatch?.topics ?? [], emailNotifications: newsletter.creatorMatch?.emailNotifications === true };
}

export async function saveCreatorProfile(newsletter, input) {
	const next = { ...creatorProfile(newsletter), ...input };
	delete next.newsletter;
	const topics = normalizeTopics(next.topics);
	if (!topics) throw actionError("validation_failed", "Choose up to 10 topics of 2 to 30 letters or numbers each");
	if (next.enabled && (!(await eligibleCreatorNewsletters([{ ...newsletter, creatorMatch: { ...next, topics } }])).length || topics.length === 0)) {
		throw actionError("validation_failed", "First list this newsletter in recommendations, enable confirmed signups and its website, publish an issue and verify its sender. Choose at least one topic.");
	}
	await Newsletter.updateOne(scoped(newsletter.accountId, { _id: newsletter._id }), { $set: { creatorMatch: { ...next, topics } } });
	return { ...next, topics };
}

async function publicCards(newsletters) {
	if (!newsletters.length) return [];
	const counts = await Promise.all(newsletters.map((item) => Contact.countDocuments(scoped(item.accountId, { newsletterId: item._id, status: "active" }))));
	return newsletters.map((item, index) => ({
		id: String(item._id), slug: item.slug, name: item.name, description: item.description || "", imageUrl: item.imageUrl || null,
		url: getArchiveUrls(item).siteIndex, language: item.language || "en", topics: creatorProfile(item).topics,
		subscriberRange: getSubscriberRange(counts[index]),
	}));
}

export async function getCreatorMatches(newsletter) {
	await connectDb();
	const candidates = await Newsletter.find({ "creatorMatch.enabled": true, "recommendations.listed": true, archiveEnabled: true, accountId: { $ne: newsletter.accountId } })
		.setOptions({ crossAccount: true }).select(FIELDS).sort({ _id: 1 }).limit(MATCH_WINDOW + 1).lean();
	const eligible = await eligibleCreatorNewsletters([newsletter, ...candidates.slice(0, MATCH_WINDOW)]);
	if (!eligible.some((item) => String(item._id) === String(newsletter._id))) return { matches: [], limited: false, enabled: false };
	const cards = await publicCards(eligible);
	const source = cards.find((item) => item.id === String(newsletter._id));
	const owned = await Recommendation.find(scoped(newsletter.accountId, { recommenderId: newsletter._id })).select("recommendedId stats status").lean();
	const history = new Map(owned.map((item) => [String(item.recommendedId), item]));
	const matches = cards.filter((item) => item.id !== source.id).map((item) => {
		const prior = history.get(item.id);
		return { ...item, ...rankCreator(source, item, prior), recommendation: prior ? { status: prior.status, impressions: prior.stats?.impressions ?? 0, signups: prior.stats?.signups ?? 0, confirmed: prior.stats?.confirmed ?? 0 } : null };
	}).sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug)).slice(0, 50);
	return { matches, limited: candidates.length > MATCH_WINDOW || cards.length > 51, enabled: true };
}

export function conversationOutput(row) {
	return { id: String(row._id), newsletterId: String(row.newsletterId), otherNewsletterId: String(row.otherNewsletterId), otherName: row.otherName, closed: row.closed === true, lastMessageAt: toIso(row.lastMessageAt) };
}
const messageOutput = (row) => ({ id: String(row._id), direction: row.direction, fromName: row.fromName, body: row.body, createdAt: toIso(row.createdAt) });

export async function findCreatorConversation(account, id) {
	if (!isObjectIdString(id)) throw notFound();
	const row = await CreatorConversation.findOne(scoped(account, { _id: id })).lean();
	if (!row) throw notFound();
	return row;
}

export async function readCreatorConversation(row, before) {
	if (before && !isObjectIdString(before)) throw actionError("validation_failed", "Invalid message cursor");
	const messages = await CreatorMessage.find(scoped(row.accountId, { conversationId: row._id, ...(before && { _id: { $lt: before } }) })).sort({ _id: -1 }).limit(51).lean();
	return { conversation: conversationOutput(row), messages: messages.slice(0, 50).map(messageOutput).reverse(), before: messages.length > 50 ? String(messages[49]._id) : null };
}

async function pairConversation(source, other) {
	const filter = scoped(source.accountId, { newsletterId: source._id, otherNewsletterId: other._id });
	try {
		return await CreatorConversation.findOneAndUpdate(filter, { $setOnInsert: { otherName: other.name } }, { upsert: true, new: true }).lean();
	} catch (error) {
		if (error?.code !== 11000) throw error;
		return CreatorConversation.findOne(filter).lean();
	}
}

async function notifyCreator(recipient, message, conversation) {
	if (!recipient.creatorMatch?.emailNotifications || !isSendingEnabled() || !canSendPlatformEmail()) return;
	try {
		const claim = await CreatorMessage.updateOne(scoped(recipient.accountId, { _id: message._id, notificationAttemptedAt: null }), { $set: { notificationAttemptedAt: new Date() } });
		if (!claim.modifiedCount) return;
		const now = new Date();
		try {
			await Alert.updateOne({ accountId: recipient.accountId, key: `creator-intro:${conversation._id}`, $or: [{ lastSentAt: null }, { lastSentAt: { $lt: new Date(now.getTime() - 3600000) } }] }, { $set: { title: "Creator introduction", lastSentAt: now } }, { upsert: true });
		} catch (error) { if (error?.code === 11000) return; throw error; }
		const to = await findOwnerEmail(recipient.accountId);
		if (to) await sendPlatformEmail({ to, subject: "[FlockStack] A creator sent you a message", text: `${message.fromName} wrote:\n\n${message.body}\n\nReply in FlockStack: ${getAppUrl()}/recommending/creators/${conversation._id}\n\nPrivate account email addresses are not shared. You can close this conversation or turn off these emails in FlockStack.` });
	} catch { console.error("[creator-intro] Email notification failed; the message is available in the inbox"); }
}

async function finishAccepted(message) {
	const target = await Newsletter.findOne({ _id: message.toNewsletterId }).setOptions({ crossAccount: true }).select(FIELDS).lean();
	const copy = target && await CreatorMessage.findOne(scoped(target.accountId, { newsletterId: target._id, messageKey: message.messageKey })).lean();
	// A retry repairs inbox ordering after an interrupted request, but never recreates a deleted account's copy.
	await Promise.all([message, copy].filter(Boolean).map((item) => CreatorConversation.updateOne(scoped(item.accountId, { _id: item.conversationId }), { $max: { lastMessageAt: item.createdAt } })));
	for (const item of [message, copy].filter(Boolean)) {
		const claim = await CreatorMessage.updateOne(scoped(item.accountId, { _id: item._id, webhookAttemptedAt: null }), { $set: { webhookAttemptedAt: new Date() } });
		if (claim.modifiedCount) await emitWebhookEvent({ accountId: item.accountId, newsletterId: item.newsletterId, type: "creator_message.created", data: { id: String(item._id), newsletterId: String(item.newsletterId), parentId: String(item.conversationId) } });
	}
	if (copy) {
		const account = await Account.findById(target.accountId).select({ ...ACCESS_FIELDS, status: 1 }).lean();
		if (account && !isBlocked(account) && !isDeletionPending(account) && hasActiveSubscription(account)) await notifyCreator(target, copy, { _id: copy.conversationId });
	}
	return { conversationId: String(message.conversationId), messageId: String(message._id), accepted: true };
}

export async function sendCreatorMessage({ newsletter, to, body, externalId, reply = false }) {
	await connectDb();
	const messageKey = createHash("sha256").update(`${newsletter._id}:${externalId}`).digest("hex");
	const text = body.trim();
	if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw actionError("validation_failed", "Write a message of 1 to 2,000 characters");
	const previous = await CreatorMessage.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, messageKey })).lean();
	if (previous) {
		if (previous.body !== text || String(previous.toNewsletterId) !== String(to)) throw actionError("conflict", "This externalId was already used for different words or a different recipient");
		return finishAccepted(previous);
	}
	const target = isObjectIdString(to) && await Newsletter.findOne({ _id: to }).setOptions({ crossAccount: true }).select(FIELDS).lean();
	if (!target || String(target.accountId) === String(newsletter.accountId)) throw unavailable();
	const accounts = await Account.find({ _id: { $in: [newsletter.accountId, target.accountId] } }).select({ ...ACCESS_FIELDS, status: 1 }).lean();
	if (accounts.length !== 2 || accounts.some((account) => isBlocked(account) || isDeletionPending(account) || !hasActiveSubscription(account))) throw unavailable();
	const mine = await CreatorConversation.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, otherNewsletterId: target._id })).lean();
	if (reply && !mine?.lastMessageAt) throw actionError("validation_failed", "Start a new introduction first");
	if (!reply && (await eligibleCreatorNewsletters([newsletter, target])).length !== 2) throw unavailable();
	const [senderConversation, recipientConversation] = await Promise.all([pairConversation(newsletter, target), pairConversation(target, newsletter)]);
	if (senderConversation.closed || recipientConversation.closed) throw actionError("validation_failed", "This conversation is closed");
	if (await isRateLimited({ name: reply ? "creator-replies" : "creator-introductions", key: String(newsletter.accountId), limit: reply ? 30 : 3, window: reply ? "1 h" : "1 d" })) throw actionError("rate_limited", reply ? "Wait before sending another reply" : "You can start three introductions a day");
	const common = { messageKey, fromNewsletterId: newsletter._id, toNewsletterId: target._id, fromName: newsletter.name, body: text };
	let copies;
	try {
		copies = await CreatorMessage.create([
			{ ...common, accountId: newsletter.accountId, newsletterId: newsletter._id, conversationId: senderConversation._id, direction: "outgoing" },
			{ ...common, accountId: target.accountId, newsletterId: target._id, conversationId: recipientConversation._id, direction: "incoming" },
		]);
	} catch (error) {
		if (error?.code !== 11000) throw error;
		const saved = await CreatorMessage.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, messageKey })).lean();
		if (!saved || saved.body !== text || String(saved.toNewsletterId) !== String(to)) throw actionError("conflict", "This externalId was already used");
		return finishAccepted(saved);
	}
	return finishAccepted(copies[0]);
}
