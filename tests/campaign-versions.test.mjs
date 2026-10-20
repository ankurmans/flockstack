import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setupAudienceTests } from "./helpers/audience.mjs";

// A draft's version history: the state before an edit is kept (every two minutes at most, the last 30), listed, read and
// restored, with the draft as it was kept first so a restore can be undone.
let t;
let m;
let n = 0;

before(async () => {
	t = await setupAudienceTests();
	m = {
		versions: await import("../lib/campaign-versions.js"),
		CampaignVersion: (await import("../models/CampaignVersion.js")).default,
	};
});

after(() => t?.app.stop());

const customer = () => t.customer(`versions${++n}@example.com`);
const edit = (user, id, body) => t.api(user.key, "PATCH", `/campaigns/${id}`, body);
const list = async (user, id) => (await t.api(user.key, "GET", `/campaigns/${id}/versions`)).body.versions;
// Makes the latest kept state old enough for the next edit to keep another.
const ageVersions = async (user, minutes = 5) => {
	for (const row of await m.CampaignVersion.find({ accountId: user.accountId }).lean()) {
		await m.CampaignVersion.updateOne({ _id: row._id, accountId: user.accountId }, { $set: { createdAt: new Date(new Date(row.createdAt).getTime() - minutes * 60_000) } });
	}
};

describe("keeping versions", () => {
	test("keeps what the draft held before an edit, and no more than one every two minutes", async () => {
		const user = await customer();
		const id = await t.draft(user, { subject: "First", content: "First body." });
		assert.deepEqual(await list(user, id), [], "a new draft has no earlier state");

		await edit(user, id, { content: "Second body." });
		const [kept] = await list(user, id);
		assert.equal(kept.subject, "First");
		assert.equal(kept.excerpt, "First body.");
		assert.equal(kept.words, 2);

		await edit(user, id, { content: "Third body." });
		await edit(user, id, { content: "Fourth body." });
		assert.equal((await list(user, id)).length, 1, "edits within two minutes keep nothing more");

		await ageVersions(user);
		await edit(user, id, { content: "Fifth body." });
		const versions = await list(user, id);
		assert.equal(versions.length, 2);
		assert.equal(versions[0].excerpt, "Fourth body.", "newest first, holding the state before the edit");
	});

	test("keeps nothing for an empty draft, an edit that changes no words or the same state twice", async () => {
		const user = await customer();
		const empty = (await t.api(user.key, "POST", "/campaigns", {})).body.id;
		await edit(user, empty, { content: "Now there are words." });
		assert.deepEqual(await list(user, empty), [], "an empty draft is not worth keeping");

		const id = await t.draft(user, { subject: "Keep", content: "Words." });
		await edit(user, id, { audience: "all" });
		await edit(user, id, { subject: "Keep" });
		assert.deepEqual(await list(user, id), [], "nothing about the words changed");

		await edit(user, id, { previewText: "A new preview" });
		assert.equal((await list(user, id)).length, 1, "a changed preview text is a change");
		const campaign = await t.m.Campaign.findOne({ _id: id, accountId: user.accountId }).lean();
		const later = { now: new Date(Date.now() + 3_600_000) };
		assert.ok(await m.versions.recordVersion({ _id: user.accountId }, campaign, later), "the draft as it is now is new");
		assert.equal(await m.versions.recordVersion({ _id: user.accountId }, campaign, { now: new Date(Date.now() + 7_200_000) }), null, "the same state again keeps nothing");
	});

	test("keeps the last 30 and deletes the older ones", async () => {
		const user = await customer();
		const id = await t.draft(user, { subject: "Many", content: "Start." });
		const account = { _id: user.accountId };
		let campaign = await t.m.Campaign.findOne({ _id: id, accountId: user.accountId }).lean();
		for (let index = 0; index < 35; index++) {
			campaign = { ...campaign, html: `<p>State ${index}</p>` };
			await m.versions.recordVersion(account, campaign, { now: new Date(Date.now() + index * 3 * 60_000) });
		}
		const kept = await m.CampaignVersion.find({ accountId: user.accountId, campaignId: id }).sort({ createdAt: -1, _id: -1 }).lean();
		assert.equal(kept.length, m.versions.KEEP_VERSIONS);
		assert.equal(kept.at(-1).html, "<p>State 5</p>", "the five oldest are gone");
	});
});

describe("restoring", () => {
	test("puts a version back after keeping the draft as it is, so the restore can be undone", async () => {
		const user = await customer();
		const id = await t.draft(user, { subject: "Original subject", previewText: "Original preview", content: "Original body." });
		await edit(user, id, { subject: "Changed subject", previewText: "Changed preview", content: "Changed body." });
		const [original] = await list(user, id);

		const detail = (await t.api(user.key, "GET", `/campaigns/${id}/versions/${original.id}`)).body;
		assert.equal(detail.subject, "Original subject");
		assert.equal(detail.text, "Original body.");
		assert.equal(detail.format, "markdown");

		const restored = await t.api(user.key, "POST", `/campaigns/${id}/versions/${original.id}/restore`, {});
		assert.equal(restored.status, 200, JSON.stringify(restored.body));
		const campaign = (await t.api(user.key, "GET", `/campaigns/${id}`)).body;
		assert.deepEqual([campaign.subject, campaign.previewText, campaign.content], ["Original subject", "Original preview", "Original body."]);

		const versions = await list(user, id);
		assert.equal(versions[0].reason, "restore");
		assert.equal(versions[0].subject, "Changed subject", "the draft as it was before the restore");
		await t.api(user.key, "POST", `/campaigns/${id}/versions/${versions[0].id}/restore`, {});
		assert.equal((await t.api(user.key, "GET", `/campaigns/${id}`)).body.content, "Changed body.", "undone");
	});

	test("works on drafts only, and only on the account's own versions", async () => {
		const user = await customer();
		const other = await customer();
		const id = await t.draft(user, { subject: "Mine", content: "Words." });
		await edit(user, id, { content: "More words." });
		const [version] = await list(user, id);
		const otherId = await t.draft(other, { subject: "Theirs", content: "Words." });

		t.assertError(await t.api(other.key, "GET", `/campaigns/${id}/versions`), 404, "not_found");
		t.assertError(await t.api(other.key, "POST", `/campaigns/${otherId}/versions/${version.id}/restore`, {}), 404, "not_found");
		t.assertError(await t.api(user.key, "GET", `/campaigns/${id}/versions/6650f1c2e9b1d4a012345678`), 404, "not_found");

		await t.m.Campaign.updateOne({ _id: id, accountId: user.accountId }, { $set: { status: "sent", sentAt: new Date() } });
		t.assertError(await t.api(user.key, "POST", `/campaigns/${id}/versions/${version.id}/restore`, {}), 409, "conflict");
	});

	test("goes with the account when it is deleted", async () => {
		const { CONTENT_MODELS } = await import("../lib/account-purge.js");
		assert.ok(CONTENT_MODELS.some((Model) => Model.modelName === "CampaignVersion"));
	});
});
