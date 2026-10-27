import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, form, startTestApp } from "./helpers/app.mjs";
import { addReader, browser, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";

let app;
let m;
let n = 0;
before(async () => {
	app = await startTestApp();
	m = {
		...await importModels(),
		badges: await import("../lib/supporter-badges.js"),
		comments: await import("../lib/comments.js"),
		readerActions: await import("../app/archive/reader-actions.js"),
		center: await import("../lib/subscriber-center.js"),
		Section: (await import("../components/SectionComments.jsx")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Comment: (await import("../models/Comment.js")).default,
		contacts: await import("../lib/contacts.js"),
	};
});
after(() => app?.stop());
async function setup({ supporter = true } = {}) {
	const user = await createPublisher(m, `badge-owner${++n}@example.com`);
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { paidTiers: [{ id: "supporter", name: "Supporter", prices: { year: 12000 }, founding: { enabled: true } }] } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const reader = await addReader(m, user, "reader@example.com", supporter ? { tier: "paid", paidTierId: "supporter", paidUntil: new Date(Date.now() + 30 * 86400000) } : {});
	const visitor = await signInReader(m, user, reader);
	const posted = await inBrowser(visitor, () => m.commentActions.submitComment(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, body: "Hello discussion.", name: "Anya" })));
	assert.equal(posted.ok, true);
	return { user, reader, visitor, commentId: posted.id };
}
function choose({ user, visitor }, enabled, extra = {}) {
	return inBrowser(visitor, () => m.readerActions.saveCommentBadge(null, form({ newsletter: user.slug, ...(enabled && { supporterBadge: "on" }), ...extra })));
}
const read = ({ user, commentId }, ids = [commentId]) => anonymous(() => m.commentActions.getSupporterBadges(user.slug, user.issue.archiveSlug, ids));

test("badges start off and only the reader session can opt in or out", async () => {
	const fixture = await setup();
	assert.deepEqual(await read(fixture), []);
	assert.ok((await inBrowser(browser(), () => m.readerActions.saveCommentBadge(null, form({ newsletter: fixture.user.slug, supporterBadge: "on" })))).error);
	const other = await addReader(m, fixture.user, "other-reader@example.com", { tier: "paid", paidTierId: "supporter", paidUntil: new Date(Date.now() + 86400000) });
	assert.equal((await choose(fixture, true, { contactId: String(other._id) })).ok, true);
	assert.deepEqual(await read(fixture), [fixture.commentId]);
	assert.equal((await m.Contact.findOne({ accountId: fixture.user.accountId, _id: other._id }).lean()).community?.supporterBadge, undefined);
	const current = await m.Contact.findOne({ accountId: fixture.user.accountId, _id: fixture.reader._id }).lean();
	assert.equal(current.community.supporterBadge, true); assert.ok(current.community.badgeUpdatedAt);
	assert.equal((await choose(fixture, false)).ok, true);
	assert.deepEqual(await read(fixture), []);
});

test("free, expired, non-founding and inactive contacts cannot publish a badge", async () => {
	const free = await setup({ supporter: false });
	assert.ok((await choose(free, true)).error); assert.deepEqual(await read(free), []);
	const fixture = await setup(); await choose(fixture, true);
	for (const patch of [{ tier: "free" }, { paidUntil: new Date(Date.now() - 7 * 86400000) }, { paidTierId: "unknown-tier" }, { status: "unsubscribed" }]) {
		await m.Contact.updateOne({ accountId: fixture.user.accountId, _id: fixture.reader._id }, { $set: { tier: "paid", paidTierId: "supporter", paidUntil: new Date(Date.now() + 86400000), status: "active", ...patch } });
		assert.deepEqual(await read(fixture), [], JSON.stringify(patch));
	}
	await m.Contact.updateOne({ accountId: fixture.user.accountId, _id: fixture.reader._id }, { $set: { status: "active", tier: "paid", paidTierId: "supporter", paidUntil: new Date(Date.now() + 86400000) } });
	await m.Newsletter.updateOne({ accountId: fixture.user.accountId, _id: fixture.user.newsletterId }, { $set: { paidTiers: [{ id: "supporter", name: "Supporter", prices: { year: 12000 }, founding: { enabled: false } }] } });
	assert.deepEqual(await read(fixture), [], "the current tier definition is read, not a cached newsletter");
});

test("public responses contain only requested published comment IDs and never a subscriber identity or paid terms", async () => {
	const fixture = await setup(); await choose(fixture, true);
	const other = await setup(); await choose(other, true);
	const found = await read(fixture, [fixture.commentId, fixture.commentId, other.commentId, String(fixture.reader._id), "invalid"]);
	assert.deepEqual(found, [fixture.commentId]);
	assert.ok(!JSON.stringify(found).includes(String(fixture.reader._id)));
	assert.ok(!JSON.stringify(found).includes("reader@example.com"));
	assert.deepEqual(await read(fixture, Array.from({ length: 1001 }, () => fixture.commentId)), []);
	await m.Comment.updateOne({ accountId: fixture.user.accountId, _id: fixture.commentId }, { $set: { status: "hidden" } });
	assert.deepEqual(await read(fixture), []);
	await m.Comment.updateOne({ accountId: fixture.user.accountId, _id: fixture.commentId }, { $set: { status: "published" } });
	await m.Campaign.updateOne({ accountId: fixture.user.accountId, _id: fixture.user.issue._id }, { $set: { publishTo: "email" } });
	assert.deepEqual(await read(fixture), []);
});

test("cached comment HTML contains no paid or consent snapshot; fresh checks drop deleted readers and permit withdrawal", async () => {
	const fixture = await setup(); await choose(fixture, true);
	const data = await m.comments.listPublicComments(fixture.user.newsletter, fixture.user.issue);
	assert.equal(data.comments[0].supporterBadge, undefined);
	assert.equal(data.comments[0].authorId, undefined);
	const html = renderToStaticMarkup(createElement(m.TooltipProvider, null, createElement(m.Section, { slug: fixture.user.slug, post: fixture.user.issue.archiveSlug, data })));
	assert.ok(!html.includes('title="Founding member"'));
	assert.ok(!html.includes(String(fixture.reader._id)));
	await m.Contact.updateOne({ accountId: fixture.user.accountId, _id: fixture.reader._id }, { $set: { tier: "free" } });
	assert.equal((await choose(fixture, false)).ok, true, "a downgrade never prevents withdrawing consent");
	assert.deepEqual(await read(fixture), []);
	const current = await m.Contact.findOne({ accountId: fixture.user.accountId, _id: fixture.reader._id }).lean();
	assert.equal((await m.center.getSubscriberCenter({ newsletter: fixture.user.newsletter, contact: current })).supporterBadge.enabled, false);
	await m.contacts.removeContact({ _id: fixture.user.accountId }, current);
	assert.deepEqual(await read(fixture), []);
});
