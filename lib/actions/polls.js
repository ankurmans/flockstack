import { emitRecordEvent } from "@/lib/record-events";
import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { listCustomFields } from "@/lib/custom-fields";
import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS, findElements } from "@/lib/editor-blocks";
import {
	MAX_OPTION_LENGTH,
	MAX_QUESTION_LENGTH,
	countVotes,
	deletePollVotes,
	getPollBlockHtml,
	getPollProblem,
} from "@/lib/polls";
import { normalizeTag } from "@/lib/tag-rules";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import Poll from "@/models/Poll";
import PollVote from "@/models/PollVote";

export const GROUP = "Polls and surveys";
const pollId = idInput("poll");
const EDITABLE_CAMPAIGN_STATUSES = ["draft", "scheduled"];
const VOTERS_PAGE = 100;

const optionsInput = z
	.array(
		z.object({
			label: z.string().trim().min(1).max(MAX_OPTION_LENGTH).describe("The answer as readers see it"),
			tag: z.string().trim().max(60).optional().describe("A tag a subscriber who picks this answer gets, and loses if they change it"),
		})
	)
	.min(MIN_POLL_OPTIONS)
	.max(MAX_POLL_OPTIONS)
	.describe(`${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} answers`);
const settingsShape = {
	fieldKey: z
		.string()
		.trim()
		.max(30)
		.nullable()
		.optional()
		.describe("A custom field (text, or a list with these answers as options) set to the answer's label when a subscriber votes. null for none."),
	showResults: z.boolean().optional().describe("The thank-you page shows the results so far. Default: true."),
	followUp: z
		.string()
		.trim()
		.max(MAX_QUESTION_LENGTH)
		.nullable()
		.optional()
		.describe("A question the thank-you page asks after the vote, answered in free text (list_poll_voters has the answers). null for none."),
};

const VotesSchema = z.object({
	email: z.number().int().describe("Subscribers' votes from emails"),
	web: z.number().int().describe("Votes on the website, one per reader's address, counted apart"),
	total: z.number().int(),
});
const PollSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	campaignId: z.string().nullable().describe("The issue it was made in"),
	question: z.string(),
	options: z.array(z.object({ label: z.string(), tag: z.string().nullable(), votes: VotesSchema })),
	votes: VotesSchema.describe("All answers"),
	fieldKey: z.string().nullable(),
	showResults: z.boolean(),
	followUp: z.string().nullable(),
	closed: z.boolean().describe("Votes are no longer taken"),
	html: z.string().describe("The poll block for a rich campaign's content. Each subscriber's email gets vote links of their own."),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});

async function toPoll(poll) {
	const counts = await countVotes(poll);
	const sum = (key) => counts.reduce((total, row) => total + row[key], 0);
	return {
		id: String(poll._id),
		newsletterId: String(poll.newsletterId),
		campaignId: poll.campaignId ? String(poll.campaignId) : null,
		question: poll.question,
		options: poll.options.map(({ label, tag }, index) => ({ label, tag: tag || null, votes: counts[index] })),
		votes: { email: sum("email"), web: sum("web"), total: sum("total") },
		fieldKey: poll.fieldKey || null,
		showResults: poll.showResults !== false,
		followUp: poll.followUp || null,
		closed: Boolean(poll.closed),
		html: getPollBlockHtml(poll),
		createdAt: toIso(poll.createdAt),
		updatedAt: toIso(poll.updatedAt),
	};
}

async function findPoll(account, id) {
	const value = String(id ?? "").trim().toLowerCase();
	const poll = isObjectIdString(value) ? await Poll.findOne(scoped(account, { _id: value })).lean() : null;
	if (!poll) throw actionError("not_found", "Poll not found");
	return poll;
}

function toOptions(options) {
	return options.map(({ label, tag }) => {
		const normalized = tag ? normalizeTag(tag) : null;
		if (tag && !normalized) throw actionError("validation_failed", `options: ${tag} isn't a tag: letters, digits, spaces and - _ . : / + &`);
		return { label: label.trim(), ...(normalized && { tag: normalized }) };
	});
}

async function checkField(account, newsletterId, fieldKey) {
	if (!fieldKey) return;
	const field = (await listCustomFields(account, newsletterId)).find(({ key }) => key === fieldKey.toLowerCase());
	if (!field) throw actionError("validation_failed", `fieldKey: the newsletter has no custom field ${fieldKey}`);
	if (!["text", "list"].includes(field.type)) throw actionError("validation_failed", "fieldKey: a poll sets a text or list field");
}

function readSettings(input) {
	const set = {};
	const unset = {};
	if (input.fieldKey !== undefined) (input.fieldKey ? set : unset).fieldKey = input.fieldKey ? input.fieldKey.toLowerCase() : 1;
	if (input.followUp !== undefined) (input.followUp ? set : unset).followUp = input.followUp || 1;
	if (input.showResults !== undefined) set.showResults = input.showResults;
	return { set, unset };
}

// A draft that has the poll's block gets its new question and answers too, so the editor and the email agree.
async function updateCampaignBlocks(account, poll) {
	if (!poll.campaignId) return;
	const campaign = await Campaign.findOne(scoped(account, { _id: poll.campaignId, status: { $in: EDITABLE_CAMPAIGN_STATUSES } }))
		.select({ html: 1, format: 1 })
		.lean();
	if (!campaign || campaign.format !== "rich" || !campaign.html) return;
	const id = String(poll._id);
	const blocks = findElements(campaign.html, (tag, name) => name === "div" && new RegExp(`\\sdata-poll="${id}"`, "i").test(tag));
	if (blocks.length === 0) return;
	let html = "";
	let cursor = 0;
	for (const block of blocks) {
		html += campaign.html.slice(cursor, block.start) + getPollBlockHtml(poll);
		cursor = block.end;
	}
	await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: { html: html + campaign.html.slice(cursor) } });
}

const listPolls = defineAction({
	name: "list_polls",
	tryWithoutPlan: true,
	title: "List polls",
	group: GROUP,
	description: "Lists a newsletter's polls, newest first, each with its votes per answer: from subscribers' emails and from the website, counted apart.",
	http: { method: "GET", path: "/polls" },
	readOnly: true,
	input: z.object({
		newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter."),
		campaign: z.string().trim().max(100).optional().describe("Only the polls made in this campaign: its ID"),
	}),
	output: z.object({ polls: z.array(PollSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const byCampaign = input.campaign && isObjectIdString(input.campaign) ? { campaignId: input.campaign.toLowerCase() } : {};
		const polls = await Poll.find(scoped(account, { newsletterId: newsletter._id, ...byCampaign })).sort({ createdAt: -1, _id: -1 }).limit(200).lean();
		return { polls: await Promise.all(polls.map(toPoll)) };
	},
});

const getPoll = defineAction({
	name: "get_poll",
	tryWithoutPlan: true,
	title: "Get a poll",
	group: GROUP,
	description: "Gets a poll with its results: votes per answer from subscribers' emails and from the website. list_poll_voters says who picked what.",
	http: { method: "GET", path: "/polls/{id}" },
	readOnly: true,
	input: z.object({ id: pollId }),
	output: PollSchema,
	handler: async ({ account, input }) => toPoll(await findPoll(account, input.id)),
});

const createPoll = defineAction({
	name: "create_poll",
	tryWithoutPlan: true,
	title: "Create a poll",
	group: GROUP,
	description: `Creates a poll with ${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} answers. Put its html in a rich campaign's content: each subscriber's email gets one-click vote links that record one vote per subscriber (voting again changes it), can set a custom field or give a tag, and land on a thank-you page with the results. Website readers vote on the same page, counted apart.`,
	http: { method: "POST", path: "/polls", status: 201 },
	rateLimit: { limit: 120, window: "1 h" },
	example: { question: "What should the next issue cover?", options: [{ label: "Tools" }, { label: "Interviews" }] },
	input: z.object({
		newsletter: newsletterInput,
		campaign: z.string().trim().max(100).optional().describe("The campaign it's for: its ID"),
		question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH).describe("The question"),
		options: optionsInput,
		...settingsShape,
	}),
	output: PollSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const options = toOptions(input.options);
		const problem = getPollProblem({ question: input.question, options });
		if (problem) throw actionError("validation_failed", problem);
		await checkField(account, newsletter._id, input.fieldKey);
		let campaignId;
		if (input.campaign) {
			const campaign = isObjectIdString(input.campaign) ? await Campaign.exists(scoped(account, { _id: input.campaign.toLowerCase(), newsletterId: newsletter._id })) : null;
			if (!campaign) throw actionError("not_found", "Campaign not found");
			campaignId = campaign._id;
		}
		const { set } = readSettings(input);
		const poll = await Poll.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			...(campaignId && { campaignId }),
			question: input.question,
			options,
			...set,
		});
		await emitRecordEvent("poll.created", { accountId: account._id, newsletterId: newsletter._id, id: poll._id });
		return toPoll(poll.toObject());
	},
});

const updatePoll = defineAction({
	name: "update_poll",
	tryWithoutPlan: true,
	title: "Update a poll",
	group: GROUP,
	description:
		"Changes a poll's question, answers or settings, or closes it to votes. Once it has votes, its answers can be reworded but not added or taken away. A draft campaign with its block gets the new wording; a sent issue keeps what it showed.",
	http: { method: "PATCH", path: "/polls/{id}" },
	idempotent: true,
	example: { closed: true },
	input: z.object({
		id: pollId,
		question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH).optional().describe("The question"),
		options: optionsInput.optional(),
		closed: z.boolean().optional().describe("Stop taking votes, or take them again"),
		...settingsShape,
	}),
	output: PollSchema,
	handler: async ({ account, input }) => {
		const poll = await findPoll(account, input.id);
		const options = input.options ? toOptions(input.options) : poll.options;
		const question = input.question ?? poll.question;
		const problem = getPollProblem({ question, options });
		if (problem) throw actionError("validation_failed", problem);
		if (options.length !== poll.options.length && (await PollVote.exists(scoped(account, { pollId: poll._id })))) {
			throw actionError("conflict", "This poll has votes: its answers can be reworded but not added or taken away");
		}
		await checkField(account, poll.newsletterId, input.fieldKey);
		const { set, unset } = readSettings(input);
		Object.assign(set, { question, options }, input.closed !== undefined && { closed: input.closed });
		await Poll.updateOne(scoped(account, { _id: poll._id }), { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) });
		const updated = await findPoll(account, poll._id);
		await updateCampaignBlocks(account, updated);
		revalidateArchive();
		await emitRecordEvent("poll.updated", { accountId: account._id, newsletterId: poll.newsletterId, id: poll._id });
		return toPoll(updated);
	},
});

const deletePoll = defineAction({
	name: "delete_poll",
	tryWithoutPlan: true,
	title: "Delete a poll",
	group: GROUP,
	description:
		"Deletes a poll and every vote and answer to its follow-up. It can't be undone. Issues that have its block keep it, and its links say the poll is gone; tags and field values it gave stay on the contacts, and segments on its answers match nobody.",
	http: { method: "DELETE", path: "/polls/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: pollId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const poll = await findPoll(account, input.id);
		await deletePollVotes(account, poll);
		await Poll.deleteOne(scoped(account, { _id: poll._id }));
		revalidateArchive();
		await emitRecordEvent("poll.deleted", { accountId: account._id, newsletterId: poll.newsletterId, id: poll._id });
		return { id: String(poll._id), deleted: true };
	},
});

const listPollVoters = defineAction({
	name: "list_poll_voters",
	tryWithoutPlan: true,
	title: "List a poll's voters",
	group: GROUP,
	description: `Lists the subscribers who voted in a poll from an email, ${VOTERS_PAGE} a page, with their answer and what they wrote to the follow-up question. Pass option for the ones who picked that answer (0 for the first). Website votes are anonymous and not listed. Pass nextCursor back as cursor for the next page.`,
	http: { method: "GET", path: "/polls/{id}/voters" },
	readOnly: true,
	input: z.object({
		id: pollId,
		option: z.coerce.number().int().min(0).max(MAX_POLL_OPTIONS - 1).optional().describe("Only who picked this answer: 0 for the first"),
		cursor: z.string().max(100).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		voters: z.array(
			z.object({
				contactId: z.string(),
				email: z.string(),
				option: z.number().int(),
				answer: z.string().describe("The answer's label"),
				comment: z.string().nullable().describe("Their answer to the follow-up question"),
				votedAt: dateOutput.describe("When they last voted"),
			})
		),
		nextCursor: z.string().nullable(),
	}),
	handler: async ({ account, input }) => {
		const poll = await findPoll(account, input.id);
		if (input.cursor && !isObjectIdString(input.cursor)) throw actionError("validation_failed", "cursor: use the nextCursor of the previous page");
		const filter = scoped(account, {
			pollId: poll._id,
			contactId: { $exists: true },
			...(input.option !== undefined && { option: input.option }),
			...(input.cursor && { _id: { $gt: input.cursor.toLowerCase() } }),
		});
		const votes = await PollVote.find(filter).sort({ _id: 1 }).limit(VOTERS_PAGE + 1).lean();
		const page = votes.slice(0, VOTERS_PAGE);
		const contacts = await Contact.find(scoped(account, { _id: { $in: page.map(({ contactId }) => contactId) } }))
			.select({ email: 1 })
			.lean();
		const emails = new Map(contacts.map(({ _id, email }) => [String(_id), email]));
		return {
			voters: page
				.filter(({ contactId }) => emails.has(String(contactId)))
				.map((vote) => ({
					contactId: String(vote.contactId),
					email: emails.get(String(vote.contactId)),
					option: vote.option,
					answer: poll.options[vote.option]?.label ?? "",
					comment: vote.comment || null,
					votedAt: toIso(vote.updatedAt),
				})),
			nextCursor: votes.length > VOTERS_PAGE ? String(page.at(-1)._id) : null,
		};
	},
});

export const pollActions = [listPolls, getPoll, createPoll, updatePoll, deletePoll, listPollVoters];
