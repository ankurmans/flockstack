import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { callApi, form, platformEmails, startTestApp } from "./helpers/app.mjs";
import { addReader, createPublisher, importModels, inBrowser, settle, signInReader } from "./helpers/community.mjs";

let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		comments: await import("../lib/comments.js"),
		purge: await import("../lib/account-purge.js"),
		regions: await import("../lib/docs/regions.js"),
		Account: (await import("../models/Account.js")).default,
		Comment: (await import("../models/Comment.js")).default,
		CommentReport: (await import("../models/CommentReport.js")).default,
	};
});

after(() => app?.stop());

const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, body });

function post(user, visitor, fields) {
	return inBrowser(visitor, () => m.commentActions.submitComment(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, ...fields })));
}

describe("deleting a contact", () => {
	test("keeps their comments for the replies' sake as the Deleted reader's, with nothing that points to them", async () => {
		const user = await createPublisher(m, "anonymize-owner@example.com");
		const ann = await addReader(m, user, "ann@example.org");
		const bea = await addReader(m, user, "bea@example.org");
		const annBrowser = await signInReader(m, user, ann);
		const beaBrowser = await signInReader(m, user, bea);
		const root = await post(user, annBrowser, { body: "Ann's thought.", name: "Ann A" });
		const reply = await post(user, beaBrowser, { body: "Bea answers.", parent: root.id, name: "Bea B" });
		const beasComment = await post(user, beaBrowser, { body: "Bea's own point." });
		await inBrowser(annBrowser, () => m.commentActions.submitReport(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: beasComment.id, reason: "Ann disagrees" })));
		await inBrowser(beaBrowser, () => m.commentActions.submitReport(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: root.id })));
		assert.equal((await m.Comment.findOne({ accountId: user.accountId, _id: beasComment.id }).lean()).reports, 1);

		const deleted = await api(user, "DELETE", `/contacts/${ann._id}`);
		assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

		const kept = await m.Comment.findOne({ accountId: user.accountId, _id: root.id }).lean();
		assert.equal(kept.authorName, "Deleted reader");
		assert.equal(kept.authorId, undefined);
		assert.equal(kept.ipHash, undefined);
		assert.equal(kept.bodyHash, undefined);
		assert.equal(kept.body, "Ann's thought.", "the words stay for the replies");
		assert.ok(!JSON.stringify(kept).includes("Ann A") && !JSON.stringify(kept).includes("ann@example.org"));

		const pub = await m.comments.listPublicComments(user.newsletter, user.issue);
		assert.equal(pub.comments[0].authorName, "Deleted reader");
		assert.equal(pub.comments[0].replies[0].authorName, "Bea B", "other readers' comments are untouched");
		assert.equal(pub.comments[0].replies[0].id, reply.id);

		const owner = (await api(user, "GET", `/comments/${root.id}`)).body;
		assert.deepEqual(owner.author, { contactId: null, email: null, isBlocked: false, blockedReason: null });
		assert.equal(owner.authorName, "Deleted reader");

		assert.equal(await m.CommentReport.countDocuments({ accountId: user.accountId, reporterId: ann._id }), 0, "the reports they made go");
		assert.equal((await m.Comment.findOne({ accountId: user.accountId, _id: beasComment.id }).lean()).reports, 0, "and no longer count");
		assert.equal((await m.Comment.findOne({ accountId: user.accountId, _id: root.id }).lean()).reports, 1, "what was reported about them stays");
	});

	test("does the same for a contact who left, since the owner may delete them too", async () => {
		const user = await createPublisher(m, "anonymize-left-owner@example.com");
		const cal = await addReader(m, user, "cal@example.org");
		const posted = await post(user, await signInReader(m, user, cal), { body: "Before leaving." });
		await m.Contact.updateOne({ accountId: user.accountId, _id: cal._id }, { $set: { status: "unsubscribed" } });
		assert.equal((await api(user, "DELETE", `/contacts/${cal._id}`)).status, 200);
		assert.equal((await m.Comment.findOne({ accountId: user.accountId, _id: posted.id }).lean()).authorName, "Deleted reader");
	});
});

describe("deleting the account", () => {
	test("purges its comments and reports, and only its own", async () => {
		const user = await createPublisher(m, "purge-comments-owner@example.com");
		const other = await createPublisher(m, "purge-comments-other@example.com");
		for (const publisher of [user, other]) {
			const ann = await addReader(m, publisher, "ann@example.org");
			const bea = await addReader(m, publisher, "bea@example.org");
			const posted = await post(publisher, await signInReader(m, publisher, ann), { body: "Hello from a reader." });
			await inBrowser(await signInReader(m, publisher, bea), () => m.commentActions.submitReport(null, form({ newsletter: publisher.slug, p: publisher.issue.archiveSlug, comment: posted.id })));
		}
		assert.ok(m.purge.CONTENT_MODELS.some((Model) => Model.modelName === "Comment") && m.purge.CONTENT_MODELS.some((Model) => Model.modelName === "CommentReport"));

		const purgeAt = new Date(Date.now() - 1000);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled", "deletion.requestedAt": new Date(Date.now() - 20 * 86_400_000), "deletion.purgeAt": purgeAt } });
		assert.deepEqual(await m.purge.runPurge({ accountId: user.accountId, purgeAt: purgeAt.toISOString() }), { purged: true });
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId }), 0);
		assert.equal(await m.CommentReport.countDocuments({ accountId: user.accountId }), 0);
		assert.equal(await m.Comment.countDocuments({ accountId: other.accountId }), 1, "another account keeps its own");
		assert.equal(await m.CommentReport.countDocuments({ accountId: other.accountId }), 1);
	});
});

describe("where the data stays", () => {
	test("comments and display names are kept in the stack's own database, and the whole flow reaches no other service", async () => {
		const user = await createPublisher(m, "region-owner@example.com");
		const reader = await addReader(m, user, "dana@example.org");
		const hosts = [];
		const original = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			hosts.push(new URL(String(input?.url ?? input)).host);
			return original(input, init);
		};
		try {
			const visitor = await signInReader(m, user, reader);
			await inBrowser(visitor, () => m.commentActions.requestSignIn(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, email: "dana@example.org" })));
			const posted = await post(user, visitor, { body: "Kept in the database." });
			await inBrowser(visitor, () => m.commentActions.submitEdit(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: posted.id, body: "Kept, and edited." })));
			await api(user, "POST", `/comments/${posted.id}/moderate`, { action: "hide", reason: "Testing" });
			await api(user, "GET", "/comments");
			await settle();
		} finally {
			globalThis.fetch = original;
		}
		assert.deepEqual([...new Set(hosts)].filter((host) => host !== "api.resend.com"), [], "only FlockStack's own emails to the owner use an outside service");
		const stored = await m.Comment.findOne({ accountId: user.accountId }).lean();
		assert.equal(stored.body, "Kept, and edited.");
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: reader._id }).lean()).community.displayName, "Dana");
		assert.equal(m.Comment.collection.collectionName, "comments");
		assert.ok(platformEmails.length > 0);
	});

	test("the regions page lists them with the rest of the account's data", () => {
		assert.match(m.regions.REGION_DATA[0].what, /readers' comments and display names/);
		assert.match(m.regions.getRegionsMarkdown(), /readers' comments and display names/);
	});
});
