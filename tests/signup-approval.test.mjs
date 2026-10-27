import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, as, form, startTestApp } from "./helpers/app.mjs";
import { api, assertError, creator, findContact, nextIp, visitAndFlush } from "./helpers/growth.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// beehiiv parity S18 and U10: signups held for the owner's approval, and a private website that only a signed-in active
// subscriber reads.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		homePage: (await import("../app/archive/[slug]/page.js")).default,
		homeModule: await import("../app/archive/[slug]/page.js"),
		issueModule: await import("../app/archive/[slug]/p/[post]/page.js"),
		issuesPage: (await import("../app/archive/[slug]/issues/page.js")).default,
		tagPage: (await import("../app/archive/[slug]/tags/[tag]/page.js")).default,
		feedRoute: await import("../app/archive/[slug]/feed/route.js"),
		sitemapRoute: await import("../app/archive/[slug]/sitemap/route.js"),
		llmsRoute: await import("../app/archive/[slug]/llms/route.js"),
		robotsRoute: await import("../app/archive/[slug]/robots/route.js"),
		markdownRoute: await import("../app/archive/[slug]/markdown/[post]/route.js"),
		readerActions: await import("../app/archive/reader-actions.js"),
		archive: await import("../app/archive/actions.js"),
		confirm: await import("../app/confirm/actions.js"),
		contactActions: await import("../app/(app)/contacts/actions.js"),
		readerSession: await import("../lib/reader-session.js"),
		confirmation: await import("../lib/confirmation.js"),
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		Contact: (await import("../models/Contact.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		WebhookDelivery: (await import("../models/WebhookDelivery.js")).default,
	};
});

after(() => app?.stop());

const html = (node) => renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { slug: "x", name: "X", signupFields: [] }, readers: 0 }, node));
const params = (user, more = {}) => ({ params: Promise.resolve({ slug: user.slug, ...more }) });
const NOT_FOUND = /NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/;

async function setup(name, settings = {}, options = {}) {
	const user = await creator(name, options);
	const saved = await api(user.key, "PATCH", `/newsletters/${user.slug}`, settings);
	assert.equal(saved.status, 200, JSON.stringify(saved.body));
	return user;
}

const signUp = (user, email) => visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email, via: "website" })));
const held = (user, status) => api(user.key, "GET", `/contacts?newsletter=${user.slug}&status=${status}`);

describe("held signups (S18)", () => {
	test("a signup waits as held, gets no email, and the owner sees it with a count", async () => {
		const user = await setup("approve-hold", { signupApproval: true, requireConfirmation: false });
		assert.equal((await api(user.key, "GET", `/newsletters/${user.slug}`)).body.signupApproval, true);
		const before = sesEmails.length;
		const answer = await signUp(user, "asks@gmail.com");
		assert.deepEqual([answer.ok, answer.held, answer.pending], [true, true, undefined]);
		assert.equal((await findContact(user, "asks@gmail.com")).status, "held");
		assert.equal(sesEmails.length, before, "no welcome or confirmation email");

		const listed = await held(user, "held");
		assert.deepEqual(listed.body.contacts.map(({ email, status }) => [email, status]), [["asks@gmail.com", "held"]]);
		assert.equal(listed.body.counts.held, 1);
		assert.equal(listed.body.counts.active, 0);
		assert.equal((await api(user.key, "GET", `/contacts/asks@gmail.com?newsletter=${user.slug}`)).body.status, "held");
	});

	test("with confirmation on, the confirmation comes first and the owner's yes after it", async () => {
		const user = await setup("approve-confirm", { signupApproval: true, welcome: { enabled: true, subject: "Welcome", markdown: "Glad you are here." } }, { confirm: true });
		await signUp(user, "careful@gmail.com");
		const pending = await findContact(user, "careful@gmail.com");
		assert.equal(pending.status, "pending");

		const token = m.confirmation.createConfirmToken({ contactId: pending._id, newsletterId: user.newsletterId });
		const jar = new Map();
		const confirmed = await runWithRequest({ jar, headers: { "x-forwarded-for": nextIp() } }, () => m.confirm.confirmSubscription(token));
		assert.deepEqual([confirmed.ok, confirmed.held], [true, true]);
		const stored = await findContact(user, "careful@gmail.com");
		assert.equal(stored.status, "held");
		assert.ok(stored.confirmedAt);
		assert.equal(jar.size, 0, "a held reader isn't signed in");

		const before = sesEmails.length;
		const approved = await api(user.key, "POST", "/contacts/approve", { newsletter: user.slug, contactIds: [String(stored._id)] });
		assert.deepEqual(approved.body, { approved: 1, remaining: null });
		const after = await findContact(user, "careful@gmail.com");
		assert.equal(after.status, "active");
		assert.ok(after.approvedAt);
		assert.ok(sesEmails.length > before, "the welcome email goes out on approval");
		assert.equal((await api(user.key, "POST", "/contacts/approve", { newsletter: user.slug, contactIds: [String(stored._id)] })).body.approved, 0, "a contact that is no longer held is skipped");
	});

	test("approve all and reject all take a batch and say how many are left; a reject deletes", async () => {
		const user = await setup("approve-batch", { signupApproval: true, requireConfirmation: false });
		for (const email of ["a@gmail.com", "b@gmail.com", "c@gmail.com"]) await signUp(user, email);
		const [a, b] = await Promise.all(["a@gmail.com", "b@gmail.com"].map((email) => findContact(user, email)));

		const rejected = await api(user.key, "POST", "/contacts/reject", { newsletter: user.slug, contactIds: [String(a._id)] });
		assert.deepEqual(rejected.body, { rejected: 1, remaining: null });
		assert.equal(await findContact(user, "a@gmail.com"), null, "nothing of a turned down signup is kept");
		await signUp(user, "a@gmail.com");
		assert.equal((await findContact(user, "a@gmail.com")).status, "held", "and they can ask again");

		const all = await api(user.key, "POST", "/contacts/approve", { newsletter: user.slug, all: true });
		assert.deepEqual(all.body, { approved: 3, remaining: 0 });
		assert.equal((await findContact(user, "b@gmail.com")).status, "active");
		assert.equal((await api(user.key, "POST", "/contacts/reject", { newsletter: user.slug, all: true })).body.rejected, 0, "an active contact is never rejected");
		assert.equal(String(b._id), String((await findContact(user, "b@gmail.com"))._id));
	});

	test("asks for contactIds or all, not both or neither, and real IDs", async () => {
		const user = await setup("approve-input", { signupApproval: true });
		assertError(await api(user.key, "POST", "/contacts/approve", { newsletter: user.slug }), 400, "validation_failed");
		assertError(await api(user.key, "POST", "/contacts/approve", { newsletter: user.slug, all: true, contactIds: ["6650f1c2e9b1d4a012345678"] }), 400, "validation_failed");
		assert.match(assertError(await api(user.key, "POST", "/contacts/reject", { newsletter: user.slug, contactIds: ["nope"] }), 400, "validation_failed"), /isn't a contact ID/);
	});

	test("an API key's signup is held too, a person added by hand is not, and a newsletter without approval holds nobody", async () => {
		const user = await setup("approve-api", { signupApproval: true, requireConfirmation: false });
		const added = await api(user.key, "POST", "/contacts", { newsletter: user.slug, email: "site@gmail.com" });
		assert.equal(added.body.status, "held");
		const byHand = await as(user, () => m.contactActions.addContact(null, form({ newsletterId: user.newsletterId, email: "friend@gmail.com", consent: "on" })));
		assert.equal(byHand.status, "active", "the owner's word stands in for the approval");

		const open = await setup("approve-off", { requireConfirmation: false });
		await signUp(open, "free@gmail.com");
		assert.equal((await findContact(open, "free@gmail.com")).status, "active");
	});

	test("a held contact is signed in nowhere, and webhook endpoints hear subscriber.approved", async () => {
		const user = await setup("approve-session", { signupApproval: true, requireConfirmation: false });
		assert.equal((await api(user.key, "POST", "/webhooks", { url: "https://hooks.example.com/in", events: ["subscriber.approved"] })).status, 201);
		await signUp(user, "late@gmail.com");
		const contact = await findContact(user, "late@gmail.com");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Open", status: "sent", sentAt: new Date(), archiveSlug: `open-${user.slug}`, format: "markdown", markdown: "Body text of the issue." });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { privateArchive: true } });

		const jar = new Map();
		await runWithRequest({ jar }, () => m.readerSession.startReaderSession(newsletter, contact._id));
		const asHeld = await runWithRequest({ jar }, () => m.readerActions.unlockIssue(user.slug, `open-${user.slug}`));
		assert.equal(asHeld.unlocked, false, "held readers read nothing");

		await api(user.key, "POST", "/contacts/approve", { newsletter: user.slug, all: true });
		const asActive = await runWithRequest({ jar }, () => m.readerActions.unlockIssue(user.slug, `open-${user.slug}`));
		assert.equal(asActive.unlocked, true);
		const deliveries = await m.WebhookDelivery.find({ accountId: user.accountId, type: "subscriber.approved" }).lean();
		assert.equal(deliveries.length, 1);
		assert.equal(JSON.parse(deliveries[0].payload).data.subscriber.email, "late@gmail.com");
	});
});

describe("a private website (U10)", () => {
	async function privateSite(name, { approval = true } = {}) {
		const user = await setup(name, { privateArchive: true, signupApproval: approval, requireConfirmation: false });
		await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Secret roadmap", previewText: "Seen by members", status: "sent", sentAt: new Date(), archiveSlug: `secret-${user.slug}`, format: "markdown", markdown: "The hidden plan is zeppelin.", tags: ["plans"], tagSlugs: ["plans"] });
		return user;
	}
	const open = (user) => m.issueModule.default(params(user, { post: `secret-${user.slug}` }));

	test("shows an issue's page to everyone as a gate with no title, no text and no search listing", async () => {
		const user = await privateSite("private-page");
		const page = html(await open(user));
		assert.match(page, /This newsletter is private/);
		assert.doesNotMatch(page, /Secret roadmap|zeppelin|Seen by members/);
		assert.match(page, /name="via" value="gate"/, "and the form to ask to join");

		const metadata = await m.issueModule.generateMetadata(params(user, { post: `secret-${user.slug}` }));
		assert.deepEqual(metadata.robots, { index: false, follow: false });
		assert.equal(metadata.title.absolute, "private-page news");
		assert.doesNotMatch(JSON.stringify(metadata), /Secret roadmap|zeppelin/);
		assert.doesNotMatch(page, /application\/ld\+json/, "no structured data about the issue");
	});

	test("its home page offers only the form, and says it is private to search engines and people", async () => {
		const user = await privateSite("private-home");
		const home = html(await m.homePage(params(user)));
		assert.match(home, /This newsletter is private/);
		assert.doesNotMatch(home, /Secret roadmap/);
		assert.deepEqual((await m.homeModule.generateMetadata(params(user))).robots, { index: false, follow: false });
	});

	test("closes the lists, the feed, the sitemap, llms.txt and the Markdown copy, and tells crawlers to stay out", async () => {
		const user = await privateSite("private-closed");
		assert.equal((await m.feedRoute.GET(new Request("https://x.test/feed.xml"), params(user))).status, 404);
		assert.equal((await m.sitemapRoute.GET(new Request("https://x.test/sitemap.xml"), params(user))).status, 404);
		assert.equal((await m.llmsRoute.GET(new Request("https://x.test/llms.txt"), params(user))).status, 404);
		assert.equal((await m.markdownRoute.GET(new Request("https://x.test/m"), params(user, { post: `secret-${user.slug}` }))).status, 404);
		await assert.rejects(m.issuesPage(params(user)), NOT_FOUND);
		await assert.rejects(m.tagPage(params(user, { tag: "plans" })), NOT_FOUND);
		const robots = await (await m.robotsRoute.GET(new Request("https://x.test/robots.txt"), params(user))).text();
		assert.match(robots, /Disallow: \/\n/);
		assert.doesNotMatch(robots, /Sitemap/);
	});

	test("opens the issue, with its title, for a signed-in active subscriber and for nobody else", async () => {
		const user = await privateSite("private-members");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const ask = (jar = new Map()) => runWithRequest({ jar }, () => m.readerActions.unlockIssue(user.slug, `secret-${user.slug}`));
		assert.equal((await ask()).unlocked, false, "a visitor");

		const sessionFor = async (email, status) => {
			const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status, source: "website" });
			const jar = new Map();
			await runWithRequest({ jar }, () => m.readerSession.startReaderSession(newsletter, contact._id));
			return jar;
		};
		assert.equal((await ask(await sessionFor("waiting@gmail.com", "held"))).unlocked, false, "waiting for approval");
		assert.equal((await ask(await sessionFor("gone@gmail.com", "unsubscribed"))).unlocked, false, "left");
		const member = await ask(await sessionFor("member@gmail.com", "active"));
		assert.equal(member.unlocked, true);
		assert.match(member.html, /zeppelin/);
		assert.deepEqual([member.title, member.subtitle], ["Secret roadmap", "Seen by members"]);
	});

	test("goes back to a public website when it is switched off, and a normal issue page carries no gate", async () => {
		const user = await privateSite("private-off");
		await api(user.key, "PATCH", `/newsletters/${user.slug}`, { privateArchive: false });
		const page = html(await open(user));
		assert.match(page, /zeppelin/);
		assert.equal((await m.feedRoute.GET(new Request("https://x.test/feed.xml"), params(user))).status, 200);
		assert.equal((await anonymous(() => m.llmsRoute.GET(new Request("https://x.test/llms.txt"), params(user)))).status, 200);
	});
});
