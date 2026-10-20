import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildAcquisition, classifyChannel, cleanValue, parseAttributionInput, readUtm, serializeAttributionInput, toReferrerHost } from "../lib/attribution.js";
import { addUtmToLinks, getLinkUtm } from "../lib/link-utm.js";
import { decodeClickLinks } from "./helpers/links.mjs";
import { callApi, creator, findContact, nextIp, visitAndFlush } from "./helpers/growth.mjs";
import { form, startTestApp } from "./helpers/app.mjs";

// Where a signup came from: UTM parameters, the referring host and a channel, on every way in; and the optional UTM
// tag on an issue's outgoing links.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		archive: await import("../app/archive/actions.js"),
		sendingRules: await import("../lib/sending-rules.js"),
		Contact: (await import("../models/Contact.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("reading attribution", () => {
	test("UTM values are cleaned, lowercased and capped; nothing else is kept", () => {
		const params = new URLSearchParams("utm_source=Newsletter-Swap &utm_medium=EMAIL&utm_campaign=" + "x".repeat(200) + "&utm_id=7&other=1");
		const utm = readUtm((name) => params.get(name));
		assert.deepEqual(Object.keys(utm).sort(), ["campaign", "medium", "source"]);
		assert.equal(utm.source, "newsletter-swap");
		assert.equal(utm.campaign.length, 80);
		assert.equal(readUtm(() => null), null);
		assert.equal(cleanValue("a\u0000b\n c"), "a b c");
	});

	test("the referrer is a host: www dropped, own hosts and non-web addresses ignored", () => {
		assert.equal(toReferrerHost("https://www.Example.com/some/page?x=1"), "example.com");
		assert.equal(toReferrerHost("news.example.org"), "news.example.org");
		assert.equal(toReferrerHost("https://example.com/", ["example.com"]), null);
		assert.equal(toReferrerHost("android-app://com.google.android.gm"), null);
		assert.equal(toReferrerHost("javascript:alert(1)"), null);
		assert.equal(toReferrerHost(""), null);
	});

	test("channels: structural sources first, then UTM, then the referrer, else direct", () => {
		assert.equal(classifyChannel({ source: "import" }), "import");
		assert.equal(classifyChannel({ source: "dashboard" }), "manual");
		assert.equal(classifyChannel({ source: "recommendation:other" }), "recommendation");
		assert.equal(classifyChannel({ source: "referral", utm: { medium: "cpc" } }), "referral");
		assert.equal(classifyChannel({ source: "website", utm: { medium: "cpc" } }), "paid");
		assert.equal(classifyChannel({ source: "website", utm: { medium: "email", source: "other-letter" } }), "email");
		assert.equal(classifyChannel({ source: "website", utm: { source: "linkedin" } }), "social");
		assert.equal(classifyChannel({ source: "website", referrer: "www.google.fr" }), "search");
		assert.equal(classifyChannel({ source: "website", referrer: "old.reddit.com" }), "social");
		assert.equal(classifyChannel({ source: "website", referrer: "someblog.example" }), "website");
		assert.equal(classifyChannel({ source: "magic-link" }), "email");
		assert.equal(classifyChannel({ source: "popup" }), "direct");
		assert.equal(classifyChannel({ source: "zapier" }), "api");
		assert.equal(classifyChannel({}), "direct");
	});

	test("the hidden field round-trips and ignores junk", () => {
		const raw = serializeAttributionInput({ utm: { source: "a", campaign: "b" }, referrer: "example.com" });
		assert.deepEqual(parseAttributionInput(raw), { utm: { source: "a", campaign: "b" }, referrer: "example.com" });
		assert.deepEqual(parseAttributionInput("not json"), {});
		assert.deepEqual(parseAttributionInput("x".repeat(2000)), {});
		assert.equal(serializeAttributionInput({}), "");
		assert.deepEqual(buildAcquisition({ source: "website" }), { channel: "direct" });
	});
});

describe("signups record where they came from", () => {
	test("the website form: UTM, the referrer host and the channel go on the new contact, once", async () => {
		const user = await creator("acq-site");
		const acq = serializeAttributionInput({ utm: { source: "friends-letter", medium: "email", campaign: "swap-12" }, referrer: "https://www.friends.example/post" });
		const result = await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email: "reader1@example.com", acq })));
		assert.equal(result.ok, true);
		const contact = await findContact(user, "reader1@example.com");
		assert.equal(contact.source, "website");
		assert.deepEqual(contact.acquisition, { channel: "email", utm: { source: "friends-letter", medium: "email", campaign: "swap-12" }, referrer: "friends.example" });

		await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email: "reader1@example.com", acq: serializeAttributionInput({ utm: { source: "later" } }) })));
		assert.equal((await findContact(user, "reader1@example.com")).acquisition.utm.source, "friends-letter", "the first signup keeps its attribution");
	});

	test("a signup with nothing to go on is direct, and the popup says so as its source", async () => {
		const user = await creator("acq-popup");
		await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email: "reader2@example.com", via: "popup" })));
		const contact = await findContact(user, "reader2@example.com");
		assert.equal(contact.source, "popup");
		assert.deepEqual(contact.acquisition, { channel: "direct" });
		await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email: "reader3@example.com", via: "<script>" })));
		assert.equal((await findContact(user, "reader3@example.com")).source, "website", "only known sources are taken from the browser");
	});

	test("a referral code makes it a referral; junk in the field is dropped", async () => {
		const user = await creator("acq-referral");
		await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email: "reader4@example.com", ref: "A".repeat(27), acq: "{" })));
		assert.equal((await findContact(user, "reader4@example.com")).acquisition.channel, "referral");
	});

	test("the API takes utm and a referrer for a form of your own", async () => {
		const user = await creator("acq-api");
		const body = { newsletter: user.slug, email: "reader5@example.com", source: "landing-page", utm: { source: "Google", medium: "cpc", campaign: "Spring" }, referrer: "https://www.google.com/" };
		const added = await callApi("POST", "/api/v1/contacts", { key: user.key, body });
		assert.equal(added.status, 201, JSON.stringify(added.body));
		const contact = await findContact(user, "reader5@example.com");
		assert.deepEqual(contact.acquisition, { channel: "paid", utm: { source: "google", medium: "cpc", campaign: "spring" }, referrer: "google.com" });
		const shown = await callApi("GET", `/api/v1/contacts/reader5@example.com?newsletter=${user.slug}`, { key: user.key });
		assert.deepEqual(shown.body.acquisition, { channel: "paid", utm: { source: "google", medium: "cpc", campaign: "spring" }, referrer: "google.com" });

		await callApi("POST", "/api/v1/contacts", { key: user.key, body: { newsletter: user.slug, email: "reader6@example.com" } });
		assert.equal((await findContact(user, "reader6@example.com")).acquisition.channel, "api");
		const old = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "old@example.com", status: "active", source: "website" });
		const legacy = await callApi("GET", `/api/v1/contacts/${old._id}`, { key: user.key });
		assert.equal(legacy.body.acquisition, null, "a contact from before has none");
	});

	test("a recommendation records the channel and the recommending newsletter's host", async () => {
		const from = await creator("acq-rec-from", { confirm: false });
		const to = await creator("acq-rec-to");
		const added = await callApi("POST", "/api/v1/recommendations", { key: from.key, body: { newsletter: from.slug, slug: to.slug, pitch: "A short, friendly read." } });
		assert.equal(added.status, 201, JSON.stringify(added.body));
		const joined = await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: from.slug, email: "reader7@example.com" })));
		assert.ok(joined.step, "the step is offered");
		const fields = new FormData();
		fields.append("newsletter", to.slug);
		await visitAndFlush(nextIp(), () => m.archive.subscribeToRecommendations(joined.step.token, null, fields));
		const contact = await findContact(to, "reader7@example.com");
		assert.equal(contact.source, "recommendation:acq-rec-from");
		assert.deepEqual(contact.acquisition, { channel: "recommendation", referrer: `${from.slug}.flockstackmail.com` });
	});
});

describe("UTM tags on outgoing links", () => {
	const html = [
		'<p><a href="https://shop.example.com/item?id=3&amp;ref=x">tagged</a></p>',
		'<p><a href="https://example.org/page?utm_source=mine">the writer\'s own</a></p>',
		'<p><a href="https://acq-utm.flockstackmail.com/p/hello">own page</a></p>',
		'<p><a href="mailto:me@example.com">mail</a></p>',
	].join("");

	test("external links get source, medium and campaign; own pages, mailto and the writer's own tags stay", () => {
		const utm = getLinkUtm({ newsletterName: "Field Notes", campaignSlug: "issue-12" });
		assert.deepEqual(utm, { utm_source: "field notes", utm_medium: "email", utm_campaign: "issue-12" });
		const tagged = addUtmToLinks(html, utm, ["acq-utm.flockstackmail.com"]);
		assert.match(tagged, /href="https:\/\/shop\.example\.com\/item\?id=3&amp;ref=x&amp;utm_source=field\+notes&amp;utm_medium=email&amp;utm_campaign=issue-12"/);
		assert.ok(tagged.includes('href="https://example.org/page?utm_source=mine"'));
		assert.ok(tagged.includes('href="https://acq-utm.flockstackmail.com/p/hello"'));
		assert.ok(tagged.includes('href="mailto:me@example.com"'));
	});

	test("an issue's email carries them through the tracked links only when the newsletter asks", async () => {
		const user = await creator("acq-utm");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const campaign = { _id: "6650f1c2e9b1d4a012345678", format: "html", subject: "Hello there", html: `<html><body>${html}</body></html>`, archiveSlug: "hello-there" };
		const contact = { _id: "6650f1c2e9b1d4a0123456ff", email: "reader@example.com", status: "active" };
		const build = (settings) =>
			m.sendingRules.buildRecipientEmail({ campaign, newsletter: { ...newsletter, ...settings }, contact, messageId: "6650f1c2e9b1d4a0123456aa" });

		const off = decodeClickLinks(build({ utmLinks: false }).html);
		assert.ok(off.includes("https://shop.example.com/item?id=3&ref=x"));
		const on = decodeClickLinks(build({ utmLinks: true }).html);
		assert.ok(on.includes("https://shop.example.com/item?id=3&ref=x&utm_source=acq-utm+news&utm_medium=email&utm_campaign=hello-there"), on.join("\n"));
		assert.ok(on.includes("https://example.org/page?utm_source=mine"));
		assert.ok(!on.some((url) => url.includes("flockstackmail.com") && url.includes("utm_")), "own links stay clean");
	});

	test("the setting is saved through update_newsletter and the settings form", async () => {
		const user = await creator("acq-utm-setting");
		const changed = await callApi("PATCH", `/api/v1/newsletters/${user.slug}`, { key: user.key, body: { utmLinks: true } });
		assert.equal(changed.status, 200, JSON.stringify(changed.body));
		assert.equal(changed.body.utmLinks, true);
		assert.equal((await callApi("PATCH", `/api/v1/newsletters/${user.slug}`, { key: user.key, body: { name: "Renamed" } })).body.utmLinks, true, "other changes keep it");
	});
});
