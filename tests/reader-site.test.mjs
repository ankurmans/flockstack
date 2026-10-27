import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { catchRedirect, form, startTestApp } from "./helpers/app.mjs";
import { SHARED_DOMAIN, addIssue, addReader, browser, createPublisher, emailCount, emailsTo, importModels, inBrowser, settle, signInReader } from "./helpers/community.mjs";

// The reader's account across the whole newsletter site: a Sign in link (an emailed link, no password, under the comments'
// rate limits), after which paid issues unlock on the web for paid readers only, and a Subscriber Center with their profile,
// preferences, subscription, referral link and the way to unsubscribe.
let app;
let m;
const DAY_MS = 86_400_000;
const SECRET = "The secret deep dive only paid readers get.";
const PAID_BODY = `<p>The opening paragraph, free for everyone to read.</p><p>A second paragraph that goes on for a while to show where the teaser stops, somewhere around here.</p><p>${SECRET}</p><script>alert(1)</script>`;
const BREAK_BODY = `<p>Free part for everyone.</p><div data-paywall=""></div><p>${SECRET}</p>`;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		reader: await import("../app/archive/reader-actions.js"),
		access: await import("../lib/reader-access.js"),
		center: await import("../lib/subscriber-center.js"),
		issuePage: (await import("../app/archive/[slug]/p/[post]/page.js")).default,
		signinSitePage: (await import("../app/archive/[slug]/signin/page.js")).default,
		accountPage: (await import("../app/archive/[slug]/account/page.js")).default,
		proxy: (await import("../proxy.js")).proxy,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		BodyIssue: (await import("../components/BodyIssue.jsx")).default,
		Account: (await import("../models/Account.js")).default,
		CustomField: (await import("../models/CustomField.js")).default,
		cookies: await import("../lib/reader-cookies.js"),
	};
});

after(() => app?.stop());

let counter = 0;
const issueParams = (user, post) => ({ params: Promise.resolve({ slug: user.slug, post }) });
const wrap = (user, element) =>
	renderToStaticMarkup(createElement(m.TooltipProvider, null, createElement(m.ProviderSubscribe, { newsletter: { name: "n", slug: user.slug, signupFields: [] }, readers: 0 }, element)));

// A newsletter whose paid tier is on and whose payments can take a sale, with a paid-only issue and one with a paywall break.
async function paidNewsletter(options = {}) {
	const user = await createPublisher(m, `reader${++counter}@example.com`, { comments: { enabled: false }, ...options });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { paidTier: { enabled: true, currency: "usd", monthlyCents: 800, yearlyCents: 8000 } } });
	await m.Account.updateOne({ _id: user.accountId }, { $set: { "payments.stripeAccountId": `acct_${user.slug}`, "payments.chargesEnabled": true, "payments.payoutsEnabled": true, "payments.detailsSubmitted": true } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	user.paidIssue = await addIssue(m, user, { subject: "A paid issue", audience: "paid", html: PAID_BODY });
	user.breakIssue = await addIssue(m, user, { subject: "A free issue with a break", html: BREAK_BODY });
	return user;
}

const paidFields = (days = 20) => ({ tier: "paid", paidUntil: new Date(Date.now() + days * DAY_MS), paidInterval: "month", stripeCustomerId: "cus_reader", subscriptionStatus: "active" });
const unlock = (user, visitor, issue = user.paidIssue) => inBrowser(visitor, () => m.reader.unlockIssue(user.slug, issue.archiveSlug));

describe("signing in on the website", () => {
	function ask(user, email, { visitor = browser(), fields = {} } = {}) {
		return inBrowser(visitor, () => m.reader.requestSiteSignIn(null, form({ newsletter: user.slug, email, ...fields })));
	}

	test("emails a subscriber a link that works once and lands in their account, with comments off", async () => {
		const user = await createPublisher(m, `site-signin${++counter}@example.com`, { comments: { enabled: false } });
		await addReader(m, user, "dana@example.org");
		const before = emailCount();
		const answer = await ask(user, "dana@example.org");
		assert.equal(answer.ok, true);
		await settle();
		const [email] = emailsTo("dana@example.org", before);
		assert.ok(email, "an email went out");
		assert.match(email.subject, /sign-in link for /);
		assert.equal(email.headers?.["List-Unsubscribe"], undefined, "a transactional email, with no unsubscribe header");
		const link = /https:\/\/[^\s)"<]+\/reader\/signin\?[^\s)"<]+/.exec(email.html)[0].replaceAll("&amp;", "&");
		const url = new URL(link);
		assert.equal(url.searchParams.get("next"), "account");
		assert.ok(!link.includes("/c/"), "not wrapped in a click tracker");

		const token = url.searchParams.get("token");
		const page = await m.signinPage({ searchParams: Promise.resolve({ token, next: "account" }) });
		const markup = JSON.stringify(page);
		assert.match(markup, /Continue/);
		assert.match(markup, /your subscription, your preferences and your referrals/);
		assert.match(markup, /"name":"next","value":"account"/);
		assert.equal((await m.session.previewSignInLink(token)).state, "ready", "opening the page spends nothing");

		const visitor = browser();
		const where = await inBrowser(visitor, () => catchRedirect(m.signinActions.continueSignIn(form({ token, next: "account" }))));
		assert.equal(where, `https://${user.slug}.${SHARED_DOMAIN}/account`);
		assert.equal((await inBrowser(visitor, () => m.session.findSessionReader(user.newsletter))).email, "dana@example.org");
		assert.ok(visitor.jar.has(m.cookies.readerMarkerName(user.slug)), "the page can tell a session exists");

		const again = browser();
		const back = await inBrowser(again, () => catchRedirect(m.signinActions.continueSignIn(form({ token, next: "account" }))));
		assert.match(back, /^\/reader\/signin\?token=.*next=account/, "a spent link goes back to its page");
		assert.equal(again.jar.size, 0);
		const spent = JSON.stringify(await m.signinPage({ searchParams: Promise.resolve({ token, next: "account" }) }));
		assert.match(spent, /already used/);
		assert.match(spent, /Get a new link/);
	});

	test("expires after 30 minutes, and a made-up destination is ignored", async () => {
		const user = await createPublisher(m, `site-expiry${++counter}@example.com`, { comments: { enabled: false } });
		const reader = await addReader(m, user, "eve@example.org");
		const old = m.links.createReaderToken("signin", { contactId: reader._id, newsletterId: user.newsletterId }, Date.now() - 31 * 60_000);
		const visitor = browser();
		await inBrowser(visitor, () => catchRedirect(m.signinActions.continueSignIn(form({ token: old, next: "account" }))));
		assert.equal(visitor.jar.size, 0);
		assert.match(JSON.stringify(await m.signinPage({ searchParams: Promise.resolve({ token: old, next: "account" }) })), /doesn.t work/);

		const fresh = m.links.createReaderToken("signin", { contactId: reader._id, newsletterId: user.newsletterId });
		const where = await inBrowser(browser(), () => catchRedirect(m.signinActions.continueSignIn(form({ token: fresh, next: "https://evil.example.com" }))));
		assert.doesNotMatch(where, /evil\.example/);
		assert.match(where, /#comments$/, "an unknown destination is the comments, as before");
		assert.deepEqual(m.links.SIGNIN_DESTINATIONS, ["account", "issue"]);
	});

	test("answers every address the same, tells nobody who is subscribed, and sends nothing to the rest", async () => {
		const user = await createPublisher(m, `site-enum${++counter}@example.com`, { comments: { enabled: false } });
		await addReader(m, user, "member@example.org");
		await addReader(m, user, "gone@example.org", { status: "unsubscribed" });
		await addReader(m, user, "bounced@example.org", { status: "bounced" });
		await addReader(m, user, "waiting@example.org", { status: "pending" });
		const before = emailCount();
		const answers = [];
		for (const email of ["member@example.org", "gone@example.org", "bounced@example.org", "waiting@example.org", "stranger@example.org"]) answers.push(await ask(user, email));
		await settle();
		for (const answer of answers) assert.deepEqual(answer, answers[0]);
		assert.match(answers[0].message, /^If this address is subscribed/);
		assert.equal(emailsTo("member@example.org", before).length, 1);
		assert.equal(emailCount() - before, 1, "nobody else got anything");
		assert.deepEqual(await ask(user, "not an email"), { error: "Enter a valid email" });
	});

	test("stops a bot's hidden field and a flood, under the limits the comments' sign-in has", async () => {
		const user = await createPublisher(m, `site-limits${++counter}@example.com`, { comments: { enabled: true } });
		await addReader(m, user, "limited@example.org");
		await addReader(m, user, "bot@example.org");
		const before = emailCount();
		assert.equal((await ask(user, "bot@example.org", { fields: { website: "http://spam.example.com" } })).ok, true);
		await settle();
		assert.equal(emailsTo("bot@example.org", before).length, 0, "the hidden field was filled in: nothing is sent");

		// Three an hour for one address, the comments' sign-in included: both draw on the same count.
		for (let index = 0; index < 2; index += 1) assert.equal((await ask(user, "limited@example.org")).ok, true);
		const viaComments = await inBrowser(browser(), () => m.commentActions.requestSignIn(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, email: "limited@example.org" })));
		assert.equal(viaComments.ok, true, "the third");
		const fourth = await ask(user, "limited@example.org");
		assert.match(fourth.error, /Too many requests for this address/);
		const fromComments = await inBrowser(browser(), () => m.commentActions.requestSignIn(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, email: "limited@example.org" })));
		assert.match(fromComments.error, /Too many requests for this address/);

		// Five a network.
		const flood = browser();
		const results = [];
		for (let index = 0; index < 6; index += 1) results.push(await ask(user, `flood${index}@example.org`, { visitor: flood }));
		assert.deepEqual(results.slice(0, 5).map((result) => result.ok), [true, true, true, true, true]);
		assert.match(results[5].error, /Too many requests from your network/);
	});

	test("is a page of the site with a form and no password, kept out of search results", async () => {
		const user = await paidNewsletter();
		const markup = wrap(user, await m.signinSitePage(issueParams(user, "x")));
		assert.match(markup, /Sign in to /);
		assert.match(markup, /<label[^>]*>Your email<\/label>/);
		assert.match(markup, /Email me a sign-in link/);
		assert.match(markup, /tabindex="-1"[^>]*name="website"/, "the honeypot");
		assert.doesNotMatch(markup, /type="password"/);
		const { generateMetadata } = await import("../app/archive/[slug]/signin/page.js");
		assert.deepEqual((await generateMetadata(issueParams(user, "x"))).robots, { index: false, follow: false });
	});
});

describe("a paid issue on the web", () => {
	test("shows anonymous visitors the teaser and the upgrade card, and none of the rest, in the page everyone gets", async () => {
		const user = await paidNewsletter();
		const page = wrap(user, await m.issuePage(issueParams(user, user.paidIssue.archiveSlug)));
		assert.match(page, /The opening paragraph, free for everyone to read\./);
		assert.match(page, /This issue is for paid subscribers/);
		assert.match(page, new RegExp(`href="https://${user.slug}\\.${SHARED_DOMAIN}/subscribe"`));
		assert.doesNotMatch(page, /secret deep dive|alert\(1\)/);

		const partial = wrap(user, await m.issuePage(issueParams(user, user.breakIssue.archiveSlug)));
		assert.match(partial, /Free part for everyone\./);
		assert.match(partial, /The rest of this issue is for paid subscribers/);
		assert.doesNotMatch(partial, /secret deep dive/);
	});

	test("gives anonymous visitors nothing from the unlock call", async () => {
		const user = await paidNewsletter();
		const answer = await unlock(user, browser());
		assert.deepEqual(answer, { unlocked: false, signedIn: false });
		assert.deepEqual(await unlock(user, browser(), user.breakIssue), { unlocked: false, signedIn: false });
	});

	test("gives free readers the upgrade card too, though they are signed in", async () => {
		const user = await paidNewsletter();
		const visitor = await signInReader(m, user, await addReader(m, user, "free@example.org"));
		const answer = await unlock(user, visitor);
		assert.deepEqual(answer, { unlocked: false, signedIn: true });
		assert.equal("html" in answer, false);
		assert.deepEqual(await unlock(user, visitor, user.breakIssue), { unlocked: false, signedIn: true });
	});

	test("opens the whole issue to a paid reader, sanitized, for a paid-only issue and past a paywall break", async () => {
		const user = await paidNewsletter();
		const visitor = await signInReader(m, user, await addReader(m, user, "paid@example.org", paidFields()));
		const paid = await unlock(user, visitor);
		assert.equal(paid.unlocked, true);
		assert.equal(paid.kind, "article");
		assert.match(paid.html, /The opening paragraph/);
		assert.match(paid.html, new RegExp(SECRET));
		assert.doesNotMatch(paid.html, /<script|alert\(1\)/, "cleaned like the page");

		const partial = await unlock(user, visitor, user.breakIssue);
		assert.equal(partial.unlocked, true);
		assert.match(partial.html, /Free part for everyone\./);
		assert.match(partial.html, new RegExp(SECRET));
		assert.doesNotMatch(partial.html, /data-paywall/);
	});

	test("shows a designed HTML issue whole in its frame to a paid reader", async () => {
		const user = await paidNewsletter();
		const designed = await addIssue(m, user, { subject: "Designed", format: "html", audience: "paid", html: `<html><body><h1>Designed</h1><p>${SECRET}</p><script>alert(1)</script></body></html>` });
		const visitor = await signInReader(m, user, await addReader(m, user, "framed@example.org", paidFields()));
		const answer = await unlock(user, visitor, designed);
		assert.equal(answer.kind, "frame");
		assert.match(answer.html, new RegExp(SECRET));
		const anonymous = wrap(user, await m.issuePage(issueParams(user, designed.archiveSlug)));
		assert.doesNotMatch(anonymous, new RegExp(SECRET));
	});

	test("counts a reader as paid for the days of grace Stripe's webhook needs, and not after", async () => {
		const user = await paidNewsletter();
		const lapsing = await signInReader(m, user, await addReader(m, user, "lapsing@example.org", paidFields(-1)));
		assert.equal((await unlock(user, lapsing)).unlocked, true, "a day past their period, still paid");
		const lapsed = await signInReader(m, user, await addReader(m, user, "lapsed@example.org", paidFields(-4)));
		assert.deepEqual(await unlock(user, lapsed), { unlocked: false, signedIn: true });
		const never = await signInReader(m, user, await addReader(m, user, "notpaid@example.org", { tier: "paid" }));
		assert.equal((await unlock(user, never)).unlocked, false, "paid with no period at all is not paid");
	});

	test("locks again the moment a reader stops paying, and for one who left", async () => {
		const user = await paidNewsletter();
		const reader = await addReader(m, user, "turning@example.org", paidFields());
		const visitor = await signInReader(m, user, reader);
		assert.equal((await unlock(user, visitor)).unlocked, true);
		await m.Contact.updateOne({ accountId: user.accountId, _id: reader._id }, { $set: { tier: "free" } });
		assert.deepEqual(await unlock(user, visitor), { unlocked: false, signedIn: true });
		await m.Contact.updateOne({ accountId: user.accountId, _id: reader._id }, { $set: { tier: "paid", status: "unsubscribed" } });
		assert.deepEqual(await unlock(user, visitor), { unlocked: false, signedIn: false }, "an unsubscribed reader is nobody");
	});

	test("ignores a session that expired, was forged, is another kind of link or belongs to another newsletter", async () => {
		const user = await paidNewsletter();
		const other = await paidNewsletter();
		const reader = await addReader(m, user, "tokens@example.org", paidFields());
		const otherReader = await addReader(m, other, "elsewhere@example.org", paidFields());
		const reference = { contactId: reader._id, newsletterId: user.newsletterId };
		const cookie = m.cookies.readerCookieName(user.slug);
		const withCookie = (value) => {
			const visitor = browser();
			visitor.jar.set(cookie, value);
			return visitor;
		};

		const fresh = m.links.createReaderToken("session", reference);
		assert.equal((await unlock(user, withCookie(fresh))).unlocked, true, "a good session works");
		const expired = m.links.createReaderToken("session", reference, Date.now() - 31 * DAY_MS);
		assert.deepEqual(await unlock(user, withCookie(expired)), { unlocked: false, signedIn: false }, "30 days is the most a session lasts");
		const almost = m.links.createReaderToken("session", reference, Date.now() - 29 * DAY_MS);
		assert.equal((await unlock(user, withCookie(almost))).unlocked, true, "and 29 days still counts");
		for (const kind of ["email", "signin", "replies"]) {
			assert.equal((await unlock(user, withCookie(m.links.createReaderToken(kind, reference)))).unlocked, false, `a ${kind} link is no session`);
		}
		assert.equal((await unlock(user, withCookie(`${fresh.slice(0, -2)}xx`))).unlocked, false, "a forged signature");
		assert.equal((await unlock(user, withCookie("garbage"))).unlocked, false);

		const foreign = m.links.createReaderToken("session", { contactId: otherReader._id, newsletterId: other.newsletterId });
		assert.equal((await unlock(user, withCookie(foreign))).unlocked, false, "another newsletter's session, even a paid reader's");
		assert.equal((await unlock(other, (() => { const visitor = browser(); visitor.jar.set(m.cookies.readerCookieName(other.slug), foreign); return visitor; })())).unlocked, true);
	});

	test("never unlocks an email only issue, an unknown issue or a slug that isn't one", async () => {
		const user = await paidNewsletter();
		const visitor = await signInReader(m, user, await addReader(m, user, "careful@example.org", paidFields()));
		const emailOnly = await addIssue(m, user, { subject: "Email only", audience: "paid", publishTo: "email", html: PAID_BODY });
		for (const post of [emailOnly.archiveSlug, "no-such-issue", "../etc", "", "A B"]) {
			assert.equal((await inBrowser(visitor, () => m.reader.unlockIssue(user.slug, post))).unlocked, false, post);
		}
		assert.equal((await inBrowser(visitor, () => m.reader.unlockIssue("no-such-newsletter", user.paidIssue.archiveSlug))).unlocked, false);
	});

	test("the page's client part asks only when the browser has a session and the page is gated", async () => {
		const fs = await import("node:fs/promises");
		const source = await fs.readFile(new URL("../components/BodyIssue.jsx", import.meta.url), "utf8");
		assert.match(source, /isGated = initial\.kind === "paywall"/);
		assert.match(source, /if \(!isGated \|\| !hasSession\) return;/);
		assert.match(source, /readerMarkerName\(slug\)/);
	});
});

describe("the Subscriber Center", () => {
	async function visit(user, visitor) {
		return inBrowser(visitor, async () => wrap(user, await m.accountPage({ params: Promise.resolve({ slug: user.slug }) })));
	}

	test("sends a visitor without a session to sign in, and is built for each request", async () => {
		const user = await paidNewsletter();
		const where = await inBrowser(browser(), () => catchRedirect(m.accountPage({ params: Promise.resolve({ slug: user.slug }) })));
		assert.equal(where, `https://${user.slug}.${SHARED_DOMAIN}/signin`);
		const accountModule = await import("../app/archive/[slug]/account/page.js");
		assert.equal(accountModule.dynamic, "force-dynamic");
		assert.deepEqual((await accountModule.generateMetadata(issueParams(user, "x"))).robots, { index: false, follow: false });
	});

	test("shows a free reader their email, a free plan and the way to upgrade and to leave", async () => {
		const user = await paidNewsletter();
		const reader = await addReader(m, user, "free-reader@example.org", { subscribedAt: new Date("2026-01-15T12:00:00Z") });
		const page = await visit(user, await signInReader(m, user, reader));
		assert.match(page, /Your account/);
		assert.match(page, /free-reader@example\.org/);
		assert.match(page, /Subscribed since/);
		assert.match(page, /Jan 15, 2026/);
		assert.match(page, /Free subscriber/);
		assert.match(page, new RegExp(`href="https://${user.slug}\\.${SHARED_DOMAIN}/subscribe"[^>]*>Become a paid subscriber`));
		assert.doesNotMatch(page, /Manage your subscription/, "a reader who never paid has no billing page");
		assert.match(page, /Unsubscribe from /);
		assert.match(page, /\/unsubscribe\?token=/);
		assert.match(page, /Sign out/);
		assert.doesNotMatch(page, /type="password"/);
	});

	test("shows a paid reader their plan and a link to manage it at Stripe, on the creator's account", async () => {
		const user = await paidNewsletter();
		const reader = await addReader(m, user, "paying@example.org", paidFields(20));
		const page = await visit(user, await signInReader(m, user, reader));
		assert.match(page, /Paid subscriber, billed every month/);
		assert.match(page, /Your current period runs to /);
		const portal = /href="([^"]*\/api\/shop\/portal\?token=[^"]+)"[^>]*>Manage your subscription/.exec(page);
		assert.ok(portal, "the existing billing link");
		assert.ok(portal[1].startsWith(`https://${user.slug}.${SHARED_DOMAIN}/api/shop/portal`));
		const reference = (await import("../lib/portal-link.js")).readPortalToken(new URL(portal[1]).searchParams.get("token"));
		assert.deepEqual(reference, { contactId: String(reader._id), newsletterId: user.newsletterId });
		assert.doesNotMatch(page, /Become a paid subscriber/);
		await m.Contact.updateOne({ accountId: user.accountId, _id: reader._id }, { $set: { subscriptionStatus: "canceled" } });
		assert.match(await visit(user, await signInReader(m, user, reader)), /Access until /);
	});

	test("renders the complete paid account in every reader language", async () => {
		const { READER_LANGUAGES, getReaderText } = await import("../lib/reader-languages.js");
		const { readerBillingSummary } = await import("../lib/reader-billing-copy.js");
		for (const language of READER_LANGUAGES) {
			const user = await paidNewsletter();
			await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { language } });
			user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
			const reader = await addReader(m, user, `locale-${language}@example.org`, paidFields(20));
			const page = await visit(user, await signInReader(m, user, reader));
			const t = getReaderText(user.newsletter);
			assert.ok(page.includes(t("Manage your subscription")), language);
			assert.ok(page.includes(readerBillingSummary(user.newsletter, { access: "stripe", interval: "month", status: "active", paidUntil: reader.paidUntil }).heading), language);
			assert.match(page, /\/api\/shop\/portal\?token=/);
			if (language !== "en") assert.doesNotMatch(page, /billed every month|Your current period runs to|You read every issue/);
		}
	});

	test("lets a reader change the preferences the creator opened to them, and nothing else", async () => {
		const user = await paidNewsletter();
		await m.CustomField.create({ accountId: user.accountId, newsletterId: user.newsletterId, key: "topic", label: "Topic", type: "list", options: ["Tools", "Pricing"], multiple: false, readerEditable: true });
		await m.CustomField.create({ accountId: user.accountId, newsletterId: user.newsletterId, key: "internal", label: "Internal note", type: "text" });
		const reader = await addReader(m, user, "prefs@example.org", { fields: { topic: "Tools", internal: "vip" } });
		const visitor = await signInReader(m, user, reader);
		const page = await visit(user, visitor);
		assert.match(page, /Preferences/);
		assert.match(page, /name="field_topic"/);
		assert.doesNotMatch(page, /field_internal|Internal note|vip/);

		const { preferences } = await m.center.getSubscriberCenter({ newsletter: user.newsletter, contact: reader });
		assert.deepEqual(preferences.fields.map(({ key }) => key), ["topic"], "only the field opened to readers is in the center's data");
		const actions = await import("../app/preferences/actions.js");
		const saved = await inBrowser(visitor, () => actions.savePreferenceForm(preferences.token, null, form({ field_topic: "Pricing", field_internal: "hacked" })));
		assert.deepEqual(saved, { ok: true });
		const stored = await m.Contact.findOne({ accountId: user.accountId, _id: reader._id }).lean();
		assert.deepEqual([stored.fields.topic, stored.fields.internal], ["Pricing", "vip"]);
	});

	test("shows the referral link and count while the program is on, and nothing while it is off", async () => {
		const user = await paidNewsletter();
		const reader = await addReader(m, user, "referrer@example.org", { referral: { count: 2 } });
		const off = await visit(user, await signInReader(m, user, reader));
		assert.doesNotMatch(off, /Refer a friend/);

		await m.Newsletter.updateOne(
			{ accountId: user.accountId, _id: user.newsletterId },
			{ $set: { requireConfirmation: true, referral: { enabled: true, rewards: [{ id: "aaaaaaaaaaaa", referrals: 5, title: "A sticker", text: "Reply with your address" }] } } }
		);
		const on = await visit(user, await signInReader(m, user, reader));
		assert.match(on, /Refer a friend/);
		assert.match(on, /2 people have signed up through your link\./);
		assert.match(on, /3 more referrals unlock A sticker\./);
		assert.match(on, new RegExp(`value="https://${user.slug}\\.${SHARED_DOMAIN}/\\?ref=[A-Za-z0-9_-]{27}"`));
		assert.match(on, /\/referral\?token=/);
		assert.doesNotMatch(on, /Reply with your address/, "a locked reward stays hidden");
	});

	test("saves the name the newsletter asks for, only for the signed-in reader, and says so when it asks for none", async () => {
		const user = await paidNewsletter();
		const reader = await addReader(m, user, "named@example.org");
		const visitor = await signInReader(m, user, reader);
		assert.doesNotMatch(await visit(user, visitor), /id="reader-name"/, "no name field, no name to edit");
		const refused = await inBrowser(visitor, () => m.reader.saveProfile(null, form({ newsletter: user.slug, name: "Ana" })));
		assert.match(refused.error, /doesn't ask for a name/);

		await m.CustomField.create({ accountId: user.accountId, newsletterId: user.newsletterId, key: "first_name", label: "First name", type: "text" });
		assert.match(await visit(user, visitor), /id="reader-name"/);
		assert.deepEqual(await inBrowser(visitor, () => m.reader.saveProfile(null, form({ newsletter: user.slug, name: "  Ana  " }))), { ok: true });
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: reader._id }).lean()).fields.first_name, "Ana");
		assert.match(await visit(user, visitor), /value="Ana"/);
		assert.match((await inBrowser(visitor, () => m.reader.saveProfile(null, form({ newsletter: user.slug, name: "x".repeat(101) })))).error, /100 characters or fewer/);
		assert.deepEqual(await inBrowser(visitor, () => m.reader.saveProfile(null, form({ newsletter: user.slug, name: "" }))), { ok: true });
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: reader._id }).lean()).fields?.first_name, undefined);

		const anonymousSave = await inBrowser(browser(), () => m.reader.saveProfile(null, form({ newsletter: user.slug, name: "Mallory" })));
		assert.match(anonymousSave.error, /session ended/);
		const other = await addReader(m, user, "bystander@example.org");
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, _id: other._id }).lean()).fields?.first_name, undefined, "only the reader in the session changed");
	});

	test("signs out: the session ends and the reader lands on the home page, locked again", async () => {
		const user = await paidNewsletter();
		const visitor = await signInReader(m, user, await addReader(m, user, "leaving@example.org", paidFields()));
		assert.equal((await unlock(user, visitor)).unlocked, true);
		const where = await inBrowser(visitor, () => catchRedirect(m.reader.signOutOfAccount(form({ newsletter: user.slug }))));
		assert.equal(where, `https://${user.slug}.${SHARED_DOMAIN}/`);
		assert.equal(visitor.jar.size, 0, "both cookies are gone");
		assert.deepEqual(await unlock(user, visitor), { unlocked: false, signedIn: false });
	});

	test("shows only what the signed-in reader owns, whatever the newsletter's other readers hold", async () => {
		const user = await paidNewsletter();
		await addReader(m, user, "other-person@example.org", paidFields());
		const mine = await visit(user, await signInReader(m, user, await addReader(m, user, "me@example.org")));
		assert.doesNotMatch(mine, /other-person@example\.org/);
		assert.match(mine, /me@example\.org/);
	});

	test("is reached from the header's Account link, on the newsletter's host", async () => {
		const user = await paidNewsletter();
		const request = new m.NextRequest(`https://${user.slug}.${SHARED_DOMAIN}/account`, { headers: { host: `${user.slug}.${SHARED_DOMAIN}` } });
		assert.equal((await m.proxy(request)).headers.get("x-middleware-rewrite").replace(/\/$/, ""), `https://${user.slug}.${SHARED_DOMAIN}/archive/${user.slug}/account`);
		const { default: LinkReader } = await import("../components/LinkReader.jsx");
		const link = renderToStaticMarkup(createElement(LinkReader, { marker: m.cookies.readerMarkerName(user.slug), signinHref: "/signin", accountHref: "/account" }));
		assert.match(link, /href="\/signin"[^>]*>Sign in</, "signed out on the server, which cannot read the cookie");
	});
});
