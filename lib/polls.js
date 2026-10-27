import { emitRecordEvent } from "@/lib/record-events";
import crypto from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { enrollOnFieldsChanged } from "@/lib/automation-triggers";
import { getAppSecret } from "@/lib/config";
import { listCustomFields, parseFieldValue } from "@/lib/custom-fields";
import { connectDb } from "@/lib/db";
import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS, escapeText } from "@/lib/editor-blocks";
import { verifySubscriberToken } from "@/lib/subscriber-links";
import { addTags, removeTags } from "@/lib/tags";
import { isObjectIdString } from "@/lib/validation";
import Contact from "@/models/Contact";
import Poll from "@/models/Poll";
import PollVote from "@/models/PollVote";

// Polls in issues (models/Poll.js): votes from an email's signed links count for the subscriber, once per poll and
// changed by voting again; votes on the website count apart, one per reader's address, which is only kept as a
// keyed hash. A subscriber's answer is also kept on the contact (Contact.polls), where segments read it.

export const MAX_QUESTION_LENGTH = 200;
export const MAX_OPTION_LENGTH = 100;
export const MAX_COMMENT_LENGTH = 1000;
// Contacts that can still vote: a vote from someone who left changes nothing they get.
const VOTING_STATUSES = ["active", "pending", "dormant"];

export function pollKey(pollId) {
	return `p${String(pollId).toLowerCase()}`;
}

// The poll block for a rich campaign's content, as the editor writes it.
export function getPollBlockHtml(poll) {
	const items = poll.options.map(({ label }) => `<li>${escapeText(label)}</li>`).join("");
	return `<div data-poll="${String(poll._id)}"><p>${escapeText(poll.question)}</p><ol>${items}</ol></div>`;
}

// A problem with a poll's question and answers, or null.
export function getPollProblem({ question, options }) {
	if (!question?.trim()) return "Ask a question";
	if (!Array.isArray(options) || options.length < MIN_POLL_OPTIONS || options.length > MAX_POLL_OPTIONS) {
		return `A poll has ${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} answers`;
	}
	const labels = options.map(({ label }) => String(label ?? "").trim().toLowerCase());
	if (labels.some((label) => !label)) return "Every answer needs words";
	if (new Set(labels).size !== labels.length) return "Two answers are the same";
	return null;
}

// Votes per answer: from emails, from the website, and both.
export async function countVotes(poll) {
	const base = { accountId: poll.accountId, pollId: poll._id };
	const count = (option, isWeb) => PollVote.countDocuments({ ...base, option, ...(isWeb ? { voterKey: { $exists: true } } : { contactId: { $exists: true } }) });
	const rows = await Promise.all(poll.options.map(async (_, option) => ({ email: await count(option, false), web: await count(option, true) })));
	return rows.map((row) => ({ ...row, total: row.email + row.web }));
}

// Someone's address as a poll's web voter: the same for one poll, unrelated across polls, and not an IP address.
export function getVoterKey(pollId, ip) {
	const key = Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "flockstack-poll-voter-v1", 32));
	return crypto.createHmac("sha256", key).update(`${pollId}:${ip}`).digest("base64url").slice(0, 22);
}

// The poll a link names, whatever its account: its ID is in the link, and votes are checked against it.
export async function findPublicPoll(pollId) {
	if (!isObjectIdString(String(pollId ?? ""))) return null;
	await connectDb();
	return Poll.findOne({ _id: String(pollId).toLowerCase() }).setOptions({ crossAccount: true }).lean();
}

function readOption(poll, option) {
	const index = Number(option);
	return Number.isInteger(index) && index >= 0 && index < poll.options.length ? index : null;
}

// The custom field the poll sets, as the answer's label: only when the field takes it (text, or a list with that option).
async function getFieldSet(poll, label) {
	if (!poll.fieldKey) return {};
	const definition = (await listCustomFields({ _id: poll.accountId }, poll.newsletterId)).find(({ key }) => key === poll.fieldKey);
	if (!definition || !["text", "list"].includes(definition.type)) return {};
	const parsed = parseFieldValue(definition.type, definition.multiple ? [label] : label, definition);
	return parsed.problem || parsed.value === null ? {} : { [`fields.${definition.key}`]: parsed.value };
}

// A subscriber's vote from an email link: { poll, option, previous } once counted, or { problem } ("invalid" for a link
// that isn't one, "closed", "gone" for someone no longer subscribed). Voting again changes the answer.
export async function recordEmailVote({ pollId, option, token }) {
	const reference = verifySubscriberToken("poll", token);
	if (!reference) return { problem: "invalid" };
	const poll = await findPublicPoll(pollId);
	const index = poll && readOption(poll, option);
	if (!poll || index === null || String(poll.newsletterId) !== reference.newsletterId) return { problem: "invalid" };
	if (poll.closed) return { poll, problem: "closed" };
	const account = { _id: poll.accountId };
	const contact = await Contact.findOne(scoped(account, { _id: reference.contactId, newsletterId: poll.newsletterId })).lean();
	if (!contact || !VOTING_STATUSES.includes(contact.status)) return { poll, problem: "gone" };

	const before = await PollVote.findOneAndUpdate(
		scoped(account, { pollId: poll._id, contactId: contact._id }),
		{ $set: { option: index, newsletterId: poll.newsletterId } },
		{ upsert: true, returnDocument: "before" }
	).lean();
	const previous = before?.option ?? null;
	if (previous !== index) {
		const set = { [`polls.${pollKey(poll._id)}`]: index, ...(await getFieldSet(poll, poll.options[index].label)) };
		await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: set });
		await enrollOnFieldsChanged(contact, Object.keys(set).filter((path) => path.startsWith("fields.")).map((path) => path.slice("fields.".length)));
		const oldTag = previous === null ? null : poll.options[previous]?.tag;
		const newTag = poll.options[index].tag;
		if (oldTag && oldTag !== newTag) await removeTags(account, contact, [oldTag]).catch(logTagFailure);
		if (newTag) await addTags(account, contact, [newTag]).catch(logTagFailure);
		const vote = before ?? await PollVote.findOne(scoped(account, { pollId: poll._id, contactId: contact._id })).select({ _id: 1 }).lean();
		if (vote) await emitRecordEvent("poll.voted", { accountId: poll.accountId, newsletterId: poll.newsletterId, id: vote._id, parentId: poll._id });
	}
	return { poll, option: index, previous, contactId: String(contact._id) };
}

function logTagFailure(error) {
	console.error("[polls] Could not change the voter's tags:", error.message);
}

// A website reader's vote, counted apart from subscribers'. { poll, option } or { problem }.
export async function recordWebVote({ pollId, option, ip }) {
	const poll = await findPublicPoll(pollId);
	const index = poll && readOption(poll, option);
	if (!poll || index === null) return { problem: "invalid" };
	if (poll.closed) return { poll, problem: "closed" };
	const before = await PollVote.findOneAndUpdate(
		scoped(poll.accountId, { pollId: poll._id, voterKey: getVoterKey(poll._id, ip) }),
		{ $set: { option: index, newsletterId: poll.newsletterId } },
		{ upsert: true, returnDocument: "before" }
	).lean();
	if (before?.option !== index) {
		const vote = before ?? await PollVote.findOne(scoped(poll.accountId, { pollId: poll._id, voterKey: getVoterKey(poll._id, ip) })).select({ _id: 1 }).lean();
		if (vote) await emitRecordEvent("poll.voted", { accountId: poll.accountId, newsletterId: poll.newsletterId, id: vote._id, parentId: poll._id });
	}
	return { poll, option: index };
}

// The vote a reader already gave: a subscriber's by their token, a web reader's by their address.
export async function findVote(poll, { token, ip }) {
	const reference = token ? verifySubscriberToken("poll", token) : null;
	if (token && (!reference || reference.newsletterId !== String(poll.newsletterId))) return null;
	const who = reference ? { contactId: reference.contactId } : { voterKey: getVoterKey(poll._id, ip) };
	return PollVote.findOne(scoped(poll.accountId, { pollId: poll._id, ...who })).lean();
}

// The answer to the follow-up question, on the reader's own vote.
export async function saveFollowUp(poll, { token, ip, comment }) {
	const text = String(comment ?? "").trim().slice(0, MAX_COMMENT_LENGTH);
	if (!poll.followUp || !text) return false;
	const vote = await findVote(poll, { token, ip });
	if (!vote) return false;
	await PollVote.updateOne(scoped(poll.accountId, { _id: vote._id }), { $set: { comment: text } });
	return true;
}

// Takes a poll and every answer to it away, the contacts' copies included.
export async function deletePollVotes(account, poll) {
	const path = `polls.${pollKey(poll._id)}`;
	await Contact.updateMany(scoped(account, { newsletterId: poll.newsletterId, [path]: { $exists: true } }), { $unset: { [path]: 1 } });
	await PollVote.deleteMany(scoped(account, { pollId: poll._id }));
}
