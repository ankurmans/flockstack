import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, assertError, creator, findContact, nextIp, visit, visitAndFlush } from "./helpers/growth.mjs";
import { as, form, startTestApp } from "./helpers/app.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// Magic Links: a signed address for other platforms to fill with each reader's email. The signature covers the newsletter
// and a key id, not the address, so these tests are about what stops it from being used on addresses that didn't ask.
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		page: await import("../app/subscribe/magic/page.js"),
		actions: await import("../app/subscribe/magic/actions.js"),
		magic: await import("../lib/magic-links.js"),
		settingsPage: await import("../app/(app)/forms/magic/page.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

const linkOf = async (user) => (await api(user.key, "GET", `/newsletters/${user.slug}/magic-link`)).body;

// The link as another platform sends it: its merge tag filled with the reader's address.
function fill(template, email, extra = "") {
	const url = new URL(template.replace("{{email}}", encodeURIComponent(email)));
	return { url, query: Object.fromEntries([...url.searchParams, ...new URLSearchParams(extra)]) };
}

function openPage(user, query, { userAgent = FIREFOX, referer } = {}) {
	return visit(nextIp(), () => m.page.default({ searchParams: Promise.resolve(query) }), {
		host: `${user.slug}.flockstackmail.com`,
		"user-agent": userAgent,
		...(referer && { referer }),
	});
}

function click(query, { ip = nextIp(), extra = {} } = {}) {
	const data = form({ ...Object.fromEntries(Object.entries(query).filter(([name]) => name !== "n")), ...extra });
	if (query.n) data.set("newsletter", query.n);
	return visitAndFlush(ip, () => m.actions.subscribeWithMagic(null, data));
}

// What the page's form posts: the newsletter's slug beside the link's own parameters.
const post = (user, query, extra) => click({ ...query, newsletter: user.slug }, extra);

describe("the link", () => {
	test("is on the newsletter's host with a key id and a signature, and is the same each time", async () => {
		const user = await creator("magic-template");
		const link = await linkOf(user);
		assert.match(link.template, /^https:\/\/magic-template\.flockstackmail\.com\/subscribe\/magic\?email=\{\{email\}\}&k=1&sig=[A-Za-z0-9_-]{22}$/);
		assert.deepEqual({ keyId: link.keyId, requiresConfirmation: link.requiresConfirmation, warning: link.warning, emailTag: link.emailTag }, { keyId: 1, requiresConfirmation: true, warning: null, emailTag: "{{email}}" });
		assert.equal((await linkOf(user)).template, link.template);
		const other = await creator("magic-template-b");
		assert.notEqual((await linkOf(other)).template.split("sig=")[1], link.template.split("sig=")[1], "each newsletter signs for itself");
	});

	test("checks as valid for its own newsletter, forged, for another newsletter, and retired", async () => {
		const first = await creator("magic-check-a");
		const second = await creator("magic-check-b");
		const [a, b] = await Promise.all([first, second].map((user) => m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()));
		const sig = m.magic.getMagicSignature(a);
		assert.equal(m.magic.checkMagicLink(a, { keyId: "1", signature: sig }), "valid");
		assert.equal(m.magic.checkMagicLink(b, { keyId: "1", signature: sig }), "invalid", "one newsletter's link is nothing at another");
		assert.equal(m.magic.checkMagicLink(a, { keyId: "1", signature: `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}` }), "invalid");
		assert.equal(m.magic.checkMagicLink(a, { keyId: "2", signature: sig }), "invalid", "the key id is signed");
		assert.equal(m.magic.checkMagicLink(a, { keyId: "x", signature: sig }), "invalid");
		assert.equal(m.magic.checkMagicLink(a, { keyId: "1", signature: undefined }), "invalid");
		const moved = { ...a, magicKeyId: 2 };
		assert.equal(m.magic.checkMagicLink(moved, { keyId: "1", signature: sig }), "retired");
		assert.equal(m.magic.checkMagicLink(moved, { keyId: "2", signature: m.magic.getMagicSignature(moved) }), "valid");
	});

	test("warns when confirmed opt-in is off, and retiring it gives a new one and kills the old", async () => {
		const user = await creator("magic-rotate", { confirm: false });
		const first = await linkOf(user);
		assert.match(first.warning, /confirmed opt-in is off/i);
		const rotated = await api(user.key, "POST", `/newsletters/${user.slug}/magic-link/rotate`);
		assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
		assert.equal(rotated.body.keyId, 2);
		assert.notEqual(rotated.body.template, first.template);
		assert.equal((await linkOf(user)).template, rotated.body.template);
		const old = fill(first.template, "late@gmail.com");
		assert.equal((await post(user, old.query)).error, m.magic.MAGIC_MESSAGES.retired);
		assert.equal(await findContact(user, "late@gmail.com"), null);
		assert.equal((await post(user, fill(rotated.body.template, "late@gmail.com").query)).ok, true);
		assertError(await api(user.key, "GET", "/newsletters/not-mine/magic-link"), 404, "not_found");
	});
});

describe("the page", () => {
	test("opens with the address filled in and subscribes by itself, but not for a link scanner", async () => {
		const user = await creator("magic-page");
		const { query } = fill((await linkOf(user)).template, "jane+news@example.org", "utm_source=Friends&utm_campaign=swap");
		const page = await openPage(user, query, { referer: "https://mail.partner.example/click" });
		const props = page.props.children.props;
		assert.deepEqual(
			{ email: props.email, slug: props.slug, keyId: props.keyId, isAutomatic: props.isAutomatic, from: props.from, utm: props.utm },
			{ email: "jane+news@example.org", slug: "magic-page", keyId: "1", isAutomatic: true, from: "mail.partner.example", utm: { utm_source: "friends", utm_campaign: "swap" } }
		);
		assert.equal((await openPage(user, query, { userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" })).props.children.props.isAutomatic, false);
		const markup = renderToStaticMarkup(page);
		assert.ok(markup.includes('name="k"') && markup.includes('name="sig"') && markup.includes('name="website"'));
		assert.match(markup, /<input type="hidden" name="email" value="jane\+news@example.org"\/>/);
	});

	test("reads a + that came through as a space, and asks for the address when the merge tag wasn't filled in", async () => {
		const user = await creator("magic-plus");
		const template = (await linkOf(user)).template;
		const spaced = fill(template, "jane news@example.org").query;
		assert.equal((await openPage(user, spaced)).props.children.props.email, "jane+news@example.org");
		const raw = await openPage(user, { ...fill(template, "x@example.org").query, email: "{{email}}" });
		assert.equal(raw.props.children.props.email, "");
		assert.match(renderToStaticMarkup(raw), /type="email"/);
	});

	test("says a forged, retired or unknown link doesn't work", async () => {
		const user = await creator("magic-bad");
		const { query } = fill((await linkOf(user)).template, "jane@example.org");
		const text = async (node) => renderToStaticMarkup(await node).replace(/<[^>]+>/g, " ");
		const doesntWork = /This link doesn(&#x27;|')t work/;
		assert.match(await text(openPage(user, { ...query, sig: "A".repeat(22) })), doesntWork);
		await api(user.key, "POST", `/newsletters/${user.slug}/magic-link/rotate`);
		assert.match(await text(openPage(user, query)), /retired by the newsletter/);
		assert.match(await text(openPage({ slug: "no-such-news" }, query)), doesntWork);
	});

	test("is served on the newsletter's host, and robots and referrers are kept off it", async () => {
		const user = await creator("magic-host");
		const url = `https://magic-host.flockstackmail.com/subscribe/magic?email=a@example.org`;
		const response = await m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
		assert.equal(response.headers.get("x-middleware-next"), "1");
		assert.equal(m.page.metadata.referrer, "no-referrer");
		assert.deepEqual(m.page.metadata.robots, { index: false, follow: false });
		assert.ok(user);
	});
});

describe("the click", () => {
	test("with confirmed opt-in, makes a pending contact with the confirmation email, the source and what the link carried", async () => {
		const user = await creator("magic-click");
		const { query } = fill((await linkOf(user)).template, "Jane@Gmail.com", "utm_source=Friends&utm_medium=email&utm_campaign=swap");
		const result = await post(user, { ...query, from: "mail.partner.example" });
		assert.equal(result.ok, true);
		assert.equal(result.pending, true);
		assert.equal(result.email, "jane@gmail.com");
		assert.ok(result.inbox, "a button to the inbox");
		const contact = await findContact(user, "jane@gmail.com");
		assert.equal(contact.status, "pending");
		assert.equal(contact.source, "magic-link");
		assert.deepEqual(contact.acquisition, { channel: "email", utm: { source: "friends", medium: "email", campaign: "swap" }, referrer: "mail.partner.example" });
		assert.ok(sesEmails.some((email) => JSON.stringify(email).includes("jane@gmail.com")), "the confirmation email went out");
	});

	test("without confirmed opt-in, joins at once", async () => {
		const user = await creator("magic-direct", { confirm: false });
		const result = await post(user, fill((await linkOf(user)).template, "sam@gmail.com").query);
		assert.deepEqual(result, { ok: true, email: "sam@gmail.com" });
		assert.equal((await findContact(user, "sam@gmail.com")).status, "active");
	});

	test("works on a newsletter whose website is off, which a form does too", async () => {
		const user = await creator("magic-nosite", { archive: false });
		assert.equal((await post(user, fill((await linkOf(user)).template, "pat@gmail.com").query)).ok, true);
	});

	test("refuses a forged link, a bad address and an honeypot, and subscribes nobody", async () => {
		const user = await creator("magic-refuse");
		const { query } = fill((await linkOf(user)).template, "kim@gmail.com");
		assert.equal((await post(user, { ...query, sig: "B".repeat(22) })).error, m.magic.MAGIC_MESSAGES.invalid);
		assert.equal((await post(user, { ...query, email: "not-an-email" })).error, m.magic.MAGIC_MESSAGES.email);
		assert.equal((await post(user, { ...query, email: "{{email}}" })).error, m.magic.MAGIC_MESSAGES.email);
		assert.deepEqual(await post(user, query, { extra: { website: "http://spam.example" } }), { ok: true }, "the bot is told it worked");
		assert.equal(await findContact(user, "kim@gmail.com"), null);
		assert.equal((await post({ slug: "no-such-news" }, query)).error, m.magic.MAGIC_MESSAGES.invalid);
	});

	test("limits an address to 3 tries a day however many networks they come from", async () => {
		const user = await creator("magic-email");
		const { query } = fill((await linkOf(user)).template, "target@gmail.com");
		const results = [];
		for (let index = 0; index < 5; index += 1) results.push(await post(user, query, { ip: nextIp() }));
		assert.deepEqual(results.map(({ ok }) => Boolean(ok)), [true, true, true, false, false]);
		assert.equal(results[3].error, m.magic.MAGIC_MESSAGES.limit);
		assert.doesNotMatch(results[3].error, /target@gmail/);
		const confirmations = sesEmails.filter((email) => JSON.stringify(email).includes("target@gmail.com")).length;
		assert.ok(confirmations <= 3, `${confirmations} confirmation emails`);
		assert.equal((await post(user, fill((await linkOf(user)).template, "other@gmail.com").query, { ip: nextIp() })).ok, true, "another address is not held back");
	});

	test("limits a network: 10 tries in 10 minutes, and the signup limit of 5 before that", async () => {
		const user = await creator("magic-ip");
		const template = (await linkOf(user)).template;
		const ip = nextIp();
		const results = [];
		for (let index = 0; index < 7; index += 1) results.push(await post(user, fill(template, `net${index}@gmail.com`).query, { ip }));
		assert.deepEqual(results.map(({ ok }) => Boolean(ok)), [true, true, true, true, true, false, false]);
		assert.equal(results[5].error, "Too many signups from your network. Try again in a few minutes.");
		assert.equal(await findContact(user, "net5@gmail.com"), null);
	});

	test("never subscribes an address that left or bounced, like any signup", async () => {
		const user = await creator("magic-left", { confirm: false });
		const Contact = (await import("../models/Contact.js")).default;
		await Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "gone@gmail.com", status: "unsubscribed", source: "website" });
		await post(user, fill((await linkOf(user)).template, "gone@gmail.com").query);
		assert.equal((await findContact(user, "gone@gmail.com")).status, "unsubscribed", "only an explicit resubscribe brings them back; a link filled in by someone else isn't one");
	});
});

describe("the dashboard", () => {
	test("shows the link to copy, the merge tags and the retire button", async () => {
		const user = await creator("magic-dashboard");
		const page = await as(user, () => m.settingsPage.default());
		const markup = renderToStaticMarkup(createElement(m.TooltipProvider, null, page));
		assert.match(markup, /subscribe\/magic\?email=\{\{email\}\}&amp;k=1&amp;sig=/);
		assert.match(markup, /\*\|EMAIL\|\*/);
		assert.match(markup, /Retire this link/);
	});
});
