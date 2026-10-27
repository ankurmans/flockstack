import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// Bulk issue actions: delete drafts, unlist and list, and move drafts to another newsletter, each campaign answered for.
let t;
let n = 0;

before(async () => {
	t = await setupAudienceTests();
});

after(() => t?.app.stop());

const customer = () => t.customer(`bulk${++n}@example.com`);
const bulk = (user, body) => t.api(user.key, "POST", "/campaigns/bulk", body);
const get = async (user, id) => (await t.api(user.key, "GET", `/campaigns/${id}`)).body;

function sentIssue(user, fields = {}) {
	return t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Sent", status: "sent", sentAt: new Date(), archiveSlug: `sent-${++n}`, ...fields });
}

describe("delete", () => {
	test("discards drafts and scheduled campaigns, skips sent ones with a reason and says what happened to each", async () => {
		const user = await customer();
		const one = await t.draft(user, { subject: "One" });
		const two = await t.draft(user, { subject: "Two" });
		const scheduled = await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Scheduled", status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000) });
		const sent = await sentIssue(user);

		const { status, body } = await bulk(user, { ids: [one, two, String(scheduled._id), String(sent._id), "6650f1c2e9b1d4a012345678", "nope", one], operation: "delete" });
		assert.equal(status, 200, JSON.stringify(body));
		assert.deepEqual(body.results.map(({ id, status: result }) => [id, result]), [
			[one, "done"],
			[two, "done"],
			[String(scheduled._id), "done"],
			[String(sent._id), "skipped"],
			["6650f1c2e9b1d4a012345678", "skipped"],
			["nope", "skipped"],
		], "each id once, in order");
		assert.equal(body.done, 3);
		assert.equal(body.skipped, 3);
		assert.match(body.results[3].reason, /Only drafts and scheduled/);
		assert.equal(body.results[4].reason, "Campaign not found");

		t.assertError(await t.api(user.key, "GET", `/campaigns/${one}`), 404, "not_found");
		assert.equal((await get(user, String(sent._id))).status, "sent");
		const stored = await t.m.Campaign.findOne({ _id: scheduled._id, accountId: user.accountId }).lean();
		assert.equal(stored.status, "canceled");
		assert.equal(stored.scheduledAt, undefined, "its send is gone");
		assert.deepEqual((await t.api(user.key, "GET", "/campaigns")).body.campaigns.map(({ id }) => id), [String(sent._id)]);
	});

	test("frees the campaign a deleted resend copied", async () => {
		const user = await customer();
		const original = await sentIssue(user);
		const resend = await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Resend", status: "draft", resend: { of: original._id, to: "unopened" } });
		await t.m.Campaign.updateOne({ _id: original._id, accountId: user.accountId }, { $set: { resentAs: resend._id } });
		assert.equal((await bulk(user, { ids: [String(resend._id)], operation: "delete" })).body.done, 1);
		assert.equal((await t.m.Campaign.findOne({ _id: original._id, accountId: user.accountId }).lean()).resentAs, undefined);
	});

	test("never touches another account's campaigns", async () => {
		const user = await customer();
		const other = await customer();
		const theirs = await t.draft(other, { subject: "Theirs" });
		const result = await bulk(user, { ids: [theirs], operation: "delete" });
		assert.deepEqual(result.body.results, [{ id: theirs, status: "skipped", reason: "Campaign not found" }]);
		assert.equal((await get(other, theirs)).status, "draft");
	});
});

describe("unlist and list", () => {
	test("take issues off and put them back on the website's list, pins gone with the unlisting", async () => {
		const user = await customer();
		const issue = await sentIssue(user, { archivePinned: true });
		const emailOnly = await sentIssue(user, { publishTo: "email", archiveListed: false });

		const unlisted = await bulk(user, { ids: [String(issue._id), String(emailOnly._id)], operation: "unlist" });
		assert.deepEqual(unlisted.body.results.map(({ status }) => status), ["done", "skipped"]);
		assert.match(unlisted.body.results[1].reason, /email only/);
		const after = await get(user, String(issue._id));
		assert.equal(after.archiveListed, false);
		assert.equal(after.archivePinned, false);

		assert.equal((await bulk(user, { ids: [String(issue._id)], operation: "list" })).body.done, 1);
		assert.equal((await get(user, String(issue._id))).archiveListed, true);
		assert.equal((await get(user, String(emailOnly._id))).archiveListed, false, "an email only issue stays unlisted");
	});
});

describe("archive and unarchive", () => {
	test("put drafts and sent issues away from the list, take a sent issue off the website's list and bring both back", async () => {
		const user = await customer();
		const draft = await t.draft(user, { subject: "Old draft" });
		const issue = await sentIssue(user, { archivePinned: true });
		const unlisted = await sentIssue(user, { archiveListed: false });
		const scheduled = await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "S", status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000) });

		const archived = await bulk(user, { ids: [draft, String(issue._id), String(unlisted._id), String(scheduled._id)], operation: "archive" });
		assert.equal(archived.status, 200, JSON.stringify(archived.body));
		assert.deepEqual(archived.body.results.map(({ status }) => status), ["done", "done", "done", "skipped"]);
		assert.equal(archived.body.results[3].reason, "Unschedule it first");
		assert.equal((await bulk(user, { ids: [draft], operation: "archive" })).body.results[0].reason, "Already archived");

		const away = await get(user, String(issue._id));
		assert.equal(away.archived, true);
		assert.equal(away.archiveListed, false, "a sent issue leaves the website's list");
		assert.equal(away.archivePinned, false);
		const listed = (await t.api(user.key, "GET", "/campaigns")).body.campaigns.map(({ id }) => id);
		assert.deepEqual(listed, [String(scheduled._id)], "archived campaigns are left out of the default list");
		const only = (await t.api(user.key, "GET", "/campaigns?archived=true")).body.campaigns.map(({ id }) => id).toSorted();
		assert.deepEqual(only, [draft, String(issue._id), String(unlisted._id)].toSorted());

		const restored = await bulk(user, { ids: [draft, String(issue._id), String(unlisted._id), String(scheduled._id)], operation: "unarchive" });
		assert.deepEqual(restored.body.results.map(({ status }) => status), ["done", "done", "done", "skipped"]);
		assert.equal(restored.body.results[3].reason, "Not archived");
		assert.equal((await get(user, String(issue._id))).archiveListed, true, "the archive unlisted it, so unarchiving lists it again");
		assert.equal((await get(user, String(issue._id))).archived, false);
		assert.equal((await get(user, String(unlisted._id))).archiveListed, false, "an issue that was unlisted before stays unlisted");
		assert.equal((await t.api(user.key, "GET", "/campaigns?archived=true")).body.campaigns.length, 0);
	});

	test("skip a send in progress and another account's campaign", async () => {
		const user = await customer();
		const other = await customer();
		const sending = await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Going out", status: "sending" });
		const theirs = await t.draft(other);
		const result = await bulk(user, { ids: [String(sending._id), theirs], operation: "archive" });
		assert.deepEqual(result.body.results.map(({ reason }) => reason), ["Wait until the send is over", "Campaign not found"]);
		assert.equal((await get(other, theirs)).archived, false);
	});

	test("the dashboard list shows archived campaigns in their own view, with the bar offering Unarchive", async () => {
		const user = await customer();
		const draft = await t.draft(user, { subject: "Put away" });
		await t.draft(user, { subject: "Kept" });
		await bulk(user, { ids: [draft], operation: "archive" });
		const page = (await import("../app/(app)/campaigns/(list)/page.js")).default;
		const active = renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve({}) })));
		assert.match(active, /aria-label="Select Kept"/);
		assert.doesNotMatch(active, /aria-label="Select Put away"/);
		assert.match(active, /href="\/campaigns\?view=archived"/);
		const away = renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve({ view: "archived" }) })));
		assert.match(away, /aria-label="Select Put away"/);
		assert.doesNotMatch(away, /aria-label="Select Kept"/);
	});
});

describe("the tag filter", () => {
	test("list_campaigns takes a tag by name or web address form, and the dashboard list filters on ?tag=", async () => {
		const user = await customer();
		const tagged = await t.draft(user, { subject: "About cats" });
		const other = await t.draft(user, { subject: "About dogs" });
		await t.draft(user, { subject: "Untagged" });
		assert.equal((await t.api(user.key, "PATCH", `/campaigns/${tagged}`, { tags: ["Pet News"] })).status, 200);
		assert.equal((await t.api(user.key, "PATCH", `/campaigns/${other}`, { tags: ["Dogs", "pet-news"] })).status, 200);

		const byName = (await t.api(user.key, "GET", "/campaigns?tag=Pet%20News")).body.campaigns.map(({ id }) => id).toSorted();
		assert.deepEqual(byName, [tagged, other].toSorted());
		assert.deepEqual((await t.api(user.key, "GET", "/campaigns?tag=pet-news")).body.campaigns.map(({ id }) => id).toSorted(), byName);
		assert.deepEqual((await t.api(user.key, "GET", "/campaigns?tag=dogs")).body.campaigns.map(({ id }) => id), [other]);
		assert.deepEqual((await t.api(user.key, "GET", "/campaigns?tag=nothing")).body.campaigns, []);

		const page = (await import("../app/(app)/campaigns/(list)/page.js")).default;
		const filtered = renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve({ tag: "dogs" }) })));
		assert.match(filtered, /aria-label="Select About dogs"/);
		assert.doesNotMatch(filtered, /aria-label="Select About cats"/);
		assert.doesNotMatch(filtered, /aria-label="Select Untagged"/);
		const unfiltered = renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve({}) })));
		assert.match(unfiltered, /aria-label="Select Untagged"/);
		assert.match(unfiltered, /aria-label="Tag"/, "the tag filter shows once a campaign has tags");
		const unknown = renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve({ tag: "Not a tag" }) })));
		assert.match(unknown, /aria-label="Select Untagged"/, "an unknown tag in the address shows everything");
	});
});

describe("move", () => {
	test("puts drafts in another newsletter, leaving its segment behind", async () => {
		const user = await customer();
		const second = (await t.api(user.key, "POST", "/newsletters", { name: "Second", slug: `${user.slug}-two`, postalAddress: "1 Main St, Paris" })).body;
		const segment = await t.api(user.key, "POST", "/segments", { name: "Beta readers", rules: { match: "all", conditions: [{ type: "tag", value: "beta" }] } });
		assert.equal(segment.status, 201, JSON.stringify(segment.body));
		const id = await t.draft(user, { subject: "Moving" });
		await t.api(user.key, "PATCH", `/campaigns/${id}`, { segment: segment.body.id });
		assert.equal((await get(user, id)).segmentId, segment.body.id);

		const moved = await bulk(user, { ids: [id], operation: "move", newsletter: second.slug });
		assert.equal(moved.status, 200, JSON.stringify(moved.body));
		assert.equal(moved.body.done, 1);
		const campaign = await get(user, id);
		assert.equal(campaign.newsletterId, second.id);
		assert.equal(campaign.segmentId, null, "the old newsletter's segment is not carried over");
		assert.deepEqual(campaign.segmentIds, []);
		assert.equal((await t.api(user.key, "GET", `/campaigns?newsletter=${second.slug}`)).body.campaigns.length, 1);
		assert.equal((await t.api(user.key, "GET", `/campaigns?newsletter=${user.slug}`)).body.campaigns.length, 0);
	});

	test("moves a draft's polls along and sets a paid audience back to everyone where there is no paid tier", async () => {
		const user = await customer();
		const second = (await t.api(user.key, "POST", "/newsletters", { name: "Second", slug: `${user.slug}-two`, postalAddress: "1 Main St, Paris" })).body;
		const id = await t.draft(user);
		const Poll = (await import("../models/Poll.js")).default;
		await Poll.create({ accountId: user.accountId, newsletterId: user.newsletterId, campaignId: id, question: "Which?", options: [{ label: "A" }, { label: "B" }] });
		await t.m.Campaign.updateOne({ _id: id, accountId: user.accountId }, { $set: { audience: "paid" } });
		await t.m.Newsletter.updateOne({ _id: user.newsletterId, accountId: user.accountId }, { $set: { "paidTier.enabled": true } });

		assert.equal((await bulk(user, { ids: [id], operation: "move", newsletter: second.id })).body.done, 1);
		assert.equal(String((await Poll.findOne({ accountId: user.accountId, campaignId: id }).lean()).newsletterId), second.id);
		assert.equal((await get(user, id)).audience, "all", "the second newsletter has no paid tier");
	});

	test("skips scheduled and sent campaigns and ones already there, and needs a newsletter of the account", async () => {
		const user = await customer();
		const other = await customer();
		const second = (await t.api(user.key, "POST", "/newsletters", { name: "Second", slug: `${user.slug}-two`, postalAddress: "1 Main St, Paris" })).body;
		const draft = await t.draft(user);
		const scheduled = await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "S", status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000) });
		const sent = await sentIssue(user);

		const result = await bulk(user, { ids: [String(scheduled._id), String(sent._id)], operation: "move", newsletter: second.slug });
		assert.deepEqual(result.body.results.map(({ reason }) => reason), ["Unschedule it first", "A sent issue stays in the newsletter it went out from"]);
		assert.equal((await bulk(user, { ids: [draft], operation: "move", newsletter: user.slug })).body.results[0].reason, "It is already in that newsletter");
		t.assertError(await bulk(user, { ids: [draft], operation: "move", newsletter: other.slug }), 404, "not_found");
		t.assertError(await bulk(user, { ids: [draft], operation: "move", newsletter: "nope" }), 404, "not_found");
		assert.equal((await get(user, draft)).newsletterId, user.newsletterId, "nothing moved");
	});
});

describe("the request", () => {
	test("takes 1 to 100 IDs and a known operation", async () => {
		const user = await customer();
		t.assertError(await bulk(user, { ids: [], operation: "delete" }), 400, "validation_failed");
		t.assertError(await bulk(user, { ids: Array.from({ length: 101 }, (_, index) => `id${index}`), operation: "delete" }), 400, "validation_failed");
		t.assertError(await bulk(user, { ids: ["a"], operation: "explode" }), 400, "validation_failed");
	});
});

describe("the list", () => {
	test("has a checkbox for each campaign and for all of them, and the dashboard action reports what was skipped", async () => {
		const user = await customer();
		const draft = await t.draft(user, { subject: "A draft" });
		await sentIssue(user, { subject: "A sent one" });
		const page = (await import("../app/(app)/campaigns/(list)/page.js")).default;
		const html = renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve({}) })));
		assert.match(html, /aria-label="Select all campaigns"/);
		assert.match(html, /aria-label="Select A draft"/);
		assert.match(html, /aria-label="Select A sent one"/);

		const actions = await import("../app/(app)/campaigns/actions.js");
		const mixed = await as(user, () => actions.bulkUpdateCampaigns([draft, "6650f1c2e9b1d4a012345678"], "delete"));
		assert.deepEqual(mixed, { ok: true, done: 1, skipped: 1, reasons: ["Campaign not found"] });
		assert.match((await as(user, () => actions.bulkUpdateCampaigns([draft], "explode"))).error, /operation/);
	});
});
