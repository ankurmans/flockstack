import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { form, startTestApp } from "./helpers/app.mjs";
import { addIssue, addReader, browser, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";

let app;
let m;
const DAY_MS = 86_400_000;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		comments: await import("../lib/comments.js"),
		body: await import("../lib/comment-body.js"),
		Comment: (await import("../models/Comment.js")).default,
		CommentReport: (await import("../models/CommentReport.js")).default,
	};
});

after(() => app?.stop());

// A newsletter with its issue and a reader signed in, who comments through the form's server action.
async function setup(email, options) {
	const user = await createPublisher(m, email, options);
	const reader = await addReader(m, user, "ana.lopez@example.org");
	const visitor = await signInReader(m, user, reader);
	return { user, reader, visitor };
}

function submit(user, visitor, fields, issue = user.issue) {
	return inBrowser(visitor, () => m.commentActions.submitComment(null, form({ newsletter: user.slug, p: issue.archiveSlug, ...fields })));
}

function stored(user, id) {
	return m.Comment.findOne({ accountId: user.accountId, _id: id }).lean();
}

describe("writing a comment", () => {
	test("goes up under a name that isn't the email, and the first comment sets the name for good", async () => {
		const { user, reader, visitor } = await setup("write-owner@example.com");
		const state = await inBrowser(visitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
		assert.equal(state.signedIn, true);
		assert.equal(state.name.suggested, "Ana Lopez");
		assert.equal(state.name.isLocked, false);

		const first = await submit(user, visitor, { body: "Loved the part about pricing.\nMore of this please.", name: "Ana L" });
		assert.equal(first.ok, true, JSON.stringify(first));
		assert.equal(first.status, "published");
		const comment = await stored(user, first.id);
		assert.equal(comment.authorName, "Ana L");
		assert.equal(String(comment.authorId), String(reader._id));
		assert.ok(!JSON.stringify(comment).includes("example.org"), "the comment holds no email");
		const contact = await m.Contact.findOne({ accountId: user.accountId, _id: reader._id }).lean();
		assert.deepEqual([contact.community.displayName, contact.community.nameLocked], ["Ana L", true]);

		const second = await submit(user, visitor, { body: "One more thing.", name: "Somebody Else" });
		assert.equal((await stored(user, second.id)).authorName, "Ana L", "the name can't be changed after the first comment");
		const after = await inBrowser(visitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
		assert.equal(after.name.isLocked, true);
		assert.deepEqual(after.own.map(({ status }) => status), ["published", "published"]);
	});

	test("defaults to the part of the address before the @ when the reader keeps the suggestion", async () => {
		const { user, visitor } = await setup("default-name-owner@example.com");
		const posted = await submit(user, visitor, { body: "Hello", name: "" });
		assert.equal((await stored(user, posted.id)).authorName, "Ana Lopez");
	});

	test("takes one level of replies", async () => {
		const { user, visitor } = await setup("reply-owner@example.com");
		const root = await submit(user, visitor, { body: "A question." });
		const reply = await submit(user, visitor, { body: "An answer.", parent: root.id });
		assert.equal(reply.ok, true);
		assert.equal(String((await stored(user, reply.id)).parentId), root.id);
		const deeper = await submit(user, visitor, { body: "A reply to the reply.", parent: reply.id });
		assert.equal(deeper.code, "no_parent");
		const missing = await submit(user, visitor, { body: "Nowhere.", parent: "6650f1c2e9b1d4a012345678" });
		assert.equal(missing.code, "no_parent");
		assert.equal((await submit(user, visitor, { body: "Junk.", parent: "not-an-id" })).code, "no_parent");
	});

	test("needs words, within the length and link limits, and a name that isn't an address", async () => {
		const { user, visitor } = await setup("rules-owner@example.com");
		assert.match((await submit(user, visitor, { body: "   " })).error, /Write a comment/);
		assert.match((await submit(user, visitor, { body: "x".repeat(4001) })).error, /up to 4,000 characters/);
		assert.match((await submit(user, visitor, { body: "a https://a.test b https://b.test c https://c.test d https://d.test" })).error, /up to 3 links/);
		assert.match((await submit(user, visitor, { body: "Hi", name: "ana@example.org" })).error, /letters, numbers/);
		const unnamed = await m.Contact.findOne({ accountId: user.accountId, email: "ana.lopez@example.org" }).lean();
		assert.equal(unnamed.community?.nameLocked, undefined, "a refused name locks nothing");
		const three = await submit(user, visitor, { body: "a https://a.test b https://b.test c [c](https://c.test)", name: "Ana" });
		assert.equal(three.ok, true, JSON.stringify(three));
	});

	test("is refused to a visitor with no session, and to one whose newsletter or issue isn't there", async () => {
		const { user } = await setup("anon-owner@example.com");
		const stranger = browser();
		const refused = await submit(user, stranger, { body: "Hi" });
		assert.equal(refused.code, "signed-out");
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId }), 0);
		const { visitor } = await setup("anon-other@example.com");
		assert.equal((await inBrowser(visitor, () => m.commentActions.submitComment(null, form({ newsletter: "no-such", p: "x", body: "Hi" })))).code, "off");
	});

	test("notices a repeat of the same words", async () => {
		const { user, visitor } = await setup("dup-owner@example.com");
		assert.equal((await submit(user, visitor, { body: "Same words here." })).ok, true);
		assert.equal((await submit(user, visitor, { body: "  same   WORDS here. " })).code, "duplicate");
		const other = await addIssue(m, user, { subject: "Another" });
		assert.equal((await submit(user, visitor, { body: "Same words here." }, other)).ok, true, "on another issue it is new");
	});
});

describe("who can comment", () => {
	test("not a reader who left, and a blocked one is told the owner's reason", async () => {
		const user = await createPublisher(m, "left-comments@example.com");
		for (const status of ["unsubscribed", "bounced", "complained"]) {
			const reader = await addReader(m, user, `${status}@example.org`);
			const visitor = await signInReader(m, user, reader);
			await m.Contact.updateOne({ accountId: user.accountId, _id: reader._id }, { $set: { status } });
			const refused = await submit(user, visitor, { body: "Still here?" });
			assert.equal(refused.code, "signed-out", `${status}: no session any more`);
		}
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId }), 0);

		const blocked = await addReader(m, user, "blocked@example.org", { community: { blocked: true, blockedReason: "Personal attacks in earlier threads" } });
		const visitor = await signInReader(m, user, blocked);
		const refused = await submit(user, visitor, { body: "May I?" });
		assert.equal(refused.code, "blocked");
		assert.equal(refused.error, "Commenting is turned off for you: Personal attacks in earlier threads");
		const state = await inBrowser(visitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
		assert.deepEqual([state.signedIn, state.access.ok, state.access.code], [true, false, "blocked"]);
		const contact = await m.Contact.findOne({ accountId: user.accountId, _id: blocked._id }).lean();
		assert.equal(contact.status, "active", "blocking leaves the subscription alone");
	});

	test("everyone subscribed, or paid subscribers only", async () => {
		const user = await createPublisher(m, "who-owner@example.com", { comments: { enabled: true, who: "paid" } });
		const free = await addReader(m, user, "free@example.org");
		const payer = await addReader(m, user, "payer@example.org", { tier: "paid", paidUntil: new Date(Date.now() + 30 * DAY_MS) });
		const lapsed = await addReader(m, user, "lapsed@example.org", { tier: "paid", paidUntil: new Date(Date.now() - 10 * DAY_MS) });
		const freeVisitor = await signInReader(m, user, free);
		const refused = await submit(user, freeVisitor, { body: "Free reader here." });
		assert.deepEqual([refused.code, refused.error], ["paid-only", "Comments on this newsletter are for paid subscribers."]);
		assert.equal((await submit(user, await signInReader(m, user, payer), { body: "Paying reader here." })).ok, true);
		assert.equal((await submit(user, await signInReader(m, user, lapsed), { body: "Lapsed." })).code, "paid-only", "a paid tier that ran out counts as free");

		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "comments.who": "everyone" } });
		assert.equal((await submit(user, freeVisitor, { body: "Free reader, now allowed." })).ok, true);
	});

	test("only where the newsletter or the issue has comments on", async () => {
		const user = await createPublisher(m, "switch-owner@example.com", { comments: { enabled: false } });
		const reader = await addReader(m, user, "reader@example.org");
		const visitor = await signInReader(m, user, reader);
		assert.equal((await submit(user, visitor, { body: "Anyone?" })).code, "off");
		const opened = await addIssue(m, user, { subject: "Open for discussion", comments: "on" });
		assert.equal((await submit(user, visitor, { body: "Yes." }, opened)).ok, true);

		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "comments.enabled": true } });
		assert.equal((await submit(user, visitor, { body: "On for all." })).ok, true);
		const closed = await addIssue(m, user, { subject: "Closed", comments: "off" });
		assert.equal((await submit(user, visitor, { body: "Not here." }, closed)).code, "off");
		const paidOnly = await addIssue(m, user, { subject: "Paid issue", audience: "paid", comments: "on" });
		assert.equal((await submit(user, visitor, { body: "Teaser page." }, paidOnly)).code, "off", "a teaser page shows no comments");
	});
});

describe("the newsletter's moderation setting", () => {
	test("none publishes, hold links holds comments with a link, hold all holds every comment, each with its reason", async () => {
		const { user, visitor } = await setup("moderation-owner@example.com");
		const withLink = "Worth a look: https://example.com/post";
		const plain = "No links here.";
		const outcome = async (body) => {
			const result = await submit(user, visitor, { body });
			return [result.status, result.reason];
		};
		assert.deepEqual(await outcome(plain), ["published", null]);
		assert.deepEqual(await outcome(withLink), ["published", null]);

		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "comments.moderation": "hold_links" } });
		assert.deepEqual(await outcome("Different plain words."), ["published", null]);
		const [status, reason] = await outcome("Another: https://example.com/other");
		assert.equal(status, "held");
		assert.match(reason, /has a link/);

		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "comments.moderation": "hold_all" } });
		const [allStatus, allReason] = await outcome("Even plain words wait.");
		assert.equal(allStatus, "held");
		assert.match(allReason, /reviews every comment/);

		const held = await m.Comment.find({ accountId: user.accountId, status: "held" }).lean();
		assert.equal(held.length, 2);
		assert.ok(held.every((comment) => comment.reason && comment.decidedBy === "rules" && comment.notifyPending));
	});

	test("shows the writer a held comment and why, and shows everyone else nothing of it", async () => {
		const { user, visitor } = await setup("held-owner@example.com", { comments: { enabled: true, moderation: "hold_all" } });
		const held = await submit(user, visitor, { body: "Waiting for the owner." });
		const state = await inBrowser(visitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
		const own = state.own.find(({ id }) => id === held.id);
		assert.deepEqual([own.status, own.body], ["held", "Waiting for the owner."]);
		assert.match(own.reason, /reviews every comment/);
		const pub = await m.comments.listPublicComments(user.newsletter, user.issue);
		assert.equal(pub.total, 0);
		assert.deepEqual(pub.comments, []);
	});
});

describe("changing and deleting your own", () => {
	const edit = (user, visitor, comment, body) =>
		inBrowser(visitor, () => m.commentActions.submitEdit(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment, body })));
	const remove = (user, visitor, comment) =>
		inBrowser(visitor, () => m.commentActions.submitDelete(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment })));

	test("an edit within 15 minutes marks the comment edited; later it's refused", async () => {
		const { user, visitor } = await setup("edit-owner@example.com");
		const posted = await submit(user, visitor, { body: "First draft." });
		const state = await inBrowser(visitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
		assert.ok(new Date(state.own[0].editableUntil) - Date.now() > 14 * 60_000, "the window is about 15 minutes");

		assert.deepEqual(await edit(user, visitor, posted.id, "Second draft."), { ok: true, status: "published" });
		const comment = await stored(user, posted.id);
		assert.deepEqual([comment.body, comment.edited], ["Second draft.", true]);
		assert.ok(comment.editedAt);

		await m.Comment.updateOne({ accountId: user.accountId, _id: posted.id }, { $set: { createdAt: new Date(Date.now() - 16 * 60_000) } });
		const late = await edit(user, visitor, posted.id, "Third draft.");
		assert.equal(late.code, "edit_window");
		assert.equal((await stored(user, posted.id)).body, "Second draft.");
		const after = await inBrowser(visitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
		assert.equal(after.own[0].editableUntil, null);
	});

	test("an edit is judged by the rules again, so a link added later is held", async () => {
		const { user, visitor } = await setup("edit-rules-owner@example.com", { comments: { enabled: true, moderation: "hold_links" } });
		const posted = await submit(user, visitor, { body: "Plain at first." });
		assert.equal(posted.status, "published");
		assert.deepEqual(await edit(user, visitor, posted.id, "Now with https://example.com/promo"), { ok: true, status: "held" });
		const comment = await stored(user, posted.id);
		assert.deepEqual([comment.status, comment.decidedBy, comment.notifyPending], ["held", "rules", true]);
		assert.match(comment.reason, /has a link/);
		assert.deepEqual(await edit(user, visitor, posted.id, "Link removed again."), { ok: true, status: "published" });
		assert.equal((await stored(user, posted.id)).reason, undefined);
	});

	test("nobody edits or deletes another reader's comment", async () => {
		const { user, visitor } = await setup("others-owner@example.com");
		const mine = await submit(user, visitor, { body: "Mine." });
		const other = await signInReader(m, user, await addReader(m, user, "other@example.org"));
		assert.equal((await edit(user, other, mine.id, "Hijacked.")).code, "not_found");
		assert.equal((await remove(user, other, mine.id)).code, "not_found");
		assert.equal((await stored(user, mine.id)).body, "Mine.");
	});

	test("deleting erases the words; a comment with replies stays as a note", async () => {
		const { user, visitor } = await setup("delete-owner@example.com");
		const lone = await submit(user, visitor, { body: "Gone soon." });
		assert.deepEqual(await remove(user, visitor, lone.id), { ok: true });
		assert.equal(await stored(user, lone.id), null);

		const root = await submit(user, visitor, { body: "A thread starter." });
		const friend = await signInReader(m, user, await addReader(m, user, "friend@example.org"));
		await submit(user, friend, { body: "I replied.", parent: root.id });
		assert.deepEqual(await remove(user, visitor, root.id), { ok: true });
		const note = await stored(user, root.id);
		assert.deepEqual([note.status, note.body, note.decidedBy, note.bodyHash], ["removed", "", "author", undefined]);
		const pub = await m.comments.listPublicComments(user.newsletter, user.issue);
		assert.equal(pub.comments.length, 1);
		assert.equal(pub.comments[0].isGone, true);
		assert.equal(pub.comments[0].replies[0].body, "I replied.");
		assert.equal(pub.comments[0].body, undefined);
	});

	test("deleting works after the reader has been blocked or comments were closed", async () => {
		const { user, reader, visitor } = await setup("delete-closed-owner@example.com");
		const posted = await submit(user, visitor, { body: "Before the block." });
		await m.Contact.updateOne({ accountId: user.accountId, _id: reader._id }, { $set: { "community.blocked": true, "community.blockedReason": "Spam" } });
		assert.deepEqual(await remove(user, visitor, posted.id), { ok: true });
	});
});

describe("what everyone reads", () => {
	test("is the published comments in order with replies under them, and never an email or a reader's ID", async () => {
		const { user, visitor } = await setup("public-owner@example.com");
		const bea = await signInReader(m, user, await addReader(m, user, "bea.king@example.org"));
		const one = await submit(user, visitor, { body: "First." });
		const two = await submit(user, bea, { body: "Second." });
		await submit(user, bea, { body: "A reply.", parent: one.id });
		await submit(user, visitor, { body: "Another reply.", parent: one.id });
		const pub = await m.comments.listPublicComments(user.newsletter, user.issue);
		assert.equal(pub.total, 4);
		assert.deepEqual(pub.comments.map(({ body }) => body), ["First.", "Second."]);
		assert.deepEqual(pub.comments[0].replies.map(({ body, authorName }) => [body, authorName]), [["A reply.", "Bea King"], ["Another reply.", "Ana Lopez"]]);
		assert.equal(pub.comments[1].id, two.id);
		const text = JSON.stringify(pub);
		assert.ok(!text.includes("example.org") && !/authorId|email|contact/i.test(text), text);

		await m.Comment.updateOne({ accountId: user.accountId, _id: one.id }, { $set: { status: "hidden", reason: "Off topic" } });
		const hidden = await m.comments.listPublicComments(user.newsletter, user.issue);
		assert.equal(hidden.comments[0].isGone, true, "a hidden comment with replies is a note");
		assert.equal(hidden.comments[0].authorName, undefined);
		assert.equal(hidden.comments[0].replies.length, 2);
		assert.ok(!JSON.stringify(hidden).includes("Off topic"), "the reason is for the author and the owner");
	});
});

describe("reports", () => {
	const report = (user, visitor, comment, reason = "") =>
		inBrowser(visitor, () => m.commentActions.submitReport(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment, reason })));

	test("a subscriber reports once with an optional reason, and nothing happens to the comment", async () => {
		const { user, visitor } = await setup("report-owner@example.com");
		const bea = await addReader(m, user, "bea@example.org");
		const beaVisitor = await signInReader(m, user, bea);
		const posted = await submit(user, visitor, { body: "Questionable." });
		assert.deepEqual(await report(user, beaVisitor, posted.id, "It is spam"), { ok: true });
		assert.deepEqual(await report(user, beaVisitor, posted.id), { ok: true }, "a second report is quietly one");
		const comment = await stored(user, posted.id);
		assert.deepEqual([comment.status, comment.reports], ["published", 1]);
		const reports = await m.CommentReport.find({ accountId: user.accountId }).lean();
		assert.equal(reports.length, 1);
		assert.deepEqual([reports[0].reason, reports[0].status], ["It is spam", "open"]);
		const state = await inBrowser(beaVisitor, () => m.commentActions.getViewer(user.slug, user.issue.archiveSlug));
		assert.deepEqual(state.reported, [posted.id]);

		assert.equal((await report(user, visitor, posted.id)).code, "own", "not your own comment");
		assert.equal((await report(user, browser(), posted.id)).code, "signed-out");
		const another = await submit(user, visitor, { body: "Reported with no reason." });
		assert.equal((await report(user, beaVisitor, another.id)).ok, true);
		assert.equal((await m.CommentReport.findOne({ accountId: user.accountId, commentId: another.id }).lean()).reason, undefined);
	});

	test("only a published comment can be reported", async () => {
		const { user, visitor } = await setup("report-held-owner@example.com", { comments: { enabled: true, moderation: "hold_all" } });
		const bea = await signInReader(m, user, await addReader(m, user, "bea@example.org"));
		const held = await submit(user, visitor, { body: "Held." });
		assert.equal((await report(user, bea, held.id)).code, "not_found");
	});
});

describe("spam defenses", () => {
	test("a reader can post six comments in ten minutes, then waits", async () => {
		const { user, visitor } = await setup("rate-owner@example.com");
		const results = [];
		for (let index = 0; index < 8; index++) results.push(await submit(user, visitor, { body: `Comment number ${index}` }));
		assert.deepEqual(results.map(({ ok }) => Boolean(ok)), [true, true, true, true, true, true, false, false]);
		assert.equal(results[6].code, "rate_limited");
		assert.match(results[6].error, /Try again in a few minutes/);
	});

	test("a network can post 20 comments an hour, whoever the readers are", async () => {
		const user = await createPublisher(m, "ip-owner@example.com");
		const shared = browser();
		const results = [];
		for (let index = 0; index < 22; index++) {
			const reader = await addReader(m, user, `reader${index}@example.org`);
			const visitor = await signInReader(m, user, reader);
			visitor.ip = shared.ip;
			results.push(await submit(user, visitor, { body: `From reader ${index}` }));
		}
		assert.equal(results.filter(({ ok }) => ok).length, 20);
		assert.equal(results[20].code, "rate_limited");
	});

	test("the hidden field catches a bot: it is told it worked and nothing is stored", async () => {
		const { user, visitor } = await setup("honeypot-owner@example.com");
		const result = await submit(user, visitor, { body: "Buy now https://spam.test", website: "https://spam.test" });
		assert.equal(result.ok, true);
		assert.equal(await m.Comment.countDocuments({ accountId: user.accountId }), 0);
	});
});

describe("a comment's text", () => {
	test("is plain text: markup is kept as typed, only http and https links are links", () => {
		const parts = m.body.parseCommentBody("Hi <script>alert(1)</script> <b>bold</b>\nsee https://example.com/a?b=1, and [my site](https://example.org) or [x](javascript:alert(1)) or data:text/html,<p>x</p>").flat();
		const links = parts.filter(({ type }) => type === "link");
		assert.deepEqual(links.map(({ href, text }) => [href, text]), [["https://example.com/a?b=1", "https://example.com/a?b=1"], ["https://example.org/", "my site"]]);
		const text = parts.filter(({ type }) => type === "text").map(({ text }) => text).join("");
		assert.match(text, /<script>alert\(1\)<\/script> <b>bold<\/b>/, "markup stays text");
		assert.match(text, /\[x\]\(javascript:alert\(1\)\)/, "a javascript link isn't one");
		assert.equal(parts.filter(({ type }) => type === "br").length, 1);
	});

	test("never links an address with a name in front of the host, and shows the real address behind address-like words", () => {
		const parts = m.body.parseCommentBody("https://bank.example@evil.test/login and [https://bank.example](https://evil.test/x) and [www.bank.example/login](https://evil.test/y) and [read this](https://fine.test)").flat();
		const links = parts.filter(({ type }) => type === "link");
		assert.deepEqual(links.map(({ href, text }) => [href, text]), [["https://evil.test/x", "https://evil.test/x"], ["https://evil.test/y", "https://evil.test/y"], ["https://fine.test/", "read this"]]);
	});

	test("loses control and invisible characters and keeps paragraphs", () => {
		const { body } = m.body.cleanCommentBody("Line one\u0000​ with‮ hidden\r\n\r\n\r\n\r\nParagraph two  \n");
		assert.equal(body, "Line one with hidden\n\nParagraph two");
	});
});
