import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setupAudienceTests } from "./helpers/audience.mjs";
let t, owner, Delivery;
before(async () => {
	t = await setupAudienceTests(); owner = await t.customer("record-events@example.com"); Delivery = (await import("../models/WebhookDelivery.js")).default;
	const events = ["author.created", "subscriber_perk.created", "poll.created", "poll.updated", "poll.deleted", "poll.voted", "survey.created", "survey.responded"];
	const made = await t.api(owner.key, "POST", "/webhooks", { url: "https://hooks.example.com/events", newsletter: owner.newsletterId, events }); assert.equal(made.status, 201, JSON.stringify(made.body));
});
after(() => t?.app.stop());
const call = (method, path, body) => t.api(owner.key, method, path, body);
async function records(type) { return Delivery.find({ accountId: owner.accountId, type }).lean(); }
test("configuration changes emit only scoped references, including private perks", async () => {
	await call("POST", "/authors", { newsletter: owner.newsletterId, name: "PRIVATE_AUTHOR_DETAIL", bio: "PRIVATE_BIO" });
	await call("POST", "/perks", { newsletter: owner.newsletterId, title: "PRIVATE_PERK_TITLE", code: "PRIVATE_PERK_CODE" });
	for (const type of ["author.created", "subscriber_perk.created"]) {
		const events = await records(type); assert.equal(events.length, 1); const body = JSON.parse(events[0].payload); assert.deepEqual(Object.keys(body.data).sort(), ["id", "newsletterId"]); assert.equal(body.data.newsletterId, owner.newsletterId); assert.doesNotMatch(events[0].payload, /PRIVATE_|example.com/);
	}
});
test("poll lifecycle and changed votes emit events; a retried identical vote does not", async () => {
	const made = await call("POST", "/polls", { newsletter: owner.newsletterId, question: "PRIVATE_QUESTION", options: [{ label: "A" }, { label: "B" }] }); assert.equal(made.status, 201, JSON.stringify(made.body)); const id = made.body.id;
	await call("PATCH", `/polls/${id}`, { question: "UPDATED_PRIVATE_QUESTION" });
	const { recordWebVote } = await import("../lib/polls.js");
	await recordWebVote({ pollId: id, option: 0, ip: "198.51.100.221" }); await recordWebVote({ pollId: id, option: 0, ip: "198.51.100.221" });
	assert.equal((await records("poll.voted")).length, 1);
	await recordWebVote({ pollId: id, option: 1, ip: "198.51.100.221" }); assert.equal((await records("poll.voted")).length, 2);
	await call("DELETE", `/polls/${id}`);
	for (const type of ["poll.created", "poll.updated", "poll.deleted"]) assert.equal((await records(type)).length, 1);
	for (const record of await records("poll.voted")) { const data = JSON.parse(record.payload).data; assert.equal(data.parentId, id); assert.doesNotMatch(record.payload, /PRIVATE_|198\.51|voterKey|option|email/); }
});
test("survey response events exclude answers and do not duplicate an unchanged signed submission", async () => {
	const made = await call("POST", "/surveys", { newsletter: owner.newsletterId, title: "Survey", questions: [{ type: "short_text", label: "Your thought" }] }); assert.equal(made.status, 201, JSON.stringify(made.body));
	const contact = await t.m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "survey-reader@example.com", status: "active" });
	const token = (await import("../lib/subscriber-links.js")).createSubscriberToken("survey", { contactId: contact._id, newsletterId: owner.newsletterId });
	const { submitSurvey } = await import("../lib/surveys.js");
	const input = { surveyId: made.body.id, token, read: () => "PRIVATE_ANSWER" };
	assert.equal((await submitSurvey(input)).ok, true); assert.equal((await submitSurvey(input)).ok, true); assert.equal((await records("survey.responded")).length, 1);
	await submitSurvey({ ...input, read: () => "CHANGED_PRIVATE_ANSWER" }); assert.equal((await records("survey.responded")).length, 2);
	for (const event of await records("survey.responded")) assert.doesNotMatch(event.payload, /PRIVATE_ANSWER|survey-reader|answers/);
});
