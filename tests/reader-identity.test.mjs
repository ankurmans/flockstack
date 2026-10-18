import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { catchRedirect, form, startTestApp } from "./helpers/app.mjs";
import { addReader, browser, createPublisher, emailCount, emailsTo, importModels, inBrowser, settle, signInReader } from "./helpers/community.mjs";

let app;
let m;
const DAY_MS = 86_400_000;
const sampleReference = { contactId: "6650f1c2e9b1d4a012345678", newsletterId: "6650f1c2e9b1d4a0aaaaaaaa" };

before(async () => {
	app = await startTestApp();
	m = await importModels();
});

after(() => app?.stop());

describe("reader tokens", () => {
	test("each kind of link opens only its own door and expires on its own clock", () => {
		const { createReaderToken, verifyReaderToken } = m.links;
		const now = Date.now();
		for (const kind of ["email", "signin", "session", "replies"]) {
			const token = createReaderToken(kind, sampleReference, now);
			assert.deepEqual(verifyReaderToken(kind, token, now + 1000), sampleReference, kind);
			for (const other of ["email", "signin", "session", "replies"].filter((name) => name !== kind)) {
				assert.equal(verifyReaderToken(other, token, now + 1000), null, `${kind} link as ${other}`);
			}
			assert.equal(verifyReaderToken(kind, `${token}x`, now + 1000), null, "altered");
		}
		const email = createReaderToken("email", sampleReference, now);
		assert.ok(m.links.verifyReaderToken("email", email, now + 44 * DAY_MS), "an email link lasts weeks");
		assert.equal(m.links.verifyReaderToken("email", email, now + 46 * DAY_MS), null, "and then expires");
		const signin = createReaderToken("signin", sampleReference, now);
		assert.ok(m.links.verifyReaderToken("signin", signin, now + 29 * 60_000));
		assert.equal(m.links.verifyReaderToken("signin", signin, now + 31 * 60_000), null, "a sign-in link lasts minutes");
		const session = createReaderToken("session", sampleReference, now);
		assert.equal(m.links.verifyReaderToken("session", session, now + 31 * DAY_MS), null);
	});

	test("links live on the newsletter's own host and carry only a token and an issue's path", () => {
		const url = new URL(m.links.getEmailCommentUrl(sampleReference, { slug: "weekly" }, { issueSlug: "first-issue" }));
		assert.equal(url.origin, `https://weekly.flockstackmail.com`);
		assert.equal(url.pathname, "/reader/in");
		assert.deepEqual([...url.searchParams.keys()].sort(), ["p", "token"]);
		assert.equal(url.searchParams.get("p"), "first-issue");
		const own = new URL(m.links.getSignInUrl(sampleReference, { slug: "weekly", archiveHost: "news.example.com" }, { issueSlug: "../../etc" }));
		assert.equal(own.origin, "https://news.example.com");
		assert.equal(own.searchParams.get("p"), null, "an issue path that isn't one is left out");
	});
});

describe("display names", () => {
	test("start from the part of the address before the @, never the domain", () => {
		const { deriveDisplayName } = m.rules;
		assert.equal(deriveDisplayName("ana.lopez@example.com"), "Ana Lopez");
		assert.equal(deriveDisplayName("ana_lopez+news@example.com"), "Ana Lopez");
		assert.equal(deriveDisplayName("kim1987@mail.example.org"), "Kim");
		assert.equal(deriveDisplayName("42@example.com"), "Reader");
		assert.doesNotMatch(deriveDisplayName("dana@example.com"), /example|@|\./);
	});

	test("can't carry an address or a link, or pass for the newsletter", () => {
		const { normalizeDisplayName } = m.rules;
		const newsletter = { name: "Field Notes", fromName: "Dana Reyes" };
		assert.deepEqual(normalizeDisplayName("  Sam   Lee ", newsletter), { name: "Sam Lee" });
		for (const bad of ["a", "sam@example.com", "https://x.test", "<b>Sam</b>", "x".repeat(41), "field notes", "DANA REYES"]) {
			assert.ok(normalizeDisplayName(bad, newsletter).problem, bad);
		}
	});
});

describe("the link in a newsletter's email", () => {
	test("signs a subscriber in for this newsletter and lands on the issue's comments", async () => {
		const user = await createPublisher(m, "link-owner@example.com");
		const ann = await addReader(m, user, "ann@example.org");
		const visitor = await signInReader(m, user, ann);
		assert.ok(visitor.jar.get(m.links.readerCookieName(user.slug)), "a session cookie");
		assert.equal(visitor.jar.get(m.links.readerMarkerName(user.slug)), "1", "and the marker the page reads");
		const reader = await inBrowser(visitor, () => m.session.findSessionReader(user.newsletter));
		assert.equal(String(reader._id), String(ann._id));

		const url = m.links.getEmailCommentUrl({ contactId: ann._id, newsletterId: user.newsletterId }, user.newsletter, { issueSlug: user.issue.archiveSlug });
		const response = await inBrowser(browser(), () => m.readerIn.GET(new m.NextRequest(url)));
		const location = new URL(response.headers.get("location"));
		assert.equal(location.pathname, `/p/${user.issue.archiveSlug}`);
		assert.equal(location.host, `${user.slug}.flockstackmail.com`);
		assert.equal(location.hash, "#comments");
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(location.search, "", "the token doesn't stay in the address bar");
	});

	test("does nothing for an expired, altered or other newsletter's link", async () => {
		const user = await createPublisher(m, "expired-owner@example.com");
		const other = await createPublisher(m, "other-owner@example.com");
		const ann = await addReader(m, user, "ann@example.org");
		const makeUrl = (token) => `http://localhost:3000/reader/in?token=${token}&p=${user.issue.archiveSlug}`;

		const old = m.links.createReaderToken("email", { contactId: ann._id, newsletterId: user.newsletterId }, Date.now() - 46 * DAY_MS);
		const altered = `${m.links.createReaderToken("email", { contactId: ann._id, newsletterId: user.newsletterId })}x`;
		for (const token of [old, altered, "nonsense", ""]) {
			const visitor = browser();
			const response = await inBrowser(visitor, () => m.readerIn.GET(new m.NextRequest(makeUrl(token))));
			assert.equal(response.status, 303);
			assert.equal(visitor.jar.size, 0, "no session");
			assert.match(response.headers.get("location"), /#comments-expired$/);
		}

		// A real link of one newsletter, read as a session of another, opens nothing there.
		const visitor = await signInReader(m, user, ann);
		const asOther = await inBrowser(visitor, () => m.session.findSessionReader(other.newsletter));
		assert.equal(asOther, null);
		const stolen = new Map([[m.links.readerCookieName(other.slug), visitor.jar.get(m.links.readerCookieName(user.slug))]]);
		assert.equal(await inBrowser({ jar: stolen, ip: "203.0.113.200" }, () => m.session.findSessionReader(other.newsletter)), null, "a session cookie copied to another newsletter");
	});

	test("a reader who left is refused, even with a session or a link that is still good", async () => {
		const user = await createPublisher(m, "left-owner@example.com");
		for (const status of ["unsubscribed", "bounced", "complained", "pending", "dormant"]) {
			const reader = await addReader(m, user, `${status}@example.org`);
			const visitor = await signInReader(m, user, reader);
			assert.ok(await inBrowser(visitor, () => m.session.findSessionReader(user.newsletter)), "active at first");
			await m.Contact.updateOne({ accountId: user.accountId, _id: reader._id }, { $set: { status } });
			assert.equal(await inBrowser(visitor, () => m.session.findSessionReader(user.newsletter)), null, `${status}: the session no longer counts`);

			const fresh = browser();
			const url = m.links.getEmailCommentUrl({ contactId: reader._id, newsletterId: user.newsletterId }, user.newsletter, { issueSlug: user.issue.archiveSlug });
			const response = await inBrowser(fresh, () => m.readerIn.GET(new m.NextRequest(url)));
			assert.equal(fresh.jar.size, 0, `${status}: the link starts no session`);
			assert.match(response.headers.get("location"), /#comments-expired$/);
		}
	});
});

describe("Sign in with your email", () => {
	function ask(user, email, extra = {}) {
		const visitor = extra.visitor ?? browser();
		return inBrowser(visitor, () => m.commentActions.requestSignIn(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, email, ...extra.fields })));
	}

	test("emails a subscriber a link that works once, then signs them in", async () => {
		const user = await createPublisher(m, "signin-owner@example.com");
		await addReader(m, user, "dana@example.org");
		const before = emailCount();
		assert.equal((await ask(user, "dana@example.org")).ok, true);
		await settle();
		const [email] = emailsTo("dana@example.org", before);
		assert.ok(email, "an email went out through the sending path");
		assert.match(email.subject, /sign-in link for signin-owner news/);
		assert.equal(email.headers?.["List-Unsubscribe"], undefined, "a transactional email: no unsubscribe header");
		assert.match(email.text, /asked for this link/);
		const link = /https:\/\/[^\s)"<]+\/reader\/signin\?[^\s)"<]+/.exec(email.html)[0].replaceAll("&amp;", "&");
		assert.ok(!link.includes("/c/"), "not wrapped in a click tracker");
		const url = new URL(link);
		assert.equal(url.searchParams.get("p"), user.issue.archiveSlug);

		const page = await m.signinPage({ searchParams: Promise.resolve({ token: url.searchParams.get("token"), p: url.searchParams.get("p") }) });
		assert.match(JSON.stringify(page), /Continue/, "a button first: opening the page spends nothing");
		assert.equal((await m.session.previewSignInLink(url.searchParams.get("token"))).state, "ready");

		const visitor = browser();
		const where = await inBrowser(visitor, () =>
			catchRedirect(m.signinActions.continueSignIn(form({ token: url.searchParams.get("token"), p: url.searchParams.get("p") })))
		);
		assert.match(where, new RegExp(`/p/${user.issue.archiveSlug}#comments$`));
		const reader = await inBrowser(visitor, () => m.session.findSessionReader(user.newsletter));
		assert.equal(reader.email, "dana@example.org");

		const again = browser();
		const back = await inBrowser(again, () => catchRedirect(m.signinActions.continueSignIn(form({ token: url.searchParams.get("token"), p: url.searchParams.get("p") }))));
		assert.match(back, /^\/reader\/signin\?token=/, "the second use goes back to the page");
		assert.equal(again.jar.size, 0, "and starts no session");
		assert.equal((await m.session.previewSignInLink(url.searchParams.get("token"))).state, "spent");
	});

	test("expires after 30 minutes", async () => {
		const user = await createPublisher(m, "signin-expiry@example.com");
		const reader = await addReader(m, user, "eve@example.org");
		const old = m.links.createReaderToken("signin", { contactId: reader._id, newsletterId: user.newsletterId }, Date.now() - 31 * 60_000);
		assert.equal((await m.session.previewSignInLink(old)).state, "invalid");
		const visitor = browser();
		await inBrowser(visitor, () => catchRedirect(m.signinActions.continueSignIn(form({ token: old, p: user.issue.archiveSlug }))));
		assert.equal(visitor.jar.size, 0);
	});

	test("answers every address the same and tells nobody who is subscribed", async () => {
		const user = await createPublisher(m, "enum-owner@example.com");
		await addReader(m, user, "member@example.org");
		await addReader(m, user, "gone@example.org", { status: "unsubscribed" });
		await addReader(m, user, "bounced@example.org", { status: "bounced" });
		await addReader(m, user, "waiting@example.org", { status: "pending" });
		const before = emailCount();
		const answers = [];
		for (const email of ["member@example.org", "gone@example.org", "bounced@example.org", "waiting@example.org", "stranger@example.org"]) {
			answers.push(await ask(user, email));
		}
		await settle();
		for (const answer of answers) assert.deepEqual(answer, answers[0]);
		assert.equal(answers[0].ok, true);
		assert.match(answers[0].message, /^If this address is subscribed/);
		assert.equal(emailsTo("member@example.org", before).length, 1, "only the active subscriber got a link");
		for (const email of ["gone@example.org", "bounced@example.org", "waiting@example.org", "stranger@example.org"]) {
			assert.equal(emailsTo(email, before).length, 0, email);
		}
		assert.deepEqual(await ask(user, "not an address"), { error: "Enter a valid email" }, "only the format is checked");
	});

	test("limits requests per address and per network the same for every address, and ignores the honeypot", async () => {
		const user = await createPublisher(m, "limit-owner@example.com");
		await addReader(m, user, "real@example.org");
		const before = emailCount();
		const answers = [];
		for (let index = 0; index < 4; index++) answers.push(await ask(user, "real@example.org", { visitor: browser() }));
		for (let index = 0; index < 4; index++) answers.push(await ask(user, "nobody@example.org", { visitor: browser() }));
		await settle();
		assert.deepEqual(answers.map((answer) => Boolean(answer.ok)), [true, true, true, false, true, true, true, false], "the third request an hour per address, subscribed or not");
		assert.match(answers[3].error, /Too many requests for this address/);
		assert.equal(emailsTo("real@example.org", before).length, 3);

		const flood = browser();
		const results = [];
		for (let index = 0; index < 6; index++) results.push(await ask(user, `flood${index}@example.org`, { visitor: flood }));
		assert.deepEqual(results.map((answer) => Boolean(answer.ok)), [true, true, true, true, true, false], "five a network every ten minutes");

		const trapped = emailCount();
		const bot = await ask(user, "real@example.org", { fields: { website: "https://spam.test" }, visitor: browser() });
		await settle();
		assert.equal(bot.ok, true, "a bot is told it worked");
		assert.equal(emailCount(), trapped, "and gets nothing");
	});

	test("sends nothing for an issue with comments off, a missing issue, or a blocked account", async () => {
		const user = await createPublisher(m, "quiet-owner@example.com");
		await addReader(m, user, "quiet@example.org");
		const off = await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Closed", archiveSlug: "closed", status: "sent", comments: "off" });
		const before = emailCount();
		await inBrowser(browser(), () => m.commentActions.requestSignIn(null, form({ newsletter: user.slug, p: off.archiveSlug, email: "quiet@example.org" })));
		await inBrowser(browser(), () => m.commentActions.requestSignIn(null, form({ newsletter: user.slug, p: "no-such-issue", email: "quiet@example.org" })));
		await inBrowser(browser(), () => m.commentActions.requestSignIn(null, form({ newsletter: "no-such-newsletter", p: user.issue.archiveSlug, email: "quiet@example.org" })));
		await settle();
		assert.equal(emailsTo("quiet@example.org", before).length, 0);

		const blocks = await import("../lib/account-blocks.js");
		await blocks.blockAccount(user.accountId, { reason: "an admin", by: "admin" });
		await ask(user, "quiet@example.org");
		await settle();
		assert.equal(emailsTo("quiet@example.org", before).length, 0, "a blocked account sends nothing");
	});

	test("signing out ends the session", async () => {
		const user = await createPublisher(m, "signout-owner@example.com");
		const reader = await addReader(m, user, "out@example.org");
		const visitor = await signInReader(m, user, reader);
		await inBrowser(visitor, () => m.commentActions.signOutReader(user.slug));
		assert.equal(await inBrowser(visitor, () => m.session.findSessionReader(user.newsletter)), null);
		assert.equal(visitor.jar.get(m.links.readerMarkerName(user.slug)), undefined);
	});
});

describe("the newsletter's emails", () => {
	const build = (user, contact, campaign = user.issue) =>
		m.sendingRules.buildRecipientEmail({ campaign: { ...campaign, format: campaign.format ?? "rich" }, newsletter: user.newsletter, contact, messageId: "6650f1c2e9b1d4a0bbbbbbbb" });

	test("end with a Discuss this issue link that signs the reader in, when comments are on", async () => {
		const user = await createPublisher(m, "footer-owner@example.com");
		const reader = await addReader(m, user, "foot@example.org");
		const email = build(user, reader);
		assert.match(email.html, /Discuss this issue/);
		assert.match(email.text, /Discuss this issue: https:\/\//);
		const tracked = /href="([^"]+)"[^>]*>Discuss this issue/.exec(email.html)[1];
		const direct = tracked.includes("/c/") ? Buffer.from(tracked.split("/c/")[1].split(".")[2], "base64url").toString("utf8") : tracked;
		const url = new URL(direct.replaceAll("&amp;", "&"));
		assert.equal(url.pathname, "/reader/in");
		assert.deepEqual(m.links.verifyReaderToken("email", url.searchParams.get("token")), { contactId: String(reader._id), newsletterId: user.newsletterId });
		assert.equal(url.searchParams.get("p"), user.issue.archiveSlug);
	});

	test("leave it out when comments are off, for the issue or the newsletter, or when the reader can't comment", async () => {
		const off = await createPublisher(m, "footer-off@example.com", { comments: { enabled: false } });
		const reader = await addReader(m, off, "foot@example.org");
		assert.doesNotMatch(build(off, reader).html, /Discuss this issue/);
		const issueOn = { ...off.issue, comments: "on" };
		assert.match(build(off, reader, issueOn).html, /Discuss this issue/, "an issue can switch comments on");

		const on = await createPublisher(m, "footer-issue-off@example.com");
		const one = await addReader(m, on, "foot2@example.org");
		assert.doesNotMatch(build(on, one, { ...on.issue, comments: "off" }).html, /Discuss this issue/, "or off");
		assert.doesNotMatch(build(on, one, { ...on.issue, audience: "paid" }).html, /Discuss this issue/, "a paid-only issue has no page");

		const paid = await createPublisher(m, "footer-paid@example.com", { comments: { enabled: true, who: "paid" } });
		const free = await addReader(m, paid, "free@example.org");
		const payer = await addReader(m, paid, "payer@example.org", { tier: "paid", paidUntil: new Date(Date.now() + 30 * DAY_MS) });
		assert.doesNotMatch(build(paid, free).html, /Discuss this issue/);
		assert.match(build(paid, payer).html, /Discuss this issue/);
		const blocked = await addReader(m, on, "blocked@example.org", { community: { blocked: true, blockedReason: "Spam" } });
		assert.doesNotMatch(build(on, blocked).html, /Discuss this issue/);
	});

	test("fill {{comment_link}} in an issue, in a link or in text, and fall back to the page when nobody can sign in", async () => {
		const user = await createPublisher(m, "tag-owner@example.com");
		const reader = await addReader(m, user, "tag@example.org");
		const issue = { ...user.issue, html: '<p><a href="{{comment_link}}">Join in</a> or paste {{comment_link}}</p>' };
		const email = build(user, reader, issue);
		assert.doesNotMatch(email.html, /\{\{comment_link\}\}|%7B%7B/);
		assert.match(email.html, /Join in/);
		assert.doesNotMatch(email.html, /href="[^"]*\/reader\/in/, "tracked links hide the address");
		const clicks = [...email.html.matchAll(/href="[^"]*\/c\/[^"]+/g)].length;
		assert.ok(clicks >= 2);

		const untracked = m.sendingRules.buildRecipientEmail({ campaign: issue, newsletter: user.newsletter, contact: reader });
		assert.equal(untracked.html.match(/\/reader\/in\?token=/g).length, 3, "the tag in a link, in text, and the footer");
		assert.match(untracked.text, /reader\/in\?token=/);

		const noComments = await createPublisher(m, "tag-off@example.com", { comments: { enabled: false } });
		const plain = await addReader(m, noComments, "tag@example.org");
		const page = m.sendingRules.buildRecipientEmail({ campaign: { ...noComments.issue, html: "<p>{{comment_link}}</p>" }, newsletter: noComments.newsletter, contact: plain });
		assert.match(page.html, new RegExp(`/p/${noComments.issue.archiveSlug}`));
		assert.doesNotMatch(page.html, /reader\/in/);
	});

	test("fill the comment link and the recommendations block in one email and one web page", async () => {
		const user = await createPublisher(m, "both-owner@example.com");
		const reader = await addReader(m, user, "both@example.org");
		const recommendations = [{ name: "Pottery Weekly", pitch: "Plain talk about pottery.", url: "https://pottery.flockstackmail.com/?rec=x#subscribe" }];
		const html = '<p><a href="{{comment_link}}">Join in</a></p><p>{{recommendations}}</p><p>{{referral_count}}</p>';
		const email = m.sendingRules.buildRecipientEmail({ campaign: { ...user.issue, format: "rich", html }, newsletter: user.newsletter, contact: reader, recommendations });
		assert.doesNotMatch(email.html, /\{\{(comment_link|recommendations|referral_count)\}\}|%7B%7B/);
		assert.match(email.html, /Pottery Weekly/);
		assert.match(email.html, /Discuss this issue/);
		const { renderIssueBody } = await import("../lib/archive-content.js");
		const campaign = { format: "html", html, subject: "s" };
		const page = renderIssueBody(campaign, { recommendations });
		assert.match(page.html, /Pottery Weekly/);
		assert.match(page.html, /href="#comments"/);
		assert.doesNotMatch(page.html, /\{\{comment_link\}\}|\{\{recommendations\}\}/);
	});

	test("show the tag as the page's own comments on the web, and leave it in an export", async () => {
		const { renderIssueBody } = await import("../lib/archive-content.js");
		const campaign = { format: "rich", html: '<p><a href="{{comment_link}}">Join in</a></p>' };
		assert.match(renderIssueBody(campaign).html, /href="#comments"/);
		assert.match(renderIssueBody(campaign, { referralLink: null }).html, /Join in/);
		assert.doesNotMatch(renderIssueBody(campaign, { referralLink: null }).html, /href="#comments"/);
	});
});
