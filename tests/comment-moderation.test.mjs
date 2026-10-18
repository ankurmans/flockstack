import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { after, before, describe, test } from "node:test";
import { as, callApi, form, platformEmails, startTestApp } from "./helpers/app.mjs";
import { addIssue, addReader, browser, createPublisher, emailCount, emailsTo, importModels, inBrowser, settle, signInReader } from "./helpers/community.mjs";

let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		comments: await import("../lib/comments.js"),
		notify: await import("../lib/comment-notify.js"),
		blocks: await import("../lib/account-blocks.js"),
		dashboard: await import("../app/(app)/comments/actions.js"),
		page: await import("../app/(app)/comments/page.js"),
		repliesPage: (await import("../app/reader/replies/page.js")).default,
		repliesActions: await import("../app/reader/replies/actions.js"),
		hourly: await import("../app/api/cron/hourly/route.js"),
		Comment: (await import("../models/Comment.js")).default,
		CommentReport: (await import("../models/CommentReport.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
	};
});

after(() => app?.stop());

const api = (user, method, path, body) => callApi(method, `/api/v1${path}`, { key: user.key, body });

function post(user, visitor, fields, issue = user.issue) {
	return inBrowser(visitor, () => m.commentActions.submitComment(null, form({ newsletter: user.slug, p: issue.archiveSlug, ...fields })));
}

async function viewer(user, visitor) {
	return inBrowser(visitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
}

// A newsletter with two readers signed in.
async function setup(email, options) {
	const user = await createPublisher(m, email, options);
	const ana = await addReader(m, user, "ana.lopez@example.org");
	const bea = await addReader(m, user, "bea.king@example.org");
	return { user, ana, bea, anaBrowser: await signInReader(m, user, ana), beaBrowser: await signInReader(m, user, bea) };
}

const ownerEmails = (user, since = 0) => platformEmails.slice(since).filter(({ to }) => to.includes(user.email));

describe("moderating comments", () => {
	test("hiding and removing need a reason, and the author reads it on the page and in an email", async () => {
		const { user, anaBrowser } = await setup("moderate-owner@example.com");
		const posted = await post(user, anaBrowser, { body: "A comment the owner dislikes." });

		const noReason = await api(user, "POST", `/comments/${posted.id}/moderate`, { action: "hide" });
		assert.equal(noReason.status, 400);
		assert.match(noReason.body.error.message, /reason/);
		assert.equal((await api(user, "POST", `/comments/${posted.id}/moderate`, { action: "remove", reason: "   " })).status, 400);
		assert.equal((await api(user, "GET", `/comments/${posted.id}`)).body.status, "published", "nothing changed");

		const before = emailCount();
		const hidden = await api(user, "POST", `/comments/${posted.id}/moderate`, { action: "hide", reason: "Off topic for this thread" });
		await settle();
		assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
		assert.deepEqual([hidden.body.status, hidden.body.reason, hidden.body.decidedBy], ["hidden", "Off topic for this thread", "creator"]);

		const seen = (await viewer(user, anaBrowser)).own.find(({ id }) => id === posted.id);
		assert.deepEqual([seen.status, seen.reason, seen.decidedBy, seen.body], ["hidden", "Off topic for this thread", "creator", "A comment the owner dislikes."]);
		const [email] = emailsTo("ana.lopez@example.org", before);
		assert.ok(email, "the author was emailed");
		assert.match(email.subject, /was hidden/);
		assert.match(email.text, /Their reason: Off topic for this thread/);
		assert.equal(email.headers?.["List-Unsubscribe"], undefined);

		const removed = await api(user, "POST", `/comments/${posted.id}/moderate`, { action: "remove", reason: "Breaks the house rules" });
		await settle();
		assert.deepEqual([removed.body.status, removed.body.reason], ["removed", "Breaks the house rules"]);
		assert.equal((await viewer(user, anaBrowser)).own[0].reason, "Breaks the house rules");
		assert.equal(emailsTo("ana.lopez@example.org", before).length, 2);
		assert.equal((await api(user, "POST", `/comments/${posted.id}/moderate`, { action: "hide", reason: "Again" })).body.error.code, "conflict", "a removed comment isn't hidden");

		const approved = await api(user, "POST", `/comments/${posted.id}/moderate`, { action: "approve" });
		assert.deepEqual([approved.body.status, approved.body.reason], ["published", null]);
		assert.equal((await m.comments.listPublicComments(user.newsletter, user.issue)).total, 1, "back on the page");
	});

	test("shows the owner why a comment is held, and approving it publishes it", async () => {
		const { user, anaBrowser } = await setup("held-moderate-owner@example.com", { comments: { enabled: true, moderation: "hold_links" } });
		const held = await post(user, anaBrowser, { body: "Look: https://example.com/shop" });
		const list = await api(user, "GET", "/comments?status=held");
		assert.equal(list.status, 200, JSON.stringify(list.body));
		assert.equal(list.body.comments.length, 1);
		const [comment] = list.body.comments;
		assert.match(comment.reason, /has a link/);
		assert.equal(comment.decidedBy, "rules");
		assert.equal(comment.author.email, "ana.lopez@example.org", "the owner sees who wrote it");
		assert.equal(comment.url, `https://${user.slug}.flockstackmail.com/p/${user.issue.archiveSlug}#comment-${held.id}`);

		const approved = await api(user, "POST", `/comments/${held.id}/moderate`, { action: "approve" });
		assert.deepEqual([approved.body.status, approved.body.decidedBy], ["published", "creator"]);
		assert.equal((await m.comments.listPublicComments(user.newsletter, user.issue)).total, 1);
		assert.equal((await api(user, "GET", "/comments?status=held")).body.comments.length, 0);
	});

	test("can't bring back a comment its author deleted, and tells another account nothing", async () => {
		const { user, anaBrowser, bea } = await setup("deleted-moderate-owner@example.com");
		const root = await post(user, anaBrowser, { body: "To be deleted." });
		const beaBrowser = await signInReader(m, user, bea);
		await post(user, beaBrowser, { body: "A reply.", parent: root.id });
		await inBrowser(anaBrowser, () => m.commentActions.submitDelete(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: root.id })));
		const conflict = await api(user, "POST", `/comments/${root.id}/moderate`, { action: "approve" });
		assert.equal(conflict.body.error.code, "conflict");
		assert.match(conflict.body.error.message, /author deleted/);

		const stranger = await createPublisher(m, "stranger-owner@example.com");
		assert.equal((await api(stranger, "GET", `/comments/${root.id}`)).status, 404);
		assert.equal((await api(stranger, "POST", `/comments/${root.id}/moderate`, { action: "remove", reason: "Mine now" })).status, 404);
		assert.equal((await api(stranger, "GET", "/comments")).body.comments.length, 0);
	});

	test("hides a comment from the page but not its replies", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("hide-replies-owner@example.com");
		const root = await post(user, anaBrowser, { body: "The thread's start." });
		await post(user, beaBrowser, { body: "A reply that stays.", parent: root.id });
		await api(user, "POST", `/comments/${root.id}/moderate`, { action: "hide", reason: "Not welcome here" });
		const pub = await m.comments.listPublicComments(user.newsletter, user.issue);
		assert.equal(pub.comments[0].isGone, true);
		assert.equal(pub.comments[0].replies[0].body, "A reply that stays.");
	});
});

describe("list_comments and get_comment", () => {
	test("filter by state, reports and issue, page with a cursor, and count each state", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("list-owner@example.com");
		const second = await addIssue(m, user, { subject: "Second issue" });
		const ids = [];
		for (let index = 0; index < 5; index++) ids.push((await post(user, index % 2 ? beaBrowser : anaBrowser, { body: `Comment ${index}` })).id);
		const onSecond = await post(user, anaBrowser, { body: "On the second issue" }, second);
		await api(user, "POST", `/comments/${ids[0]}/moderate`, { action: "hide", reason: "Off topic" });
		await m.CommentReport.create({ accountId: user.accountId, newsletterId: user.newsletterId, campaignId: user.issue._id, commentId: ids[1], reporterId: (await m.Contact.findOne({ accountId: user.accountId, email: "ana.lopez@example.org" }))._id, reason: "Rude", notifyPending: true });
		await m.Comment.updateOne({ accountId: user.accountId, _id: ids[1] }, { $set: { reports: 1 } });

		const all = (await api(user, "GET", "/comments")).body;
		assert.deepEqual(all.counts, { published: 5, held: 0, hidden: 1, removed: 0, reported: 1 });
		assert.equal(all.comments.length, 6);
		assert.equal(all.comments[0].id, onSecond.id, "newest first");
		assert.deepEqual(all.settings, { newsletterId: user.newsletterId, enabled: true, who: "everyone", moderation: "none", notifyOwner: true, hasWebsite: true });

		assert.deepEqual((await api(user, "GET", "/comments?status=hidden")).body.comments.map(({ id }) => id), [ids[0]]);
		assert.deepEqual((await api(user, "GET", "/comments?reported=true")).body.comments.map(({ id }) => id), [ids[1]]);
		assert.equal((await api(user, "GET", `/comments?issue=${second._id}`)).body.comments.length, 1);
		assert.equal((await api(user, "GET", "/comments?issue=nope")).status, 400);

		const first = (await api(user, "GET", "/comments?limit=4")).body;
		assert.equal(first.comments.length, 4);
		assert.ok(first.nextCursor);
		const next = (await api(user, "GET", `/comments?limit=4&cursor=${encodeURIComponent(first.nextCursor)}`)).body;
		assert.equal(next.comments.length, 2);
		assert.equal(next.nextCursor, null);
		assert.equal(new Set([...first.comments, ...next.comments].map(({ id }) => id)).size, 6);

		const one = (await api(user, "GET", `/comments/${ids[1]}`)).body;
		assert.equal(one.reports.length, 1);
		assert.deepEqual([one.reports[0].reason, one.reports[0].status, one.reports[0].reporter.name], ["Rude", "open", "Ana Lopez"]);
		assert.equal(one.replies, 0);
	});

	test("show a reply's parent and settle reports when the owner decides", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("reports-owner@example.com");
		const root = await post(user, anaBrowser, { body: "A question about pricing and plans." });
		const reply = await post(user, beaBrowser, { body: "A rude answer.", parent: root.id });
		const ana = await m.Contact.findOne({ accountId: user.accountId, email: "ana.lopez@example.org" }).lean();
		await inBrowser(anaBrowser, () => m.commentActions.submitReport(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: reply.id, reason: "It is rude" })));
		const detail = (await api(user, "GET", `/comments/${reply.id}`)).body;
		assert.equal(detail.parent.snippet, "A question about pricing and plans.");
		assert.equal(detail.openReports, 1);

		const reports = (await api(user, "GET", "/comments/reports?status=open")).body;
		assert.equal(reports.open, 1);
		assert.deepEqual(reports.reports.map(({ reason, comment, reporter }) => [reason, comment.authorName, reporter.contactId]), [["It is rude", "Bea King", String(ana._id)]]);

		await api(user, "POST", `/comments/${reply.id}/moderate`, { action: "remove", reason: "Rude" });
		const settled = (await api(user, "GET", "/comments/reports")).body;
		assert.equal(settled.open, 0);
		assert.equal(settled.reports[0].status, "actioned");
		assert.equal((await api(user, "GET", `/comments/${reply.id}`)).body.openReports, 0);

		const again = await post(user, beaBrowser, { body: "A kinder answer.", parent: root.id });
		await inBrowser(anaBrowser, () => m.commentActions.submitReport(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: again.id })));
		await api(user, "POST", `/comments/${again.id}/moderate`, { action: "approve" });
		assert.equal((await api(user, "GET", "/comments/reports?status=dismissed")).body.reports.length, 1, "approving dismisses");
	});
});

describe("comment settings", () => {
	test("turn comments on with who and moderation, and take effect on the pages", async () => {
		const user = await createPublisher(m, "settings-owner@example.com", { comments: {} });
		const off = (await api(user, "GET", "/comments")).body.settings;
		assert.deepEqual([off.enabled, off.who, off.moderation, off.notifyOwner], [false, "everyone", "none", true], "off by default");
		const on = await api(user, "PATCH", "/comments/settings", { enabled: true, who: "paid", moderation: "hold_links", notifyOwner: false });
		assert.equal(on.status, 200, JSON.stringify(on.body));
		assert.deepEqual([on.body.enabled, on.body.who, on.body.moderation, on.body.notifyOwner, on.body.issue], [true, "paid", "hold_links", false, null]);
		const kept = await api(user, "PATCH", "/comments/settings", { moderation: "hold_all" });
		assert.deepEqual([kept.body.enabled, kept.body.who, kept.body.moderation], [true, "paid", "hold_all"], "what a change leaves out stays");
		assert.equal((await api(user, "PATCH", "/comments/settings", { who: "nobody" })).status, 400);
	});

	test("need the website, and an issue can differ from the newsletter", async () => {
		const user = await createPublisher(m, "settings-issue-owner@example.com", { comments: {} });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: false } });
		const refused = await api(user, "PATCH", "/comments/settings", { enabled: true });
		assert.equal(refused.status, 400);
		assert.match(refused.body.error.message, /Turn on the newsletter's website first/);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });

		const issueOn = await api(user, "PATCH", "/comments/settings", { campaign: String(user.issue._id), issueComments: "on" });
		assert.deepEqual(issueOn.body.issue, { id: String(user.issue._id), subject: "Sent issue", comments: "on", isOn: true });
		assert.equal(issueOn.body.enabled, false, "the newsletter stays off");
		const paid = await addIssue(m, user, { subject: "For payers", audience: "paid" });
		assert.equal((await api(user, "PATCH", "/comments/settings", { campaign: String(paid._id), issueComments: "on" })).body.issue.isOn, false, "a teaser page has no comments");
		await api(user, "PATCH", "/comments/settings", { enabled: true });
		assert.equal((await api(user, "PATCH", "/comments/settings", { campaign: String(user.issue._id), issueComments: "off" })).body.issue.isOn, false);
		const followed = await api(user, "PATCH", "/comments/settings", { campaign: String(user.issue._id), issueComments: "default" });
		assert.deepEqual([followed.body.issue.comments, followed.body.issue.isOn], [null, true]);
		assert.equal((await api(user, "PATCH", "/comments/settings", { campaign: String(user.issue._id) })).status, 400, "an issue needs its word");
		assert.equal((await api(user, "PATCH", "/comments/settings", { campaign: "6650f1c2e9b1d4a012345678", issueComments: "on" })).status, 404);
	});

	test("can be read by a blocked account but not changed", async () => {
		const user = await createPublisher(m, "settings-blocked-owner@example.com");
		await m.blocks.blockAccount(user.accountId, { reason: "an admin", by: "admin" });
		assert.equal((await api(user, "GET", "/comments")).status, 200);
		assert.equal((await api(user, "PATCH", "/comments/settings", { enabled: false })).body.error.code, "account_blocked");
	});
});

describe("blocking a commenter", () => {
	test("turns commenting off with the owner's reason, shown to the reader, while they stay subscribed", async () => {
		const { user, ana, anaBrowser } = await setup("block-owner@example.com");
		const earlier = await post(user, anaBrowser, { body: "An earlier comment." });
		assert.equal((await api(user, "POST", "/comments/block", { contact: String(ana._id) })).status, 400, "a reason is required");
		const blocked = await api(user, "POST", "/comments/block", { contact: String(ana._id), reason: "Personal attacks in the last thread" });
		assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
		assert.deepEqual([blocked.body.isBlocked, blocked.body.reason, blocked.body.status], [true, "Personal attacks in the last thread", "active"]);

		const refused = await post(user, anaBrowser, { body: "Can I still?" });
		assert.equal(refused.error, "Commenting is turned off for you: Personal attacks in the last thread");
		const state = await viewer(user, anaBrowser);
		assert.equal(state.access.ok, false);
		assert.equal(state.signedIn, true);
		assert.equal((await m.comments.listPublicComments(user.newsletter, user.issue)).total, 1, "their earlier comment stays until the owner decides");
		assert.equal((await api(user, "GET", `/comments/${earlier.id}`)).body.author.isBlocked, true);

		const contact = await m.Contact.findOne({ accountId: user.accountId, _id: ana._id }).lean();
		assert.equal(contact.status, "active");
		const email = m.sendingRules.buildRecipientEmail({ campaign: user.issue, newsletter: user.newsletter, contact });
		assert.match(email.html, /Unsubscribe/, "they still get the newsletter");

		const unblocked = await api(user, "POST", "/comments/unblock", { contact: String(ana._id) });
		assert.deepEqual([unblocked.body.isBlocked, unblocked.body.reason], [false, null]);
		assert.equal((await post(user, anaBrowser, { body: "Back again." })).ok, true);
		assert.equal((await api(user, "POST", "/comments/block", { contact: "6650f1c2e9b1d4a012345678", reason: "x" })).status, 404);
	});
});

describe("the owner's digest", () => {
	test("comes at once for the first comment, then at most once an hour, however many follow", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("digest-owner@example.com");
		const before = platformEmails.length;
		await post(user, anaBrowser, { body: "The first comment." });
		await settle();
		const first = ownerEmails(user, before);
		assert.equal(first.length, 1, "told at once");
		assert.match(first[0].subject, /1 new item to look at on digest-owner news/);
		assert.match(first[0].text, /Ana Lopez on "Sent issue": "The first comment\."/);
		assert.match(first[0].text, /\/comments/);
		assert.doesNotMatch(first[0].text, /example\.org/, "no reader's email");

		for (let index = 0; index < 5; index++) await post(user, index % 2 ? beaBrowser : anaBrowser, { body: `Follow-up number ${index}` });
		await settle();
		assert.equal(ownerEmails(user, before).length, 1, "no storm");
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId, notifyPending: true }), 5);

		const early = await m.notify.sendCommentDigest({ accountId: user.accountId, newsletterId: user.newsletterId, now: new Date(Date.now() + 30 * 60_000) });
		assert.deepEqual(early, { skipped: "sent less than an hour ago" });
		const later = await m.notify.sendCommentDigest({ accountId: user.accountId, newsletterId: user.newsletterId, now: new Date(Date.now() + 61 * 60_000) });
		assert.deepEqual(later, { sent: true, comments: 5, reports: 0 });
		const second = ownerEmails(user, before);
		assert.equal(second.length, 2);
		assert.match(second[1].subject, /5 new items/);
		assert.equal((second[1].text.match(/^- /gm) ?? []).length, 5);
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId, notifyPending: true }), 0);
		assert.deepEqual(await m.notify.sendCommentDigest({ accountId: user.accountId, newsletterId: user.newsletterId, now: new Date(Date.now() + 130 * 60_000) }), { skipped: "nothing new" });
	});

	test("lists held comments with their reasons, and reports with theirs", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("digest-held-owner@example.com", { comments: { enabled: true, moderation: "hold_links" } });
		const before = platformEmails.length;
		const plain = await post(user, beaBrowser, { body: "Plain words." });
		await settle();
		await post(user, anaBrowser, { body: "Visit https://example.com/promo now" });
		await inBrowser(anaBrowser, () => m.commentActions.submitReport(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: plain.id, reason: "Looks like a bot" })));
		await settle();
		const sent = await m.notify.sendCommentDigest({ accountId: user.accountId, newsletterId: user.newsletterId, now: new Date(Date.now() + 61 * 60_000) });
		assert.equal(sent.sent, true);
		const { text } = ownerEmails(user, before).at(-1);
		assert.match(text, /Waiting for your review:/);
		assert.match(text, /Held because: It has a link/);
		assert.match(text, /Reported:/);
		assert.match(text, /Ana Lopez reported Bea King on "Sent issue": "Plain words\."/);
		assert.match(text, /Their reason: Looks like a bot/);
	});

	test("is off when the owner turns it off, and the hourly cron sends what is due", async () => {
		const { user, anaBrowser } = await setup("digest-off-owner@example.com", { comments: { enabled: true, notifyOwner: false } });
		const before = platformEmails.length;
		await post(user, anaBrowser, { body: "Nobody is emailed." });
		await settle();
		assert.equal(ownerEmails(user, before).length, 0);
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId, notifyPending: true }), 0, "nothing piles up");

		const quiet = await setup("digest-cron-owner@example.com");
		await m.Newsletter.updateOne({ accountId: quiet.user.accountId, _id: quiet.user.newsletterId }, { $set: { "comments.digestSentAt": new Date() } });
		const mark = platformEmails.length;
		await post(quiet.user, quiet.anaBrowser, { body: "Posted inside the hour." });
		await settle();
		assert.equal(ownerEmails(quiet.user, mark).length, 0, "an hour hasn't passed");
		const result = await m.notify.sendCommentDigests({ now: new Date(Date.now() + 61 * 60_000) });
		assert.ok(result.sent >= 1, JSON.stringify(result));
		assert.equal(ownerEmails(quiet.user, mark).length, 1);

		process.env.CRON_SECRET = "cron-secret-test";
		const response = await m.hourly.GET(new Request("http://localhost:3000/api/cron/hourly", { headers: { authorization: "Bearer cron-secret-test" } }));
		assert.equal(response.status, 200);
		delete process.env.CRON_SECRET;
	});

	test("waits for the owner's address to be reachable and keeps what it couldn't send", async () => {
		const { user, anaBrowser } = await setup("digest-retry-owner@example.com");
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "comments.digestSentAt": new Date(Date.now() - 2 * 3_600_000) } });
		const failing = globalThis.fetch;
		globalThis.fetch = async (input, init) => (String(input?.url ?? input).includes("api.resend.com") ? new Response("down", { status: 500 }) : failing(input, init));
		const error = console.error;
		console.error = () => {};
		try {
			await post(user, anaBrowser, { body: "While the email service is down." });
			await settle();
		} finally {
			globalThis.fetch = failing;
			console.error = error;
		}
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId, notifyPending: true }), 1, "still waiting");
		assert.equal((await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()).comments.digestSentAt, undefined, "and the hour isn't spent");
		const sent = await m.notify.sendCommentDigest({ accountId: user.accountId, newsletterId: user.newsletterId });
		assert.equal(sent.sent, true);
	});
});

describe("emails about replies", () => {
	const repliesTo = (since) => emailsTo("ana.lopez@example.org", since);

	test("tell the author once, with a link back and a way to stop them", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("reply-mail-owner@example.com");
		const root = await post(user, anaBrowser, { body: "Does anyone know?" });
		const before = emailCount();
		const reply = await post(user, beaBrowser, { body: "I do.", parent: root.id });
		await settle();
		const [email] = repliesTo(before);
		assert.ok(email, "Ana was told");
		assert.equal(email.subject, "Bea King replied to your comment");
		assert.equal(email.headers?.["List-Unsubscribe"], undefined);
		assert.doesNotMatch(email.text, /I do\./, "the reply's words aren't copied into the email");
		assert.match(email.text, /Stop emails about replies/);
		const read = /(https:\/\/[^\s)"<]+\/reader\/in\?[^\s)"<]+)/.exec(email.html.replaceAll("&amp;", "&"))[1];
		assert.equal(new URL(read).searchParams.get("c"), reply.id);

		await m.notify.notifyReply({ newsletter: user.newsletter, campaign: user.issue, comment: await m.Comment.findOne({ accountId: user.accountId, _id: reply.id }).lean() });
		assert.equal(repliesTo(before).length, 1, "once per reply");
		assert.ok((await m.Comment.findOne({ accountId: user.accountId, _id: reply.id }).lean()).replyNotifiedAt);
	});

	test("don't go to someone replying to themselves, a deleted reader, or a reader who turned them off", async () => {
		const { user, ana, anaBrowser, beaBrowser } = await setup("reply-mail-skip-owner@example.com");
		const root = await post(user, anaBrowser, { body: "A thread." });
		const before = emailCount();
		await post(user, anaBrowser, { body: "Replying to myself.", parent: root.id });
		await settle();
		assert.equal(repliesTo(before).length, 0);

		const view = (token) => inBrowser(browser(), () => m.repliesPage({ searchParams: Promise.resolve({ token }) }));
		const page = await view(m.links.createReaderToken("replies", { contactId: ana._id, newsletterId: user.newsletterId }));
		assert.match(JSON.stringify(page), /Stop emails about replies/);
		const token = m.links.createReaderToken("replies", { contactId: ana._id, newsletterId: user.newsletterId });
		await inBrowser(browser(), () => m.repliesActions.setReplyEmails(form({ token })));
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: ana._id }).lean()).community.repliesOff, true);
		const off = await view(token);
		assert.match(JSON.stringify(off), /Reply emails are off/);
		assert.match(JSON.stringify(off), /Turn them back on/);
		await post(user, beaBrowser, { body: "Nobody emails Ana.", parent: root.id });
		await settle();
		assert.equal(repliesTo(before).length, 0, "turned off");
		const stranger = await view(`${token}x`);
		assert.match(JSON.stringify(stranger), /This link doesn&#x27;t work|This link doesn't work/);
		await inBrowser(browser(), () => m.repliesActions.setReplyEmails(form({ token, emails: "on" })));
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: ana._id }).lean()).community.repliesOff, undefined);
		await post(user, beaBrowser, { body: "Now Ana hears.", parent: root.id });
		await settle();
		assert.equal(repliesTo(before).length, 1);
	});

	test("follow the sending rules: nothing for a suppressed address or a blocked account", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("reply-mail-rules-owner@example.com");
		const root = await post(user, anaBrowser, { body: "Another thread." });
		const before = emailCount();
		await m.Suppression.create({ accountId: user.accountId, email: "ana.lopez@example.org", reason: "bounce" });
		await post(user, beaBrowser, { body: "Reply one.", parent: root.id });
		await settle();
		assert.equal(repliesTo(before).length, 0, "suppressed");
		await m.Suppression.deleteMany({ accountId: user.accountId });
		await m.blocks.blockAccount(user.accountId, { reason: "an admin", by: "admin" });
		await post(user, beaBrowser, { body: "Reply two.", parent: root.id });
		await settle();
		assert.equal(repliesTo(before).length, 0, "blocked account");
	});

	test("are limited to three a day for one reader, and a held reply is told when it's approved", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("reply-mail-limit-owner@example.com");
		const root = await post(user, anaBrowser, { body: "A popular thread." });
		const before = emailCount();
		for (let index = 0; index < 5; index++) {
			await post(user, beaBrowser, { body: `Reply number ${index}`, parent: root.id });
			await settle();
		}
		assert.equal(repliesTo(before).length, 3, "three a day, then quiet");
		const rest = await m.Comment.find({ accountId: user.accountId, parentId: root.id, replyNotifiedAt: { $exists: true } }).lean();
		assert.equal(rest.length, 5, "each reply is counted once");

		const held = await setup("reply-mail-held-owner@example.com", { comments: { enabled: true, moderation: "hold_all" } });
		const top = await m.Comment.create({ accountId: held.user.accountId, newsletterId: held.user.newsletterId, campaignId: held.user.issue._id, authorId: held.ana._id, authorName: "Ana Lopez", body: "Published long ago.", status: "published" });
		const mark = emailCount();
		const waiting = await post(held.user, held.beaBrowser, { body: "A held reply.", parent: String(top._id) });
		await settle();
		assert.equal(waiting.status, "held");
		assert.equal(repliesTo(mark).length, 0, "not told of a reply nobody can see");
		await callApi("POST", `/api/v1/comments/${waiting.id}/moderate`, { key: held.user.key, body: { action: "approve" } });
		await settle();
		assert.equal(repliesTo(mark).length, 1, "told on approval");
	});
});

describe("the dashboard", () => {
	async function render(user, searchParams = {}) {
		const element = await as(user, () => m.page.default({ searchParams: Promise.resolve(searchParams) }));
		return renderToStaticMarkup(createElement(m.TooltipProvider, null, element));
	}

	test("lists comments with filters, reasons and the settings, and its actions run the same actions", async () => {
		const { user, anaBrowser, beaBrowser } = await setup("dashboard-owner@example.com", { comments: { enabled: true, moderation: "hold_links" } });
		await post(user, anaBrowser, { body: "Plain comment on the page." });
		const held = await post(user, beaBrowser, { body: "Held: https://example.com/x" });
		await as(user, () => m.dashboard.saveCommentSettings({ newsletterId: user.newsletterId, enabled: true, who: "everyone", moderation: "hold_links", notifyOwner: true }));

		const html = await render(user);
		assert.match(html, /Plain comment on the page\./);
		assert.match(html, /Waiting for you/);
		assert.match(html, /It has a link, and this newsletter reviews comments with links/);
		assert.match(html, /bea\.king@example\.org/, "the owner sees the address");
		assert.match(html, /Sent issue/);
		assert.match(html, /aria-label="Comments on Sent issue"/);
		const filtered = await render(user, { filter: "held" });
		assert.match(filtered, /Held: https:\/\/example\.com\/x/);
		assert.doesNotMatch(filtered, /Plain comment on the page\./);
		assert.match(await render(user, { filter: "hidden" }), /Nothing here/);

		assert.deepEqual(await as(user, () => m.dashboard.decideComment({ id: held.id, action: "hide", reason: "" })).then(({ error }) => Boolean(error)), true, "a reason is needed");
		assert.deepEqual(await as(user, () => m.dashboard.decideComment({ id: held.id, action: "hide", reason: "Spammy link" })), { ok: true });
		assert.equal((await m.Comment.findOne({ accountId: user.accountId, _id: held.id }).lean()).reason, "Spammy link");
		const bea = await m.Contact.findOne({ accountId: user.accountId, email: "bea.king@example.org" }).lean();
		assert.deepEqual(await as(user, () => m.dashboard.blockReader({ contactId: String(bea._id), reason: "Spam" })), { ok: true });
		assert.deepEqual(await as(user, () => m.dashboard.unblockReader({ contactId: String(bea._id) })), { ok: true });
		assert.deepEqual(await as(user, () => m.dashboard.setIssueComments({ newsletterId: user.newsletterId, campaignId: String(user.issue._id), mode: "off" })), { ok: true });
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean()).comments, "off");
		const empty = await render((await createPublisher(m, "dashboard-empty@example.com")));
		assert.match(empty, /No comments yet/);
	});
});
