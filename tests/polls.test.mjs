import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { castFilter } from "../lib/docdb/schema.js";
import { splitFilter } from "../lib/docdb/sql.js";
import { checkRules, compileRules } from "../lib/segment-rules.js";
import { createSubscriberToken } from "../lib/subscriber-links.js";
import { form } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let t;
let actions;
let PollVote;

before(async () => {
	t = await setupAudienceTests();
	actions = await import("../app/poll/actions.js");
	PollVote = (await import("../models/PollVote.js")).default;
});

after(() => t?.app.stop());

function runWithRequestHeaders(headers, run) {
	return runWithRequest({ headers }, run);
}

// The vote page's action, from a reader at an address: where it redirects, or { returned } when it doesn't.
function vote({ pollId, option, token = null, ip = "203.0.113.50" }) {
	return runWithRequestHeaders({ "x-forwarded-for": ip }, async () => {
		try {
			return { returned: await actions.vote(pollId, option, token) };
		} catch (error) {
			if (typeof error?.url === "string") return error.url;
			throw error;
		}
	});
}

function voteLinks(html) {
	return [...html.matchAll(/href="([^"]*\/poll\?[^"]*)"/g)].map(([, href]) => new URL(href.replaceAll("&amp;", "&")));
}

async function setupPoll(email, poll = {}) {
	const user = await t.customer(email);
	await t.api(user.key, "POST", "/custom-fields", { label: "Topic", type: "list", options: ["Tools", "Interviews"] });
	const created = await t.api(user.key, "POST", "/polls", {
		question: "What next?",
		options: [{ label: "Tools", tag: "likes tools" }, { label: "Interviews", tag: "likes interviews" }],
		fieldKey: "topic",
		followUp: "Why?",
		...poll,
	});
	assert.equal(created.status, 201, JSON.stringify(created.body));
	await t.importReaders(user, 3);
	const contacts = (await t.api(user.key, "GET", "/contacts")).body.contacts;
	const token = (contact) => createSubscriberToken("poll", { contactId: contact.id, newsletterId: user.newsletterId });
	return { user, poll: created.body, contacts, token };
}

describe("polls", () => {
	test("are checked when they're made", async () => {
		const user = await t.customer("polls-checks@example.com");
		const make = (body) => t.api(user.key, "POST", "/polls", { question: "Q?", options: [{ label: "A" }, { label: "B" }], ...body });
		t.assertError(await make({ options: [{ label: "Only" }] }), 400, "validation_failed");
		t.assertError(await make({ options: Array.from({ length: 7 }, (_, index) => ({ label: `O${index}` })) }), 400, "validation_failed");
		t.assertError(await make({ options: [{ label: "Same" }, { label: "same" }] }), 400, "validation_failed");
		t.assertError(await make({ fieldKey: "nope" }), 400, "validation_failed");
		t.assertError(await make({ options: [{ label: "A", tag: "<b>" }, { label: "B" }] }), 400, "validation_failed");
		const made = await make({});
		assert.equal(made.status, 201);
		assert.equal(made.body.html, `<div data-poll="${made.body.id}"><p>Q?</p><ol><li>A</li><li>B</li></ol></div>`);
		assert.deepEqual(made.body.votes, { email: 0, web: 0, total: 0 });
	});

	test("go out with vote links of each subscriber's own, outside click tracking", async () => {
		const { user, poll, contacts } = await setupPoll("polls-send@example.com");
		const id = await t.draft(user, { format: "rich", content: `<p>Tell me.</p>${poll.html}` });
		const before = sesEmails.length;
		assert.equal((await t.api(user.key, "POST", `/campaigns/${id}/send`)).status, 200);
		await t.runJobs();
		const mails = sesEmails.slice(before);
		assert.equal(mails.length, contacts.length);
		const tokens = new Set();
		for (const mail of mails) {
			const links = voteLinks(mail.html);
			assert.equal(links.length, 2, "a link per answer");
			assert.deepEqual(links.map((url) => url.searchParams.get("o")), ["0", "1"]);
			assert.ok(links.every((url) => url.searchParams.get("p") === poll.id && url.pathname === "/poll"));
			assert.ok(!mail.html.includes("{{poll:"), "no placeholder left");
			assert.ok(mail.text.includes(`Tools (${links[0].toString()})`));
			tokens.add(links[0].searchParams.get("token"));
		}
		assert.equal(tokens.size, mails.length, "each reader's links are theirs");
	});

	test("count one vote per subscriber, changed by voting again, with the field and tags following", async () => {
		const { user, poll, contacts, token } = await setupPoll("polls-votes@example.com");
		const [ann, bob] = contacts;
		const url = await vote({ pollId: poll.id, option: 0, token: token(ann) });
		assert.match(url, new RegExp(`^/poll/results\\?p=${poll.id}&token=`));
		await vote({ pollId: poll.id, option: 0, token: token(ann) });
		await vote({ pollId: poll.id, option: 1, token: token(bob) });
		let results = (await t.api(user.key, "GET", `/polls/${poll.id}`)).body;
		assert.deepEqual(results.options.map(({ votes }) => votes.email), [1, 1], "voting twice counts once");
		let stored = await t.m.Contact.findOne({ accountId: user.accountId, _id: ann.id }).lean();
		assert.deepEqual({ answer: stored.polls[`p${poll.id}`], topic: stored.fields.topic, tags: stored.tags }, { answer: 0, topic: "Tools", tags: ["likes tools"] });

		await vote({ pollId: poll.id, option: 1, token: token(ann) });
		results = (await t.api(user.key, "GET", `/polls/${poll.id}`)).body;
		assert.deepEqual(results.options.map(({ votes }) => votes.email), [0, 2]);
		stored = await t.m.Contact.findOne({ accountId: user.accountId, _id: ann.id }).lean();
		assert.deepEqual({ answer: stored.polls[`p${poll.id}`], topic: stored.fields.topic, tags: stored.tags }, { answer: 1, topic: "Interviews", tags: ["likes interviews"] });
		assert.equal(await PollVote.countDocuments({ accountId: user.accountId, pollId: poll.id }), 2);
	});

	test("refuse links that are forged, of another kind, or for another newsletter's poll", async () => {
		const { user, poll, contacts, token } = await setupPoll("polls-tamper@example.com");
		const good = token(contacts[0]);
		const [payload, signature] = good.split(".");
		const forged = `${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
		assert.deepEqual(await vote({ pollId: poll.id, option: 0, token: forged }), { returned: { error: "invalid" } });
		const preferences = createSubscriberToken("preferences", { contactId: contacts[0].id, newsletterId: user.newsletterId });
		assert.deepEqual(await vote({ pollId: poll.id, option: 0, token: preferences }), { returned: { error: "invalid" } });
		assert.deepEqual(await vote({ pollId: poll.id, option: 9, token: good }), { returned: { error: "invalid" } });

		const other = await setupPoll("polls-tamper-other@example.com");
		assert.deepEqual(await vote({ pollId: other.poll.id, option: 0, token: good }), { returned: { error: "invalid" } }, "a link of one newsletter can't vote in another's poll");
		assert.equal(await PollVote.countDocuments({ accountId: user.accountId }), 0);
		assert.equal(await PollVote.countDocuments({ accountId: other.user.accountId }), 0);
	});

	test("count website votes apart, one per address, held back past a rate", async () => {
		const { user, poll } = await setupPoll("polls-web@example.com");
		await vote({ pollId: poll.id, option: 0, ip: "198.18.0.1" });
		await vote({ pollId: poll.id, option: 1, ip: "198.18.0.1" });
		await vote({ pollId: poll.id, option: 1, ip: "198.18.0.2" });
		const results = (await t.api(user.key, "GET", `/polls/${poll.id}`)).body;
		assert.deepEqual(results.options.map(({ votes }) => votes), [
			{ email: 0, web: 0, total: 0 },
			{ email: 0, web: 2, total: 2 },
		]);
		const stored = await PollVote.findOne({ accountId: user.accountId, pollId: poll.id }).lean();
		assert.ok(stored.voterKey && !JSON.stringify(stored).includes("198.18.0"), "no address is stored");

		let last;
		for (let index = 0; index < 31; index++) last = await vote({ pollId: poll.id, option: 0, ip: "198.18.0.3" });
		assert.deepEqual(last, { returned: { error: "busy" } });
	});

	test("take no votes once closed, and keep the follow-up answer on the voter's own vote", async () => {
		const { user, poll, contacts, token } = await setupPoll("polls-closed@example.com");
		const ann = token(contacts[0]);
		await vote({ pollId: poll.id, option: 0, token: ann });
		const saved = await runWithRequestHeaders({}, () => actions.answerFollowUp(poll.id, ann, null, form({ comment: "More tools please" })));
		assert.deepEqual(saved, { ok: true });
		const anonymousAnswer = await runWithRequestHeaders({ "x-forwarded-for": "198.18.1.1" }, () => actions.answerFollowUp(poll.id, null, null, form({ comment: "Me too" })));
		assert.ok(anonymousAnswer.error, "a reader who didn't vote can't answer");
		const voters = (await t.api(user.key, "GET", `/polls/${poll.id}/voters?option=0`)).body.voters;
		assert.deepEqual(voters.map(({ email, answer, comment }) => ({ email, answer, comment })), [{ email: contacts[0].email, answer: "Tools", comment: "More tools please" }]);
		assert.deepEqual((await t.api(user.key, "GET", `/polls/${poll.id}/voters?option=1`)).body.voters, []);

		assert.equal((await t.api(user.key, "PATCH", `/polls/${poll.id}`, { closed: true })).body.closed, true);
		const url = await vote({ pollId: poll.id, option: 1, token: token(contacts[1]) });
		assert.match(url, /status=closed/);
		assert.equal((await t.api(user.key, "GET", `/polls/${poll.id}`)).body.votes.total, 1);
	});

	test("keep their answers once voted on, and update a draft's block when reworded", async () => {
		const { user, poll, contacts, token } = await setupPoll("polls-update@example.com");
		const id = await t.draft(user, { format: "rich", content: `<p>Hi</p>${poll.html}` });
		await t.api(user.key, "PATCH", `/polls/${poll.id}`, { question: "What should come next?" });
		const linked = await t.api(user.key, "POST", "/polls", { question: "Linked?", options: [{ label: "Yes" }, { label: "No" }], campaign: id });
		await t.m.Campaign.updateOne({ accountId: user.accountId, _id: id }, { $set: { html: `<p>Hi</p>${linked.body.html}` } });
		await t.api(user.key, "PATCH", `/polls/${linked.body.id}`, { options: [{ label: "Yes please" }, { label: "No thanks" }] });
		const draft = (await t.api(user.key, "GET", `/campaigns/${id}`)).body;
		assert.ok(draft.content.includes("<li>Yes please</li><li>No thanks</li>"), "the draft shows the new answers");

		await vote({ pollId: poll.id, option: 0, token: token(contacts[0]) });
		t.assertError(await t.api(user.key, "PATCH", `/polls/${poll.id}`, { options: [{ label: "A" }, { label: "B" }, { label: "C" }] }), 409, "conflict");
		const reworded = await t.api(user.key, "PATCH", `/polls/${poll.id}`, { options: [{ label: "Tools and apps" }, { label: "Interviews" }] });
		assert.equal(reworded.body.options[0].votes.email, 1, "votes stay with their answer");
	});

	test("make segments by answer, in the database", async () => {
		const { user, poll, contacts, token } = await setupPoll("polls-segments@example.com");
		await vote({ pollId: poll.id, option: 0, token: token(contacts[0]) });
		await vote({ pollId: poll.id, option: 1, token: token(contacts[1]) });
		const who = async (condition) =>
			(await t.api(user.key, "POST", "/segments/preview", { rules: { match: "all", conditions: [{ type: "poll", poll: poll.id, ...condition }] }, sample: 25 })).body.sample
				.map(({ email }) => email)
				.sort();
		assert.deepEqual(await who({ op: "is", option: 0 }), [contacts[0].email]);
		assert.deepEqual(await who({ op: "is_not", option: 0 }), [contacts[1].email, contacts[2].email].sort());
		assert.deepEqual(await who({ op: "is_set" }), [contacts[0].email, contacts[1].email].sort());
		assert.deepEqual(await who({ op: "is_not_set" }), [contacts[2].email]);

		const saved = await t.api(user.key, "POST", "/segments", { name: "Tools fans", rules: { match: "all", conditions: [{ type: "poll", poll: poll.id, op: "is", option: 0 }] } });
		assert.equal(saved.body.summary, 'Answered "Tools" in the poll "What next?"');
		t.assertError(await t.api(user.key, "POST", "/segments/preview", { rules: { match: "all", conditions: [{ type: "poll", poll: "6650f1c2e9b1d4a012345678", op: "is_set" }] } }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/segments/preview", { rules: { match: "all", conditions: [{ type: "poll", poll: poll.id, op: "is", option: 4 }] } }), 400, "validation_failed");

		const Contact = (await import("../models/Contact.js")).default;
		const { rules } = checkRules({ match: "any", conditions: [{ type: "poll", poll: poll.id, op: "is_not", option: 1 }, { type: "poll", poll: poll.id, op: "is_set" }] }, new Map());
		assert.equal(splitFilter(Contact.schema, castFilter(Contact.schema, { accountId: user.accountId, ...compileRules(rules) })).hasResidual, false);

		assert.deepEqual((await t.api(user.key, "DELETE", `/polls/${poll.id}`)).body, { id: poll.id, deleted: true });
		assert.deepEqual(await who({ op: "is_set" }).catch(() => []), []);
		const stored = await Contact.findOne({ accountId: user.accountId, _id: contacts[0].id }).lean();
		assert.equal(stored.polls?.[`p${poll.id}`], undefined, "the contacts' answers go with it");
		assert.equal(await PollVote.countDocuments({ accountId: user.accountId }), 0);
	});

	test("stay inside their account", async () => {
		const { poll } = await setupPoll("polls-owner@example.com");
		const other = await t.customer("polls-stranger@example.com");
		t.assertError(await t.api(other.key, "GET", `/polls/${poll.id}`), 404, "not_found");
		t.assertError(await t.api(other.key, "DELETE", `/polls/${poll.id}`), 404, "not_found");
		assert.deepEqual((await t.api(other.key, "GET", "/polls")).body.polls, []);
	});
});
