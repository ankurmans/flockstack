import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createConfirmToken } from "../lib/confirmation.js";
import { createRecommendToken } from "../lib/recommendation-token.js";
import { RECOMMENDATIONS_TAG } from "../lib/recommendation-tags.js";
import { addSentIssue, anonymous, activate, as, callApi, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { findAll, findWhere, renderShallow } from "./helpers/shallow.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

const SHARED_DOMAIN = "flockstackmail.com";
let app;
let m;
let sequence = 0;

// A paying account with a newsletter that can take a recommendation: confirmed signups, its website on and its first issue sent.
async function creator(name, { confirm = true, archive = true, issue = true, description = `All about ${name}.` } = {}) {
	const user = await signIn(`${name}@example.com`);
	await activate(user);
	user.slug = name;
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({
					name: `${name} news`,
					slug: name,
					description,
					fromEmail: `hello@${name}.${SHARED_DOMAIN}`,
					postalAddress: "1 Main St, Paris",
					...(archive && { archiveEnabled: "on" }),
					...(confirm && { requireConfirmation: "on" }),
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	// The sending subdomain is verified when a send checks it; these newsletters have sent before.
	await m.Newsletter.updateOne(
		{ accountId: user.accountId, _id: user.newsletterId },
		{ $set: { "sharedSender.domain": `${name}.${SHARED_DOMAIN}`, "sharedSender.provider": "ses", "sharedSender.verified": true } }
	);
	if (issue) await addSentIssue(user);
	return user;
}

const recommend = (from, to, pitch = "A short, friendly read.") =>
	callApi("POST", "/api/v1/recommendations", { key: from.key, body: { newsletter: from.slug, slug: to.slug, pitch } });
const list = async (user) => (await callApi("GET", `/api/v1/recommendations?newsletter=${user.slug}`, { key: user.key })).body;
const setSettings = (user, body) => callApi("PATCH", "/api/v1/recommendations/settings", { key: user.key, body: { newsletter: user.slug, ...body } });
const findContact = (user, email) => m.Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, email }).lean();
const recordOf = (from, to) => m.Recommendation.findOne({ accountId: from.accountId, recommenderId: from.newsletterId, recommendedId: to.newsletterId }).lean();

function visit(ip, run) {
	return runWithRequest({ jar: new Map(), headers: { "x-forwarded-for": ip } }, run);
}

const nextIp = () => `203.0.113.${++sequence}`;

async function signUp(user, email, extra = {}) {
	const result = await visit(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email, ...extra })));
	await flushAfter();
	return result;
}

async function confirm(user, email) {
	const contact = await findContact(user, email);
	const token = createConfirmToken({ contactId: contact._id, newsletterId: user.newsletterId });
	const result = await anonymous(() => m.confirm.confirmSubscription(token));
	await flushAfter();
	return result;
}

async function tick(step, slugs, ip = nextIp()) {
	const fields = new FormData();
	for (const slug of slugs) fields.append("newsletter", slug);
	const result = await visit(ip, () => m.archive.subscribeToRecommendations(step.token, null, fields));
	await flushAfter();
	return result;
}

function impression(body, { ip = nextIp(), userAgent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0" } = {}) {
	const request = new Request("http://localhost:3000/api/recommendations/impression", {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": userAgent, "x-forwarded-for": ip },
		body: JSON.stringify(body),
	});
	return m.impressionRoute.POST(request);
}

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		archive: await import("../app/archive/actions.js"),
		confirm: await import("../app/confirm/actions.js"),
		impressionRoute: await import("../app/api/recommendations/impression/route.js"),
		dashboardPage: await import("../app/(app)/recommending/page.js"),
		dashboardActions: await import("../app/(app)/recommending/actions.js"),
		directoryPage: await import("../app/(site)/recommendations/page.js"),
		docsPage: await import("../app/(site)/docs/recommendations/page.js"),
		docsLlms: await import("../lib/docs/llms.js"),
		lib: await import("../lib/recommendations.js"),
		rules: await import("../lib/recommendation-rules.js"),
		tags: await import("../lib/recommendation-tags.js"),
		sendingRules: await import("../lib/sending-rules.js"),
		archiveContent: await import("../lib/archive-content.js"),
		feed: await import("../lib/archive-feed.js"),
		FormRecommendedSubscribe: (await import("../components/FormRecommendedSubscribe.jsx")).default,
		FormRecommendations: (await import("../components/FormRecommendations.jsx")).default,
		DialogRemoveRecommendation: (await import("../components/DialogRemoveRecommendation.jsx")).default,
		Button: (await import("../components/ui/button.jsx")).Button,
		DialogTitle: (await import("../components/ui/dialog.jsx")).DialogTitle,
		ListRecommendations: (await import("../components/ListRecommendations.jsx")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Account: (await import("../models/Account.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Recommendation: (await import("../models/Recommendation.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
	};
});

after(() => app?.stop());

describe("adding a recommendation", () => {
	test("is free, shows on both newsletters' pages and never leaks the other account", async () => {
		const a = await creator("rec-add-a");
		const b = await creator("rec-add-b");
		const added = await recommend(a, b, "  Short notes on gardening,   every Friday. ");
		assert.equal(added.status, 201, JSON.stringify(added.body));
		assert.deepEqual(
			{ status: added.body.status, reason: added.body.reason, pitch: added.body.pitch, slug: added.body.newsletter.slug },
			{ status: "active", reason: null, pitch: "Short notes on gardening, every Friday.", slug: "rec-add-b" }
		);

		const mine = await list(a);
		assert.equal(mine.limit, 10);
		assert.equal(mine.outgoing.length, 1);
		const theirs = await list(b);
		assert.equal(theirs.incoming.length, 1);
		assert.deepEqual(
			{ slug: theirs.incoming[0].recommender.slug, pitch: theirs.incoming[0].pitch, signups: theirs.incoming[0].signups },
			{ slug: "rec-add-a", pitch: "Short notes on gardening, every Friday.", signups: 0 }
		);
		const text = JSON.stringify(theirs);
		assert.ok(!text.includes(String(a.accountId)) && !text.includes("@example.com"), "the recommender's account stays private");
	});

	test("is refused with a plain reason when the other newsletter can't take it", async () => {
		const a = await creator("rec-refuse-a");
		const refuse = async (target, pattern, label) => {
			const result = await recommend(a, target);
			assert.ok([400, 404, 409].includes(result.status), `${label}: ${result.status}`);
			assert.match(result.body.error.message, pattern, label);
			assert.equal(await m.Recommendation.countDocuments({ accountId: a.accountId, recommendedId: target.newsletterId }), 0, `${label} stored nothing`);
		};

		const unknown = await callApi("POST", "/api/v1/recommendations", { key: a.key, body: { slug: "no-such-news", pitch: "Nice." } });
		assert.equal(unknown.status, 404);
		assert.match(unknown.body.error.message, /same region/);

		const sibling = await m.Newsletter.create({ accountId: a.accountId, name: "Sibling", slug: "rec-refuse-sibling", fromEmail: "hello@rec-refuse-sibling.flockstackmail.com" });
		await refuse({ slug: sibling.slug, newsletterId: sibling._id }, /your own account/, "same account");

		const optedOut = await creator("rec-refuse-optout");
		assert.equal((await setSettings(optedOut, { allowIncoming: false })).status, 200);
		await refuse(optedOut, /turned off incoming recommendations/, "opted out");

		await refuse(await creator("rec-refuse-open", { confirm: false }), /doesn't ask new subscribers to confirm/, "no confirmed signups");
		await refuse(await creator("rec-refuse-nosite", { archive: false }), /website is off/, "website off");
		await refuse(await creator("rec-refuse-noissue", { issue: false }), /first issue/, "no first issue");

		const blocked = await creator("rec-refuse-frozen");
		await m.Account.updateOne({ _id: blocked.accountId }, { $set: { status: "paused", pauseReason: "Spam trap hit" } });
		await refuse(blocked, /can't take new subscribers right now/, "blocked account");
		const reason = (await recommend(a, blocked)).body.error.message;
		assert.doesNotMatch(reason, /blocked|paused|spam/i, "another account's block isn't told");

		const leaving = await creator("rec-refuse-leaving");
		await m.Account.updateOne({ _id: leaving.accountId }, { $set: { deletion: { requestedAt: new Date(), purgeAt: new Date(Date.now() + 86_400_000) } } });
		await refuse(leaving, /can't take new subscribers right now/, "waiting to be deleted");

		const unverified = await creator("rec-refuse-sender");
		await m.Newsletter.updateOne({ accountId: unverified.accountId, _id: unverified.newsletterId }, { $set: { fromEmail: "hi@not-verified.example.com" } });
		await refuse(unverified, /sending address isn't verified/, "unverified sending domain");
	});

	test("takes a plain-text pitch of at most 160 characters", async () => {
		const a = await creator("rec-pitch-a");
		const b = await creator("rec-pitch-b");
		const bad = {
			"": /Write a pitch/,
			[`${"x".repeat(161)}`]: /160 is the most/,
			"Read https://example.com/now": /without links/,
			"Read www.example.com": /without links/,
			"<b>Bold</b> claims": /plain text/,
			"Hi {{email}}": /plain text/,
		};
		for (const [pitch, pattern] of Object.entries(bad)) {
			const result = await recommend(a, b, pitch);
			assert.equal(result.status, 400, pitch);
			assert.match(result.body.error.message, pattern, pitch);
		}
		assert.equal((await recommend(a, b, "x".repeat(160))).status, 201);
		assert.equal((await recommend(a, b)).status, 409, "once per pair");
	});

	test("stops at ten, and a removed one makes room", async () => {
		const a = await creator("rec-ten-a");
		for (let index = 0; index < 10; index += 1) {
			await m.Recommendation.create({
				accountId: a.accountId,
				recommenderId: a.newsletterId,
				recommendedId: `6650f1c2e9b1d4a0${String(index).padStart(8, "0")}`,
				recommendedAccountId: "6650f1c2e9b1d4a0ffffffff",
				pitch: "Filler.",
				position: index,
			});
		}
		const b = await creator("rec-ten-b");
		const eleventh = await recommend(a, b);
		assert.equal(eleventh.status, 409);
		assert.match(eleventh.body.error.message, /up to 10 others/);

		const [first] = (await list(a)).outgoing;
		assert.equal((await callApi("DELETE", `/api/v1/recommendations/${first.id}?newsletter=${a.slug}`, { key: a.key })).status, 200);
		assert.equal((await recommend(a, b)).status, 201);
	});

	test("can be changed and removed; one that brought readers stays as a removed record with its counts", async () => {
		const a = await creator("rec-edit-a");
		const b = await creator("rec-edit-b");
		const { body: added } = await recommend(a, b, "First pitch.");
		const changed = await callApi("PATCH", `/api/v1/recommendations/${added.id}`, { key: a.key, body: { newsletter: a.slug, pitch: "Second pitch." } });
		assert.equal(changed.status, 200);
		assert.equal(changed.body.pitch, "Second pitch.");
		assert.equal(changed.body.side, "outgoing");

		await m.Recommendation.updateOne({ accountId: a.accountId, _id: added.id }, { $set: { "stats.signups": 4, "stats.confirmed": 3 } });
		const removed = await callApi("DELETE", `/api/v1/recommendations/${added.id}?newsletter=${a.slug}`, { key: a.key });
		assert.deepEqual(removed.body, { id: added.id, removed: true });
		const [kept] = (await list(a)).outgoing;
		assert.deepEqual([kept.status, kept.removedBy, kept.reason, kept.signups, kept.confirmed], ["removed", "recommender", "You removed it.", 4, 3]);
		assert.equal((await callApi("PATCH", `/api/v1/recommendations/${added.id}`, { key: a.key, body: { newsletter: a.slug, pitch: "Again." } })).status, 409);

		const back = await recommend(a, b, "Third pitch.");
		assert.equal(back.status, 201, JSON.stringify(back.body));
		assert.deepEqual([back.body.status, back.body.signups], ["active", 4], "the counts come back with it");
		assert.equal(await m.Recommendation.countDocuments({ accountId: a.accountId }), 1);
	});
});

describe("being recommended", () => {
	test("opting out hides it at once, with the reason, and opting in brings it back", async () => {
		const a = await creator("rec-out-a", { confirm: false });
		const b = await creator("rec-out-b");
		await recommend(a, b, "Worth a read.");
		const live = async () => (await m.lib.listLiveRecommendations(await m.Newsletter.findOne({ slug: a.slug }).setOptions({ crossAccount: true }).lean())).map(({ slug }) => slug);
		assert.deepEqual(await live(), ["rec-out-b"]);

		await setSettings(b, { listed: true });
		assert.equal((await setSettings(b, { allowIncoming: false })).body.listed, false, "opting out also leaves the directory");
		assert.deepEqual(await live(), []);
		const [pending] = (await list(a)).outgoing;
		assert.deepEqual([pending.status, pending.reason], ["pending", "rec-out-b news has turned off incoming recommendations."]);
		assert.equal((await signUp(a, "reader-out@example.org")).step, undefined, "no step for a reader while nothing can show");

		await setSettings(b, { allowIncoming: true });
		assert.deepEqual(await live(), ["rec-out-b"]);
		assert.equal((await list(a)).outgoing[0].status, "active");
	});

	test("lets its owner decline one recommendation with a reason its recommender reads, and bring it back", async () => {
		const a = await creator("rec-decline-a");
		const b = await creator("rec-decline-b");
		const { body: added } = await recommend(a, b, "Good stuff.");
		const wrongOwner = await callApi("PATCH", `/api/v1/recommendations/${added.id}`, { key: a.key, body: { newsletter: a.slug, decision: "decline" } });
		assert.equal(wrongOwner.status, 404, "the recommender can't decline for the other side");

		const declined = await callApi("PATCH", `/api/v1/recommendations/${added.id}`, {
			key: b.key,
			body: { newsletter: b.slug, decision: "decline", reason: "We don't swap with newsletters about crypto." },
		});
		assert.equal(declined.status, 200, JSON.stringify(declined.body));
		assert.deepEqual([declined.body.side, declined.body.status, declined.body.removedBy], ["incoming", "removed", "recommended"]);

		const [seen] = (await list(a)).outgoing;
		assert.deepEqual([seen.status, seen.removedBy, seen.reason], ["removed", "recommended", "We don't swap with newsletters about crypto."]);
		const again = await recommend(a, b, "Please?");
		assert.equal(again.status, 409);
		assert.match(again.body.error.message, /declined your recommendation: We don't swap with newsletters about crypto\./);

		const restored = await callApi("PATCH", `/api/v1/recommendations/${added.id}`, { key: b.key, body: { newsletter: b.slug, decision: "restore" } });
		assert.equal(restored.body.status, "active");
		assert.equal((await list(a)).outgoing[0].status, "active");
		assert.equal((await callApi("PATCH", `/api/v1/recommendations/${added.id}`, { key: b.key, body: { newsletter: b.slug, decision: "restore" } })).status, 409);

		const noReason = await callApi("PATCH", `/api/v1/recommendations/${added.id}`, { key: b.key, body: { newsletter: b.slug, decision: "decline" } });
		assert.match(noReason.body.reason, /declined this recommendation/, "a removal always has a reason");
	});

	test("a closed account's recommendations turn pending with the reason, and come back by themselves", async () => {
		const a = await creator("rec-pause-a");
		const b = await creator("rec-pause-b");
		await recommend(a, b);
		await m.Newsletter.updateOne({ accountId: b.accountId, _id: b.newsletterId }, { $set: { requireConfirmation: false } });
		const [pending] = (await list(a)).outgoing;
		assert.equal(pending.status, "pending");
		assert.match(pending.reason, /doesn't ask new subscribers to confirm/);
		await m.Newsletter.updateOne({ accountId: b.accountId, _id: b.newsletterId }, { $set: { requireConfirmation: true } });
		assert.equal((await list(a)).outgoing[0].status, "active");
	});
});

describe("the step after a signup", () => {
	test("offers the recommended newsletters unticked, and a tick is a normal signup with the other newsletter's confirmation", async () => {
		const a = await creator("rec-step-a", { confirm: false });
		const b = await creator("rec-step-b");
		const c = await creator("rec-step-c");
		await recommend(a, b, "Plain talk about pottery.");
		await recommend(a, c, "A newsletter about cheese.");

		const result = await signUp(a, "reader@example.org");
		assert.equal(result.ok, true);
		assert.deepEqual(result.step.recommendations.map(({ slug }) => slug), ["rec-step-b", "rec-step-c"]);
		assert.equal(result.step.newsletterName, "rec-step-a news");
		assert.deepEqual(Object.keys(result.step.recommendations[0]).sort(), ["description", "imageUrl", "name", "pitch", "slug"], "nothing about either newsletter's readers or account");

		const html = renderToStaticMarkup(createElement(m.FormRecommendedSubscribe, { step: result.step }));
		assert.match(html, /You might also like/);
		assert.match(html, /Plain talk about pottery\./);
		assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2, "one checkbox for each");
		assert.doesNotMatch(html, /<input[^>]*\bchecked\b/, "nothing is ticked");
		assert.match(html, /Subscribe/);

		assert.equal(await findContact(b, "reader@example.org"), null, "nothing is shared before the tick");
		const outcome = await tick(result.step, ["rec-step-b"]);
		assert.deepEqual(outcome, { ok: true, joined: [{ name: "rec-step-b news", isPending: true }] });

		const joined = await findContact(b, "reader@example.org");
		assert.deepEqual([joined.status, joined.source], ["pending", "recommendation:rec-step-a"]);
		assert.equal(await findContact(c, "reader@example.org"), null, "the one that wasn't ticked never gets the address");
		const confirmation = await m.Message.findOne({ accountId: b.accountId, kind: "confirmation", contactId: joined._id }).lean();
		assert.ok(confirmation, "b asks them to confirm in its own email");
		assert.ok(sesEmails.some((email) => [email.to].flat().includes("reader@example.org") && /rec-step-b/.test(JSON.stringify(email))), "sent from b's own address");
		assert.equal(await m.Message.countDocuments({ accountId: c.accountId, contactId: { $exists: true } }), 0);

		const record = await recordOf(a, b);
		assert.deepEqual([record.stats.signups, record.stats.confirmed], [1, 0]);
		await confirm(b, "reader@example.org");
		assert.equal((await recordOf(a, b)).stats.confirmed, 1);
		assert.equal((await findContact(b, "reader@example.org")).status, "active");
	});

	test("comes after the confirmation click when the newsletter confirms signups", async () => {
		const a = await creator("rec-confirm-a");
		const b = await creator("rec-confirm-b");
		await recommend(a, b, "Yes please.");

		const pending = await signUp(a, "later@example.org");
		assert.equal(pending.pending, true);
		assert.equal(pending.step, undefined, "an address nobody proved doesn't get a step");

		const confirmed = await confirm(a, "later@example.org");
		assert.equal(confirmed.ok, true);
		assert.deepEqual(confirmed.step.recommendations.map(({ slug }) => slug), ["rec-confirm-b"]);
		assert.equal(await findContact(b, "later@example.org"), null);
		assert.equal((await tick(confirmed.step, ["rec-confirm-b"])).ok, true);
		assert.equal((await findContact(b, "later@example.org")).source, "recommendation:rec-confirm-a");
	});

	test("refuses nothing ticked, a newsletter that isn't recommended, a stale page and a forged token", async () => {
		const a = await creator("rec-guard-a", { confirm: false });
		const b = await creator("rec-guard-b");
		const other = await creator("rec-guard-other");
		await recommend(a, b);
		const { step } = await signUp(a, "guard@example.org");

		assert.match((await tick(step, [])).error, /Tick the newsletters/);
		assert.match((await tick(step, ["rec-guard-other"])).error, /Tick the newsletters/);
		assert.equal(await findContact(other, "guard@example.org"), null, "not recommended, so not reachable");
		assert.equal(await findContact(b, "guard@example.org"), null);

		const stale = createRecommendToken({ contactId: (await findContact(a, "guard@example.org"))._id, newsletterId: a.newsletterId }, Date.now() - 3 * 3_600_000);
		assert.match((await tick({ token: stale }, ["rec-guard-b"])).error, /expired/);
		assert.match((await tick({ token: `${step.token}x` }, ["rec-guard-b"])).error, /expired/);
		const confirmToken = createConfirmToken({ contactId: (await findContact(a, "guard@example.org"))._id, newsletterId: a.newsletterId });
		assert.match((await tick({ token: confirmToken }, ["rec-guard-b"])).error, /expired/, "a confirmation link is not a step token");
		assert.equal(await findContact(b, "guard@example.org"), null);

		await setSettings(b, { allowIncoming: false });
		assert.match((await tick(step, ["rec-guard-b"])).error, /Tick the newsletters/, "an opt-out after the page loaded still holds");
		assert.equal(await findContact(b, "guard@example.org"), null);
	});

	test("keeps the other newsletter's consent rules: an address on its never-email list is not signed up", async () => {
		const a = await creator("rec-consent-a", { confirm: false });
		const b = await creator("rec-consent-b");
		await recommend(a, b);
		await m.Suppression.create({ accountId: b.accountId, email: "gone@example.org", reason: "manual" });
		const { step } = await signUp(a, "gone@example.org");
		const outcome = await tick(step, ["rec-consent-b"]);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.joined[0].isPending, false);
		const contact = await findContact(b, "gone@example.org");
		assert.equal(contact.status, "unsubscribed", "it stays as it was");
		assert.equal(await m.Message.countDocuments({ accountId: b.accountId, contactId: contact._id }), 0, "no email goes to it");
		assert.equal((await recordOf(a, b)).stats.signups, 0, "and it counts for nothing");
	});

	test("an address that already follows the other newsletter isn't counted or emailed again", async () => {
		const a = await creator("rec-twice-a", { confirm: false });
		const b = await creator("rec-twice-b");
		await recommend(a, b);
		await m.Contact.create({ accountId: b.accountId, newsletterId: b.newsletterId, email: "old@example.org", status: "active", source: "website" });
		const { step } = await signUp(a, "old@example.org");
		const outcome = await tick(step, ["rec-twice-b"]);
		assert.deepEqual(outcome.joined, [{ name: "rec-twice-b news", isPending: false }]);
		assert.equal((await findContact(b, "old@example.org")).source, "website");
		assert.equal((await recordOf(a, b)).stats.signups, 0);
	});

	test("stops a network that signs readers up too fast", async () => {
		const ip = nextIp();
		const results = [];
		for (let index = 0; index < 7; index += 1) results.push(await visit(ip, () => m.archive.subscribeToRecommendations("not-a-token", null, new FormData())));
		assert.ok(results.slice(0, 6).every(({ error }) => /expired/.test(error)));
		assert.match(results[6].error, /Too many signups from your network/);
	});

	test("counts at most 300 signups a day from one newsletter to another", async () => {
		const a = await creator("rec-cap-a", { confirm: false });
		const b = await creator("rec-cap-b");
		await recommend(a, b);
		const { step } = await signUp(a, "cap@example.org");
		const { isRateLimited } = await import("../lib/rate-limit.js");
		for (let index = 0; index < 300; index += 1) {
			assert.equal(await isRateLimited({ name: "recommendation-pair", limit: 300, window: "1 d", key: "rec-cap-a:rec-cap-b" }), false);
		}
		const outcome = await tick(step, ["rec-cap-b"]);
		assert.match(outcome.error, /aren't taking signups right now/);
		assert.equal(await findContact(b, "cap@example.org"), null);
	});
});

describe("links to a recommendation", () => {
	test("count a signup and a confirmation for the newsletter whose link was followed, once", async () => {
		const a = await creator("rec-link-a");
		const b = await creator("rec-link-b");
		const c = await creator("rec-link-c");
		await recommend(a, b);

		await signUp(b, "follower@example.org", { rec: "rec-link-a" });
		assert.equal((await findContact(b, "follower@example.org")).source, "recommendation:rec-link-a");
		assert.deepEqual([(await recordOf(a, b)).stats.signups, (await recordOf(a, b)).stats.confirmed], [1, 0]);
		await confirm(b, "follower@example.org");
		assert.equal((await recordOf(a, b)).stats.confirmed, 1);
		await confirm(b, "follower@example.org");
		assert.equal((await recordOf(a, b)).stats.confirmed, 1, "a second click on the link counts for nothing");

		await signUp(b, "follower@example.org", { rec: "rec-link-a" });
		assert.equal((await recordOf(a, b)).stats.signups, 1, "the same reader again isn't a new signup");

		await signUp(b, "stranger@example.org", { rec: "rec-link-c" });
		assert.equal((await findContact(b, "stranger@example.org")).source, "website", "c doesn't recommend b");
		await signUp(b, "bogus@example.org", { rec: "../../x" });
		assert.equal((await findContact(b, "bogus@example.org")).source, "website");
		await signUp(b, "own@example.org", { rec: "rec-link-b" });
		assert.equal((await findContact(b, "own@example.org")).source, "website", "a newsletter can't send itself readers");
		assert.equal(await m.Recommendation.countDocuments({ accountId: c.accountId }), 0);

		await setSettings(b, { allowIncoming: false });
		await signUp(b, "late@example.org", { rec: "rec-link-a" });
		assert.equal((await findContact(b, "late@example.org")).source, "website", "after an opt-out nothing is attributed");
	});

	test("show in the stats of both newsletters, and in the dashboard", async () => {
		const a = await creator("rec-stats-a");
		const b = await creator("rec-stats-b");
		await recommend(a, b, "Stats pitch.");
		for (const name of ["one", "two", "three"]) await signUp(b, `${name}@example.org`, { rec: "rec-stats-a" });
		await confirm(b, "one@example.org");
		await confirm(b, "two@example.org");
		assert.equal((await impression({ newsletter: "rec-stats-a", shown: ["rec-stats-b"] })).status, 204);

		const given = (await callApi("GET", `/api/v1/recommendations/stats?newsletter=${a.slug}`, { key: a.key })).body;
		assert.deepEqual(given.given, { impressions: 1, signups: 3, confirmed: 2 });
		assert.deepEqual(given.outgoing.map(({ newsletter, signups }) => [newsletter, signups]), [["rec-stats-b", 3]]);
		const received = (await callApi("GET", `/api/v1/recommendations/stats?newsletter=${b.slug}`, { key: b.key })).body;
		assert.deepEqual(received.received, { impressions: 1, signups: 3, confirmed: 2 });
		assert.deepEqual(received.incoming.map(({ recommender }) => recommender), ["rec-stats-a"]);

		const render = async (user) => as(user, async () => renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.dashboardPage.default())));
		const html = await render(b);
		assert.match(html, /Recommendations of you/);
		assert.match(html, /rec-stats-a news/);
		assert.match(html, /Stats pitch\./);
		assert.match(html, /Subscribers gained/);
		assert.match(await render(a), /rec-stats-b news/);
		assert.match(await render(a), /Free for everyone: no paid placement and no cut of anyone&#x27;s revenue/);
	});
});

describe("impressions", () => {
	test("count a page that showed a recommendation, with no personal data, and ignore bots and strangers", async () => {
		const a = await creator("rec-imp-a");
		const b = await creator("rec-imp-b");
		const c = await creator("rec-imp-c");
		await recommend(a, b);
		const read = async () => (await recordOf(a, b)).stats.impressions;

		assert.equal((await impression({ newsletter: "rec-imp-a", shown: ["rec-imp-b"] })).status, 204);
		assert.equal(await read(), 1);
		await impression({ newsletter: "rec-imp-a", shown: ["rec-imp-b"] }, { userAgent: "Googlebot/2.1" });
		await impression({ newsletter: "rec-imp-a", shown: ["rec-imp-b"] }, { userAgent: "" });
		await impression({ newsletter: "rec-imp-a", shown: ["rec-imp-c"] });
		await impression({ newsletter: "no-such-news", shown: ["rec-imp-b"] });
		await impression({ newsletter: 12, shown: "rec-imp-b" });
		assert.equal(await read(), 1);
		assert.equal(await m.Recommendation.countDocuments({ accountId: a.accountId, recommendedId: c.newsletterId }), 0);

		const keys = Object.keys((await recordOf(a, b)).stats).sort();
		assert.deepEqual(keys, ["confirmed", "impressions", "signups"], "only counters are kept");
		const sample = await m.Recommendation.findOne({ accountId: a.accountId }).lean();
		assert.ok(!JSON.stringify(sample).match(/ip|agent|203\.0\.113/i), "nothing about the visitor is stored");
	});

	test("are limited per network and newsletter", async () => {
		const a = await creator("rec-imp-rate-a");
		const b = await creator("rec-imp-rate-b");
		await recommend(a, b);
		const ip = nextIp();
		for (let index = 0; index < 14; index += 1) await impression({ newsletter: "rec-imp-rate-a", shown: ["rec-imp-rate-b"] }, { ip });
		assert.equal((await recordOf(a, b)).stats.impressions, 10, "a script past ten an hour stops being counted");
		await impression({ newsletter: "rec-imp-rate-a", shown: ["rec-imp-rate-b"] });
		assert.equal((await recordOf(a, b)).stats.impressions, 11, "another visitor still counts");
	});
});

describe("the merge tag and the website section", () => {
	const items = [
		{ name: "Pottery Weekly", pitch: "Plain talk about pottery.", url: "https://pottery.flockstackmail.com/?rec=weekly#subscribe" },
		{ name: "Cheese <Club>", pitch: "Hi {{email}}", url: "https://cheese.flockstackmail.com/?rec=weekly#subscribe" },
	];
	const contact = { _id: "6650f1c2e9b1d4a012345678", email: "ann@example.org" };

	function render(newsletter, campaign, recommendations) {
		return m.sendingRules.buildRecipientEmail({ campaign, newsletter, contact, messageId: "6650f1c2e9b1d4a0aaaaaaaa", sender: {}, recommendations });
	}

	test("print links to the signup pages in rich, HTML and Markdown emails, with nothing ticked or subscribed", async () => {
		const a = await creator("rec-tag-a");
		const newsletter = await m.Newsletter.findOne({ slug: a.slug }).setOptions({ crossAccount: true }).lean();
		const campaigns = {
			rich: { format: "rich", subject: "Hi", html: `<p>Thanks for reading.</p><p>${RECOMMENDATIONS_TAG}</p>` },
			html: { format: "html", subject: "Hi", html: `<html><body><p>Thanks.</p>${RECOMMENDATIONS_TAG}</body></html>` },
			markdown: { format: "markdown", subject: "Hi", markdown: `Thanks for reading.\n\n${RECOMMENDATIONS_TAG}` },
		};
		for (const [format, campaign] of Object.entries(campaigns)) {
			const email = render(newsletter, campaign, items);
			assert.match(email.html, /Recommended newsletters/, format);
			assert.match(email.html, /Pottery Weekly/, format);
			assert.match(email.html, /Plain talk about pottery\./, format);
			assert.doesNotMatch(email.html, /\{\{recommendations\}\}/, format);
			assert.doesNotMatch(email.html, /<input|checkbox|checked/i, `${format}: nothing is pre-ticked`);
			const tracked = [...email.html.matchAll(/\/c\/[0-9a-f]{24}\.[A-Za-z0-9_-]{22}\.(?:\d+\.)?([A-Za-z0-9_-]+)/g)].map(([, encoded]) => Buffer.from(encoded, "base64url").toString());
			assert.ok(tracked.includes(items[0].url), `${format}: the links are tracked clicks`);
			assert.match(email.text, /Recommended newsletters\n- Pottery Weekly: Plain talk about pottery\.\n {2}https:\/\/pottery\.flockstackmail\.com\/\?rec=weekly#subscribe/, format);
			assert.doesNotMatch(email.text, /\{\{recommendations\}\}/, format);
			assert.doesNotMatch(email.html, /Cheese <Club>|ann@example\.org/, `${format}: names are escaped and a pitch can't pull in a merge tag`);
		}
		assert.match(render(newsletter, campaigns.rich, items).html, /Cheese &lt;Club&gt;/);
		assert.match(render(newsletter, campaigns.rich, items).html, /Hi \{ \{email\} \}/);
		assert.doesNotMatch(render(newsletter, campaigns.rich, items).html, /<p[^>]*>\s*<div/, "a block never sits inside a paragraph");
	});

	test("print nothing without recommendations and stay as written when there is nothing to fill", async () => {
		const a = await creator("rec-tag-b");
		const newsletter = await m.Newsletter.findOne({ slug: a.slug }).setOptions({ crossAccount: true }).lean();
		const campaign = { format: "rich", subject: "Hi", html: `<p>Before.</p><p>${RECOMMENDATIONS_TAG}</p><p>After.</p>` };
		const empty = render(newsletter, campaign, []);
		assert.doesNotMatch(empty.html, /recommendations|Recommended/i);
		assert.match(empty.html, /Before\.[\s\S]*After\./);
		assert.match(render(newsletter, campaign, null).html, /\{\{recommendations\}\}/, "null leaves the source, as an export does");
		assert.equal(m.tags.fillRecommendationsTag("<p>x</p>", items), "<p>x</p>");
	});

	test("show on the website in the article's own style, and an RSS feed reader gets them too", async () => {
		const a = await creator("rec-tag-c");
		const newsletter = await m.Newsletter.findOne({ slug: a.slug }).setOptions({ crossAccount: true }).lean();
		const issue = { format: "rich", subject: "Hi", html: `<p>Words.</p><p>${RECOMMENDATIONS_TAG}</p>` };
		const web = m.archiveContent.renderIssueBody(issue, { recommendations: items });
		assert.equal(web.kind, "article");
		assert.match(web.html, /<h3>Recommended newsletters<\/h3><ul><li><a href="https:\/\/pottery\.flockstackmail\.com\/\?rec=weekly#subscribe"><strong>Pottery Weekly<\/strong><\/a>: Plain talk about pottery\.<\/li>/);
		assert.doesNotMatch(web.html, /input|checkbox/i);
		assert.doesNotMatch(m.archiveContent.renderIssueBody(issue, { recommendations: [] }).html, /recommendations|Recommended/i);
		assert.match(m.archiveContent.renderIssueBody(issue, { recommendations: null }).html, /\{\{recommendations\}\}/);
		assert.match(m.archiveContent.renderIssueBody({ ...issue, format: "html", html: `<html><body>${RECOMMENDATIONS_TAG}</body></html>` }, { recommendations: items }).html, /background:#f4f4f5/);

		const { xml } = m.feed.buildFeed({
			newsletter,
			issues: [{ _id: "6650f1c2e9b1d4a0aaaaaaaa", ...issue, archiveSlug: "hi", sentAt: new Date(), status: "sent" }],
			recommendations: items,
		});
		assert.match(xml, /Pottery Weekly/);
		assert.doesNotMatch(xml, /\{\{recommendations\}\}/);
	});

	test("reach a subscriber in the email a newsletter really sends, from what it recommends now", async () => {
		const a = await creator("rec-send-a", { confirm: false });
		const b = await creator("rec-send-b");
		const c = await creator("rec-send-c");
		await recommend(a, b, "Pottery, plainly.");
		await recommend(a, c, "Cheese, plainly.");
		await m.Newsletter.updateOne(
			{ accountId: a.accountId, _id: a.newsletterId },
			{ $set: { welcome: { enabled: true, subject: "Welcome", markdown: `Glad you're here.\n\n${RECOMMENDATIONS_TAG}` } } }
		);
		m.lib.forgetEmailRecommendations();
		await setSettings(c, { allowIncoming: false });

		await signUp(a, "welcome@example.org");
		const email = sesEmails.findLast((item) => [item.to].flat().includes("welcome@example.org"));
		assert.ok(email, "the welcome email went out");
		const body = JSON.stringify(email);
		assert.match(body, /rec-send-b news/);
		assert.match(body, /Pottery, plainly\./);
		assert.doesNotMatch(body, /Cheese, plainly\./, "a newsletter that opted out isn't in it");
		assert.match(body, /rec%3Drec-send-a|rec=rec-send-a|cmVjPXJlYy1zZW5kLWE/, "the link names the recommender");
	});

	test("show on the archive home and issue pages as cards that link to the other newsletter's signup, nothing ticked", async () => {
		const html = renderToStaticMarkup(
			createElement(m.ListRecommendations, {
				newsletterSlug: "weekly",
				items: [{ slug: "pottery", name: "Pottery Weekly", pitch: "Plain talk about pottery.", imageUrl: null, url: items[0].url }],
			})
		);
		assert.match(html, /Recommended newsletters/);
		assert.ok(html.includes(`href="${items[0].url}"`));
		assert.doesNotMatch(html, /<input|checked/i);
		assert.equal(renderToStaticMarkup(createElement(m.ListRecommendations, { newsletterSlug: "weekly", items: [] })), "");
	});
});

describe("the directory", () => {
	async function listed(name, { description = `All about ${name}.`, readers = 0, ...options } = {}) {
		const user = await creator(name, { description, ...options });
		assert.equal((await setSettings(user, { listed: true })).status, options.archive === false ? 400 : 200, name);
		for (let index = 0; index < readers; index += 1) {
			await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: `reader${index}@example.org`, status: "active", source: "website" });
		}
		return user;
	}

	const render = async (searchParams = {}) => renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.directoryPage.default({ searchParams: Promise.resolve(searchParams) })));

	test("lists only newsletters that chose it, take recommendations and can take a signup, with a range and never an exact number", async () => {
		const open = await listed("dir-open-pottery", { readers: 137, description: "Plain talk about pottery." });
		await creator("dir-unlisted-pottery");
		const optedOut = await listed("dir-optout-pottery");
		await m.Newsletter.updateOne({ accountId: optedOut.accountId, _id: optedOut.newsletterId }, { $set: { "recommendations.allowIncoming": false } });
		const noSite = await listed("dir-nosite-pottery");
		await m.Newsletter.updateOne({ accountId: noSite.accountId, _id: noSite.newsletterId }, { $set: { archiveEnabled: false } });
		const noConfirm = await listed("dir-noconfirm-pottery");
		await m.Newsletter.updateOne({ accountId: noConfirm.accountId, _id: noConfirm.newsletterId }, { $set: { requireConfirmation: false } });
		const blocked = await listed("dir-blocked-pottery");
		await m.Account.updateOne({ _id: blocked.accountId }, { $set: { status: "paused" } });
		const noIssue = await listed("dir-noissue-pottery", { issue: false });

		const html = await render({ q: "pottery" });
		assert.match(html, /dir-open-pottery news/);
		assert.match(html, /Plain talk about pottery\./);
		assert.match(html, /100 to 500 subscribers/);
		assert.doesNotMatch(html, /\b137\b/, "no exact number");
		assert.doesNotMatch(html, /reader\d+@example/, "no reader data");
		for (const hidden of ["dir-unlisted", "dir-optout", "dir-nosite", "dir-noconfirm", "dir-blocked", "dir-noissue"]) {
			assert.ok(!html.includes(`${hidden}-pottery news`), `${hidden} is not listed`);
		}
		assert.ok(html.includes(open.slug) === false || html.includes("Visit the website"));
		assert.match(html, /href="https:\/\/dir-open-pottery\.flockstackmail\.com\/"/);
		assert.match(html, /same region/);
		assert.equal(noIssue.slug, "dir-noissue-pottery");
	});

	test("searches by name and description, and says so when nothing matches", async () => {
		await listed("dir-find-saffron", { description: "Spices and slow cooking." });
		await listed("dir-find-garden", { description: "Saffron in the garden, apparently." });
		assert.match(await render({ q: "saffron" }), /dir-find-garden news[\s\S]*dir-find-saffron news/, "by name");
		assert.doesNotMatch(await render({ q: "slow cooking" }), /dir-find-garden news/);
		assert.match(await render({ q: "zzzzqq" }), /No listed newsletter matches &quot;zzzzqq&quot;/);
		assert.match(await render({}), /dir-find-saffron news/);
	});

	test("lets a search engine index the directory itself but not a search of it", async () => {
		const plain = await m.directoryPage.generateMetadata({ searchParams: Promise.resolve({}) });
		assert.equal(plain.robots, undefined);
		assert.equal(plain.alternates.canonical, "/recommendations");
		const search = await m.directoryPage.generateMetadata({ searchParams: Promise.resolve({ q: "x" }) });
		assert.deepEqual(search.robots, { index: false, follow: true });
	});

	test("pages through the results", async () => {
		for (let index = 0; index < 13; index += 1) {
			const name = `dir-page-${String(index).padStart(2, "0")}`;
			const user = await creator(name);
			await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "recommendations.listed": true } });
		}
		const first = await render({ q: "dir-page" });
		assert.match(first, /dir-page-00 news/);
		assert.doesNotMatch(first, /dir-page-12 news/);
		assert.match(first, /href="\/recommendations\?q=dir-page&amp;page=2"/);
		const second = await render({ q: "dir-page", page: "2" });
		assert.match(second, /dir-page-12 news/);
		assert.match(second, /Previous/);
		assert.doesNotMatch(second, /Next →/);
	});

	test("is searched from the API without your own newsletters, and the dashboard action sees the same", async () => {
		const mine = await listed("dir-api-mine-tea");
		await listed("dir-api-other-tea", { readers: 3 });
		const result = await callApi("GET", "/api/v1/recommendations/search?query=dir-api", { key: mine.key });
		assert.equal(result.status, 200, JSON.stringify(result.body));
		assert.deepEqual(result.body.newsletters.map(({ slug }) => slug), ["dir-api-other-tea"]);
		assert.deepEqual(Object.keys(result.body.newsletters[0]).sort(), ["description", "imageUrl", "name", "slug", "subscriberRange", "url"]);
		assert.equal(result.body.newsletters[0].subscriberRange, "Under 100");
		assert.equal(result.body.hasMore, false);
	});

	test("needs the website on and incoming recommendations allowed to list", async () => {
		const quiet = await creator("dir-quiet", { archive: false });
		const result = await setSettings(quiet, { listed: true });
		assert.equal(result.status, 400);
		assert.match(result.body.error.message, /Turn the website on first/);
		const open = await creator("dir-quiet-open");
		const both = await setSettings(open, { allowIncoming: false, listed: true });
		assert.equal(both.status, 400);
		assert.match(both.body.error.message, /turned off incoming recommendations/);
		assert.equal((await setSettings(open, { listed: true })).body.listed, true);
		assert.equal((await setSettings(open, {})).body.listed, true, "an empty change keeps what is set");
	});
});

describe("regions and docs", () => {
	test("say that recommendations stay inside a region, in the refusal and on the docs page", async () => {
		const a = await creator("rec-region-a");
		const us = await callApi("POST", "/api/v1/recommendations", { key: a.key, body: { slug: "elsewhere-news", pitch: "Nice." } });
		assert.match(us.body.error.message, /No newsletter with the slug "elsewhere-news" in this region\. Recommendations only work between newsletters in the same region, and this is the United States region\./);
		const eu = await withEnv({ FLOCKSTACK_REGION: "eu" }, () => callApi("POST", "/api/v1/recommendations", { key: a.key, body: { slug: "elsewhere-news", pitch: "Nice." } }));
		assert.match(eu.body.error.message, /this is the European Union region\./);

		const docs = renderToStaticMarkup(createElement(m.TooltipProvider, null, createElement(m.docsPage.default)));
		assert.ok(docs.includes(m.rules.REGION_RULE), "the docs page states the rule");
		assert.match(docs, /same region/);
		assert.match(docs, /no paid\s+placement/);
		const llms = m.docsLlms.getLlmsFull("https://flockstack.io");
		assert.ok(llms.includes(m.rules.REGION_RULE), "so do the llms files, through the actions' descriptions");
		const page = m.docsLlms.DOC_PAGES.find(({ href }) => href === "/docs/recommendations");
		assert.ok(page && m.docsLlms.getLlmsIndex("https://flockstack.io").includes("(https://flockstack.io/docs/recommendations)"));
		assert.equal(m.docsLlms.getDocsPageMetadata("/docs/recommendations").alternates.canonical, "/docs/recommendations");
	});

	test("rate limit adding, per key and per account, and the dashboard counts too", async () => {
		const a = await creator("rec-limit-a");
		const statuses = [];
		for (let index = 0; index < 31; index += 1) {
			statuses.push((await callApi("POST", "/api/v1/recommendations", { key: a.key, body: { slug: "nobody-news", pitch: "Nice." } })).status);
		}
		assert.deepEqual([...new Set(statuses.slice(0, 30))], [404], "thirty tries are answered");
		assert.equal(statuses[30], 429);
		const search = [];
		for (let index = 0; index < 121; index += 1) search.push((await callApi("GET", "/api/v1/recommendations/search", { key: a.key })).status);
		assert.equal(search[119], 200);
		assert.equal(search[120], 429, "so is searching the directory");
	});
});

describe("removing one from the dashboard", () => {
	const buttonNamed = (tree, label) => findWhere(tree, (node) => node.type === m.Button && node.props["aria-label"] === label);
	const buttonSaying = (tree, text) =>
		findWhere(tree, (node) => node.type === m.Button && [node.props.children].flat(Infinity).includes(text));

	async function rowsOf(user) {
		const data = { ...(await list(user)), limit: 10 };
		return renderShallow(createElement(m.FormRecommendations, { newsletterId: user.newsletterId, data }), { expand: ["RowOutgoing"] });
	}

	test("asks first, in a dialog, and only the dialog's button removes it", async () => {
		const a = await creator("rec-ask-a");
		const b = await creator("rec-ask-b");
		const { body: added } = await recommend(a, b, "Short and kind.");

		const { tree, transitions } = await rowsOf(a);
		const [trash] = buttonNamed(tree, "Stop recommending rec-ask-b news");
		trash.props.onClick();
		assert.equal(transitions.length, 0, "the trash button only opens the dialog");
		const [dialog] = findAll(tree, m.DialogRemoveRecommendation);
		assert.deepEqual([dialog.props.item.id, dialog.props.isOpen], [added.id, false]);
		assert.equal((await recordOf(a, b)).status, "active");

		const opened = renderShallow(createElement(m.DialogRemoveRecommendation, { ...dialog.props, isOpen: true }));
		const html = renderToStaticMarkup(createElement("div", null, findAll(opened.tree, m.DialogTitle).map((node) => node.props.children)));
		assert.equal(html, "<div>Stop recommending rec-ask-b news?</div>");
		const [cancel] = buttonSaying(opened.tree, "Cancel");
		assert.equal(cancel.props.onClick, undefined, "Cancel only closes the dialog");
		const [confirm] = findWhere(opened.tree, (node) => node.type === m.Button && node.props.variant === "destructive");
		await as(a, () => {
			confirm.props.onClick();
			return Promise.all(opened.transitions);
		});
		const removed = await recordOf(a, b);
		assert.deepEqual([removed.status, removed.removedBy, removed.pitch], ["removed", "recommender", "Short and kind."]);
	});

	test("one removed, even before it showed anywhere, comes back from its row with its pitch", async () => {
		const a = await creator("rec-again-a");
		const b = await creator("rec-again-b");
		const { body: added } = await recommend(a, b, "Worth every Sunday.");
		assert.equal((await callApi("DELETE", `/api/v1/recommendations/${added.id}?newsletter=${a.slug}`, { key: a.key })).status, 200);
		assert.deepEqual(
			(await list(a)).outgoing.map(({ status, pitch, impressions }) => [status, pitch, impressions]),
			[["removed", "Worth every Sunday.", 0]],
			"it stays in the list"
		);

		const { tree, transitions } = await rowsOf(a);
		assert.equal(buttonNamed(tree, "Stop recommending rec-again-b news").length, 0);
		const [again] = buttonSaying(tree, "Recommend again");
		assert.equal(again.props.disabled, false);
		await as(a, () => {
			again.props.onClick();
			return Promise.all(transitions);
		});
		const back = (await list(a)).outgoing;
		assert.deepEqual(back.map(({ id, status, pitch }) => [id, status, pitch]), [[added.id, "active", "Worth every Sunday."]], "the same record, without retyping");
		assert.equal(await m.Recommendation.countDocuments({ accountId: a.accountId }), 1);
	});

	test("one the other newsletter declined has no way back from its row", async () => {
		const a = await creator("rec-noagain-a");
		const b = await creator("rec-noagain-b");
		const { body: added } = await recommend(a, b);
		await as(b, () => m.dashboardActions.decideRecommendation({ newsletterId: b.newsletterId, id: added.id, decision: "decline", reason: "Not a fit." }));
		const { tree } = await rowsOf(a);
		assert.equal(buttonSaying(tree, "Recommend again").length, 0);
	});
});

describe("the dashboard", () => {
	test("runs the same actions: add, change, search, decline, bring back, remove and the two settings", async () => {
		const a = await creator("rec-dash-a");
		const b = await creator("rec-dash-b");
		const act = (user, name, input) => as(user, () => m.dashboardActions[name]({ newsletterId: user.newsletterId, ...input }));

		assert.equal((await act(b, "saveRecommendationSettings", { allowIncoming: true, listed: true })).ok, true);
		const found = await act(a, "searchNewsletters", { query: "rec-dash" });
		assert.deepEqual(found.output.newsletters.map(({ slug }) => slug), ["rec-dash-b"]);
		assert.match((await act(a, "addRecommendation", { slug: "rec-dash-a", pitch: "Me." })).error, /your own account/);
		const added = await act(a, "addRecommendation", { slug: "rec-dash-b", pitch: "From the dashboard." });
		assert.equal(added.ok, true, JSON.stringify(added));
		const id = added.output.id;
		assert.equal((await act(a, "savePitch", { id, pitch: "Changed." })).output.pitch, "Changed.");

		assert.equal((await act(b, "decideRecommendation", { id, decision: "decline", reason: "Not a fit." })).output.status, "removed");
		assert.match((await act(a, "addRecommendation", { slug: "rec-dash-b", pitch: "Again." })).error, /declined your recommendation: Not a fit\./);
		assert.equal((await act(b, "decideRecommendation", { id, decision: "restore" })).output.status, "active");

		assert.equal((await act(b, "saveRecommendationSettings", { allowIncoming: false, listed: true })).error, "A newsletter that turned off incoming recommendations can't be listed in the directory");
		assert.equal((await act(b, "saveRecommendationSettings", { allowIncoming: false, listed: false })).ok, true);
		assert.equal((await act(a, "removeRecommendation", { id })).output.removed, true);
		assert.deepEqual(
			(await list(a)).outgoing.map(({ status, removedBy, pitch }) => [status, removedBy, pitch]),
			[["removed", "recommender", "Changed."]],
			"it stays, with its pitch, to recommend again"
		);
	});

	test("shows the recommendations page, and the sign-up step's cards", async () => {
		const a = await creator("rec-page-a");
		const html = await as(a, async () => renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.dashboardPage.default())));
		assert.match(html, /Newsletters you recommend \(0 of 10\)/);
		assert.match(html, /Newsletters that recommend yours/);
		assert.match(html, /Take recommendations/);
		assert.match(html, /List in the directory/);
		assert.ok(html.includes(RECOMMENDATIONS_TAG));
	});
});

describe("a deleted account", () => {
	test("takes its recommendations of others out, and leaves a removed record with the reason on the others' pages", async () => {
		const a = await creator("rec-purge-a");
		const b = await creator("rec-purge-b");
		await recommend(a, b, "Soon gone.");
		const purgeAt = new Date(Date.now() - 1000);
		await m.Account.updateOne(
			{ _id: b.accountId },
			{ $set: { subscriptionStatus: "canceled", deletion: { requestedAt: new Date(Date.now() - 40 * 864e5), purgeAt } } }
		);
		const purge = await import("../lib/account-purge.js");
		assert.deepEqual(await purge.runPurge({ accountId: String(b.accountId), purgeAt: purgeAt.toISOString() }), { purged: true });

		const [gone] = (await list(a)).outgoing;
		assert.deepEqual([gone.status, gone.reason, gone.removedBy], ["removed", "This newsletter no longer exists.", "system"]);
		assert.equal(await m.Recommendation.countDocuments({ recommendedAccountId: b.accountId, status: "active" }).setOptions({ crossAccount: true }), 0);
		assert.equal((await tick({ token: "x" }, ["rec-purge-b"])).error?.length > 0, true);

		const c = await creator("rec-purge-c");
		await recommend(c, a);
		await recommend(a, c);
		const purgeA = new Date(Date.now() - 1000);
		await m.Account.updateOne({ _id: a.accountId }, { $set: { subscriptionStatus: "canceled", deletion: { requestedAt: new Date(Date.now() - 40 * 864e5), purgeAt: purgeA } } });
		assert.deepEqual(await purge.runPurge({ accountId: String(a.accountId), purgeAt: purgeA.toISOString() }), { purged: true });
		assert.equal(await m.Recommendation.countDocuments({ accountId: a.accountId }), 0, "its own are deleted with it");
		assert.equal((await list(c)).outgoing[0].status, "removed", "and c's recommendation of it is removed");
	});
});

describe("pairing rules in the library", () => {
	test("order the rows by position and reorder them", async () => {
		const a = await creator("rec-order-a");
		const b = await creator("rec-order-b");
		const c = await creator("rec-order-c");
		const first = (await recommend(a, b, "First.")).body;
		const second = (await recommend(a, c, "Second.")).body;
		assert.deepEqual((await list(a)).outgoing.map(({ pitch }) => pitch), ["First.", "Second."]);
		await callApi("PATCH", `/api/v1/recommendations/${second.id}`, { key: a.key, body: { newsletter: a.slug, position: 0 } });
		await callApi("PATCH", `/api/v1/recommendations/${first.id}`, { key: a.key, body: { newsletter: a.slug, position: 1 } });
		assert.deepEqual((await list(a)).outgoing.map(({ pitch }) => pitch), ["Second.", "First."]);
	});
});
