import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { as, jsonRequest } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { published } from "./stubs/qstash.mjs";

// Deleting a tag or a custom field on a large list: the contacts lose it in background jobs, a chunk at a time, each job
// publishing the next (lib/bulk-removal.js). Here a chunk is 10 contacts, a list is large from 10, and a job does one chunk.
let t;
let m;
let limits;
let counter = 0;

before(async () => {
	t = await setupAudienceTests();
	m = {
		...t.m,
		removal: await import("../lib/bulk-removal.js"),
		rules: await import("../lib/bulk-removal-rules.js"),
		route: await import("../app/api/jobs/remove-from-contacts/route.js"),
		BulkRemoval: (await import("../models/BulkRemoval.js")).default,
		CustomField: (await import("../models/CustomField.js")).default,
		Tag: (await import("../models/Tag.js")).default,
	};
	limits = { ...m.removal.REMOVAL_LIMITS };
});

after(() => t?.app.stop());

beforeEach(() => {
	Object.assign(m.removal.REMOVAL_LIMITS, { inline: 10, chunk: 10 });
	process.env.BULK_REMOVAL_STEP_MS = "0";
});

afterEach(() => {
	Object.assign(m.removal.REMOVAL_LIMITS, limits);
	delete process.env.BULK_REMOVAL_STEP_MS;
});

// A customer whose newsletter has `count` contacts with the tag vip and the field plan, and two without either.
async function customerWithList(count) {
	const user = await t.customer(`removal${++counter}@example.com`);
	await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" });
	await m.Tag.create({ accountId: user.accountId, newsletterId: user.newsletterId, name: "vip" });
	await m.Tag.create({ accountId: user.accountId, newsletterId: user.newsletterId, name: "beta" });
	const contact = (index, extra) => ({
		accountId: user.accountId,
		newsletterId: user.newsletterId,
		email: `reader${index}@removal${counter}.example.org`,
		status: "active",
		...extra,
	});
	await m.Contact.insertMany([
		...Array.from({ length: count }, (_, index) => contact(index, { tags: ["vip", "beta"], fields: { plan: "gold", city: "Paris" } })),
		contact(count, { tags: ["beta"] }),
		contact(count + 1, {}),
	]);
	return user;
}

const removalJobs = () => published.filter(({ url }) => url.endsWith("/api/jobs/remove-from-contacts"));

async function runStep(body) {
	const response = await m.route.POST(jsonRequest("http://localhost:3000/api/jobs/remove-from-contacts", { method: "POST", body }));
	return { status: response.status, ...(await response.json()) };
}

// Runs the latest job, and each one it publishes, until none is left. Returns each step's answer.
async function runAll() {
	const results = [];
	for (;;) {
		const job = removalJobs().at(-1);
		const before = removalJobs().length;
		const result = await runStep(job.body);
		results.push(result);
		if (removalJobs().length === before) return results;
	}
}

const withTag = (user, tag = "vip") => m.Contact.countDocuments({ accountId: user.accountId, newsletterId: user.newsletterId, tags: tag });
const withPlan = (user) => m.Contact.countDocuments({ accountId: user.accountId, newsletterId: user.newsletterId, "fields.plan": { $exists: true } });
const removalOf = (user) => m.BulkRemoval.findOne({ accountId: user.accountId }).sort({ createdAt: -1 }).lean();

describe("deleting a tag or a field", () => {
	test("on a small list happens in the request, with no job", async () => {
		const user = await customerWithList(9);
		const jobs = removalJobs().length;
		assert.deepEqual((await t.api(user.key, "DELETE", "/tags?tag=vip")).body, { tag: "vip", contacts: 9, inBackground: false });
		assert.deepEqual((await t.api(user.key, "DELETE", "/custom-fields/plan")).body, { key: "plan", deleted: true, contacts: 9, inBackground: false });
		assert.equal(removalJobs().length, jobs);
		assert.deepEqual([await withTag(user), await withPlan(user), await withTag(user, "beta")], [0, 0, 10]);
	});

	test("on a large list goes a chunk per job, with its progress, and leaves everything else as it was", async () => {
		const user = await customerWithList(25);
		const neighbour = await customerWithList(12);
		const result = await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		assert.deepEqual(result, { ok: true, contacts: 25, inBackground: true });
		assert.equal(await m.Tag.countDocuments({ accountId: user.accountId, name: "vip" }), 0, "the tag is gone from the list at once");
		assert.deepEqual(removalJobs().at(-1).body, { accountId: String(user.accountId), removalId: String((await removalOf(user))._id) });

		const said = [];
		const steps = [];
		for (;;) {
			const { removals } = await as(user, () => m.contacts.getRemovals(user.newsletterId));
			said.push(m.rules.describeRemoval(removals[0]));
			if (removals[0].status !== "running") break;
			steps.push(await runStep(removalJobs().at(-1).body));
		}
		assert.deepEqual(steps, [
			{ status: 200, continued: true, removed: 10 },
			{ status: 200, continued: true, removed: 20 },
			{ status: 200, continued: true, removed: 25 },
			{ status: 200, done: true, removed: 25 },
		]);
		assert.deepEqual(said, [
			"Removing the tag vip from 25 contacts… 0%",
			"Removing the tag vip from 25 contacts… 40%",
			"Removing the tag vip from 25 contacts… 80%",
			"Removing the tag vip from 25 contacts… 99%",
			"Removed the tag vip from 25 contacts",
		]);
		assert.deepEqual([await withTag(user), await withTag(user, "beta"), await withPlan(user)], [0, 26, 25], "only the tag went");
		assert.deepEqual([await withTag(neighbour), await withPlan(neighbour)], [12, 12], "another account's contacts keep theirs");

		const listed = await t.api(user.key, "GET", "/removals");
		assert.deepEqual(listed.body.removals.map(({ name, status, percent }) => [name, status, percent]), [["vip", "done", 100]], "the API lists it too");
		await m.BulkRemoval.updateOne({ accountId: user.accountId }, { $set: { finishedAt: new Date(Date.now() - 2 * 60 * 60_000) } });
		assert.deepEqual((await as(user, () => m.contacts.getRemovals(user.newsletterId))).removals, [], "done an hour ago, it leaves the list");
		assert.deepEqual(await runStep(removalJobs().at(-1).body), { status: 200, skipped: "done" }, "a job delivered after the end does nothing");
	});

	test("a list that fills its last chunk exactly ends with an empty one; a field's values go the same way", async () => {
		const user = await customerWithList(20);
		const answer = await t.api(user.key, "DELETE", "/custom-fields/plan");
		assert.deepEqual(answer.body, { key: "plan", deleted: true, contacts: 20, inBackground: true });
		assert.equal(await m.CustomField.countDocuments({ accountId: user.accountId, key: "plan" }), 0);
		const steps = await runAll();
		assert.deepEqual(
			steps.map(({ removed, done }) => [removed, Boolean(done)]),
			[
				[10, false],
				[20, false],
				[20, true],
			]
		);
		assert.equal(await withPlan(user), 0);
		const cities = await m.Contact.distinct("fields.city", { accountId: user.accountId });
		assert.deepEqual(cities, ["Paris"], "the other fields stay");
		const { removals } = await as(user, () => m.contacts.getRemovals(user.newsletterId));
		assert.equal(m.rules.describeRemoval(removals[0]), "Removed the field Plan from 20 contacts");
	});

	test("chunks of the real size: a page of docdb's updateMany each", async () => {
		m.removal.REMOVAL_LIMITS.chunk = limits.chunk;
		const user = await customerWithList(limits.chunk * 2 + 1);
		await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		const steps = await runAll();
		assert.deepEqual(
			steps.map(({ removed }) => removed),
			[limits.chunk, limits.chunk * 2, limits.chunk * 2 + 1, limits.chunk * 2 + 1]
		);
		assert.equal(await withTag(user), 0);
		assert.equal(await withTag(user, "beta"), limits.chunk * 2 + 2);
	});

	test("the progress line reads like the rest of the page", () => {
		const running = { kind: "tag", label: "vip", status: "running", total: 1_000_000, removed: 400_000, percent: 40 };
		assert.equal(m.rules.describeRemoval(running), "Removing the tag vip from 1,000,000 contacts… 40%");
		assert.equal(m.rules.describeRemoval({ ...running, kind: "field", label: "First name", status: "done", removed: 1 }), "Removed the field First name from 1 contact");
		const output = m.removal.toRemovalOutput({ _id: "x", kind: "tag", name: "vip", status: "running", total: 3, removed: 3 });
		assert.equal(output.percent, 99, "never 100% before it's done");
	});

	test("a step that throws is tried again from the last chunk it saved, and counts every contact once", async () => {
		const user = await customerWithList(25);
		await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		const job = removalJobs().at(-1).body;
		await runStep(job);

		const real = m.Contact.updateMany;
		let calls = 0;
		const failing = mock.method(m.Contact, "updateMany", function (...args) {
			if (++calls === 1) throw new Error("D1 is unavailable");
			return real.apply(this, args);
		});
		try {
			await assert.rejects(runStep(job), /D1 is unavailable/, "QStash sees the failure and tries again");
			const stopped = await removalOf(user);
			assert.deepEqual([stopped.status, stopped.attempts, stopped.removed, stopped.lockedUntil], ["running", 1, 10, undefined]);
			const steps = await runAll();
			assert.deepEqual(steps.at(-1), { status: 200, done: true, removed: 25 });
		} finally {
			failing.mock.restore();
		}
		assert.equal(await withTag(user), 0);
		assert.equal((await removalOf(user)).attempts, 0);
	});

	test("three failures in a row stop it; trying again picks up where it stopped", async () => {
		const user = await customerWithList(15);
		await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		const job = removalJobs().at(-1).body;
		await runStep(job);
		const failing = mock.method(m.Contact, "updateMany", () => {
			throw new Error("D1 is unavailable");
		});
		try {
			await assert.rejects(runStep(job));
			await assert.rejects(runStep(job));
			assert.deepEqual(await runStep(job), { status: 200, failed: "D1 is unavailable" });
		} finally {
			failing.mock.restore();
		}
		const { removals } = await as(user, () => m.contacts.getRemovals(user.newsletterId));
		assert.equal(m.rules.describeRemoval(removals[0]), "Removing the tag vip stopped after 10 contacts");

		const retried = await as(user, () => m.contacts.retryRemoval(removals[0].id));
		assert.deepEqual([retried.removal.status, retried.removal.removed], ["running", 10]);
		assert.deepEqual((await runAll()).at(-1), { status: 200, done: true, removed: 15 });
		assert.equal(await withTag(user), 0);
		assert.deepEqual(await as(user, () => m.contacts.retryRemoval(removals[0].id)), { error: "This removal isn't stopped: it's running or done" });
		t.assertError(await t.api(user.key, "POST", `/removals/${removals[0].id}/retry`), 409, "conflict");
		const other = await t.customer(`removal-other${counter}@example.com`);
		t.assertError(await t.api(other.key, "POST", `/removals/${removals[0].id}/retry`), 404, "not_found");
	});

	test("a step runs once at a time, and a removal whose job went quiet gets another", async () => {
		const user = await customerWithList(15);
		await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		const removal = await removalOf(user);
		await m.BulkRemoval.updateOne({ accountId: user.accountId, _id: removal._id }, { $set: { lockedUntil: new Date(Date.now() + 60_000) } });
		assert.deepEqual(await runStep(removalJobs().at(-1).body), { status: 503, busy: true });

		await m.BulkRemoval.updateOne({ accountId: user.accountId, _id: removal._id }, { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) }, $unset: { lockedUntil: 1 } });
		const jobs = removalJobs().length;
		await as(user, () => m.contacts.getRemovals(user.newsletterId));
		assert.equal(removalJobs().length, jobs + 1, "the page's look published a job");
		await as(user, () => m.contacts.getRemovals(user.newsletterId));
		assert.equal(removalJobs().length, jobs + 1, "once");
		assert.deepEqual((await runAll()).at(-1), { status: 200, done: true, removed: 15 });
	});

	test("deleting it again while it runs answers the same removal", async () => {
		const user = await customerWithList(15);
		await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		const jobs = removalJobs().length;
		assert.deepEqual((await t.api(user.key, "DELETE", "/tags?tag=vip")).body, { tag: "vip", contacts: 15, inBackground: true });
		assert.equal(removalJobs().length, jobs, "no second job");
		assert.equal(await m.BulkRemoval.countDocuments({ accountId: user.accountId }), 1);
	});

	test("the tag or field can't come back until its contacts lost it", async () => {
		const user = await customerWithList(12);
		const [contact] = (await t.api(user.key, "GET", "/contacts")).body.contacts;
		await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		await t.api(user.key, "DELETE", "/custom-fields/plan");
		const refused = t.assertError(await t.api(user.key, "POST", `/contacts/${contact.id}/tags`, { tag: "vip" }), 409, "conflict");
		assert.equal(refused, "The tag vip is still being removed from your contacts. Add it again once that's done.");
		t.assertError(await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" }), 409, "conflict");
		assert.equal((await t.api(user.key, "POST", `/contacts/${contact.id}/tags`, { tag: "beta" })).status, 200, "other tags work");

		for (const removal of await m.BulkRemoval.find({ accountId: user.accountId }).lean()) {
			while ((await runStep({ accountId: String(user.accountId), removalId: String(removal._id) })).continued);
		}
		assert.equal((await t.api(user.key, "POST", `/contacts/${contact.id}/tags`, { tag: "vip" })).status, 200);
		assert.equal((await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" })).status, 201);
	});

	test("jobs with someone else's or a made-up id do nothing", async () => {
		const user = await customerWithList(12);
		const other = await customerWithList(12);
		await as(user, () => m.contacts.deleteTag(user.newsletterId, "vip"));
		const { removalId } = removalJobs().at(-1).body;
		assert.deepEqual(await runStep({ accountId: String(other.accountId), removalId }), { status: 200, skipped: "not found" });
		assert.deepEqual(await runStep({ accountId: "nope", removalId }), { status: 200, skipped: "invalid job" });
		assert.equal(await withTag(user), 12);
		assert.deepEqual(await as(other, () => m.contacts.getRemovals(user.newsletterId)), { error: "Newsletter not found" });
	});
});
