import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFeed } from "../lib/archive-feed.js";
import { POPUP_DEFAULTS, getGateTeaserOptions, getPopupProblem, getPopupSettings, getTriggerProps, isGatedIssue, isPopupOn } from "../lib/popup-rules.js";
import { EXIT_ARM_MS, armPopup } from "../lib/popup-trigger.js";
import { makeTeaser } from "../lib/paywall.js";
import { readerMarkerName } from "../lib/reader-cookies.js";
import { gateReturnKey, readGateReturn, subscribeSnoozedKey, subscribedKey } from "../lib/storage.js";
import { api, assertError, creator, findContact, nextIp, visit, visitAndFlush } from "./helpers/growth.mjs";
import { anonymous, as, catchRedirect, form, startTestApp } from "./helpers/app.mjs";
import { revalidatedPaths } from "./stubs/next-cache.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// The website's signup pop-up (when it opens, where, how long closing it snoozes it), and the gate that shows older issues
// to readers who haven't subscribed only as their beginning.
const WORDS = (label, count) => Array.from({ length: count }, (_, index) => `${label}${index}`).join(" ");
const MARKDOWN = [WORDS("alpha", 40), WORDS("bravo", 40), WORDS("charlie", 40), WORDS("delta", 40), WORDS("echo", 40)].join("\n\n");
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		homePage: (await import("../app/archive/[slug]/page.js")).default,
		issuePage: (await import("../app/archive/[slug]/p/[post]/page.js")).default,
		authorPage: (await import("../app/archive/[slug]/authors/[author]/page.js")).default,
		gateRoute: await import("../app/api/gate/route.js"),
		gateActions: await import("../app/archive/gate-actions.js"),
		archive: await import("../app/archive/actions.js"),
		confirm: await import("../app/confirm/actions.js"),
		signinPage: (await import("../app/reader/signin/page.js")).default,
		signinActions: await import("../app/reader/signin/actions.js"),
		feedRoute: await import("../app/archive/[slug]/feed/route.js"),
		popupPage: (await import("../app/(app)/forms/popup/page.js")).default,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		readerSession: await import("../lib/reader-session.js"),
		confirmation: await import("../lib/confirmation.js"),
		readerLinks: await import("../lib/reader-links.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		Campaign: (await import("../models/Campaign.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

// Issue addresses are unique across accounts, so each carries its newsletter's slug.
const slugOf = (user, name) => `${name}-${user.slug}`;
async function addIssue(user, name, { markdown = MARKDOWN, sentAt = new Date(), ...extra } = {}) {
	return m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: name, status: "sent", sentAt, archiveSlug: slugOf(user, name), format: "markdown", markdown, ...extra });
}

// The layout's provider, which the pop-up needs to open.
const html = (node) => renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { slug: "x", name: "X", signupFields: [] }, readers: 0 }, node));
const text = (node) => html(node).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const find = (node, predicate) => {
	if (!node || typeof node !== "object") return null;
	if (predicate(node)) return node;
	for (const child of [].concat(node.props?.children ?? [])) {
		const found = find(child, predicate);
		if (found) return found;
	}
	return null;
};
const named = (name) => (node) => typeof node.type === "function" && node.type.name === name;
const openIssue = (user, name) => m.issuePage({ params: Promise.resolve({ slug: user.slug, post: slugOf(user, name) }) });
const openHome = (user) => m.homePage({ params: Promise.resolve({ slug: user.slug }) });

describe("the settings", () => {
	test("start as the pop-up always was, and the rules check what is saved", () => {
		assert.deepEqual(getPopupSettings({}), { enabled: true, trigger: "scroll", seconds: 15, scrollPercent: 45, frequencyDays: 14, pages: "issues", gate: { enabled: false, previewPercent: 30, freeLatest: 1 } });
		assert.equal(POPUP_DEFAULTS.scrollPercent, 45);
		assert.deepEqual(getPopupSettings({ popup: { trigger: "time", gate: { enabled: true } } }).gate, { enabled: true, previewPercent: 30, freeLatest: 1 });
		const ok = getPopupSettings({});
		assert.equal(getPopupProblem(ok), null);
		for (const [change, pattern] of [
			[{ trigger: "hover" }, /trigger/],
			[{ pages: "everywhere" }, /pages/],
			[{ seconds: 1 }, /seconds/],
			[{ scrollPercent: 95 }, /scrollPercent/],
			[{ frequencyDays: 0 }, /frequencyDays/],
			[{ gate: { ...ok.gate, previewPercent: 5 } }, /previewPercent/],
			[{ gate: { ...ok.gate, freeLatest: 11 } }, /freeLatest/],
		]) assert.match(getPopupProblem({ ...ok, ...change }), pattern);
		assert.equal(isPopupOn(ok, "issue"), true);
		assert.equal(isPopupOn(ok, "home"), false);
		assert.equal(isPopupOn({ ...ok, pages: "home" }, "home"), true);
		assert.equal(isPopupOn({ ...ok, pages: "all" }, "other"), true);
		assert.equal(isPopupOn({ ...ok, enabled: false, pages: "all" }, "issue"), false);
		assert.deepEqual(getTriggerProps(ok), { trigger: "scroll", seconds: 15, scrollPercent: 45, frequencyDays: 14 });
	});

	test("gate the older issues, never a paid one, and keep the newest open", () => {
		const popup = getPopupSettings({ popup: { gate: { enabled: true, freeLatest: 2 } } });
		assert.equal(isGatedIssue(popup, { _id: "a" }, ["a", "b"]), false);
		assert.equal(isGatedIssue(popup, { _id: "c" }, ["a", "b"]), true);
		assert.equal(isGatedIssue(popup, { _id: "c", audience: "paid" }, ["a", "b"]), false);
		assert.equal(isGatedIssue(getPopupSettings({}), { _id: "c" }, []), false);
	});

	test("are read and changed through the API, a change keeps what it leaves out, and the website is refreshed", async () => {
		const user = await creator("popup-settings");
		const first = await api(user.key, "GET", `/popup?newsletter=${user.slug}`);
		assert.deepEqual({ ...first.body, newsletterId: undefined }, { newsletterId: undefined, ...getPopupSettings({}) });
		revalidatedPaths.length = 0;
		const changed = await api(user.key, "PATCH", "/popup", { newsletter: user.slug, trigger: "time", seconds: 20, gate: { enabled: true } });
		assert.equal(changed.status, 200, JSON.stringify(changed.body));
		assert.deepEqual({ trigger: changed.body.trigger, seconds: changed.body.seconds, scroll: changed.body.scrollPercent, gate: changed.body.gate }, { trigger: "time", seconds: 20, scroll: 45, gate: { enabled: true, previewPercent: 30, freeLatest: 1 } });
		assert.ok(revalidatedPaths.length > 0, "the cached pages are refreshed");
		const later = await api(user.key, "PATCH", "/popup", { newsletter: user.slug, gate: { previewPercent: 50 } });
		assert.deepEqual(later.body.gate, { enabled: true, previewPercent: 50, freeLatest: 1 });
		assert.match(assertError(await api(user.key, "PATCH", "/popup", { newsletter: user.slug, seconds: 1 }), 400, "validation_failed"), /seconds/);
		assert.match(assertError(await api(user.key, "PATCH", "/popup", { newsletter: user.slug, trigger: "hover" }), 400, "validation_failed"), /Invalid|trigger/i);
		const settings = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.equal(settings.name, `${user.slug} news`, "the newsletter's other settings are untouched");
		const page = text(await as(user, () => m.popupPage()));
		assert.match(page, /Gate issues/);
	});
});

describe("when the pop-up is armed", () => {
	let storage;
	let cookie;
	const fakeWindow = () => {
		const listeners = [];
		return {
			matchMedia: (query) => ({ matches: query.includes("hover: hover") ? fakeWindow.isDesktop : false }),
			addEventListener: (type, listener) => listeners.push({ type, listener }),
			removeEventListener: (type, listener) => listeners.splice(0, listeners.length, ...listeners.filter((item) => !(item.type === type && item.listener === listener))),
			fire: (type) => listeners.filter((item) => item.type === type).forEach((item) => item.listener()),
			listeners,
		};
	};
	const fakeDocument = (scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }) => {
		const listeners = [];
		return {
			get cookie() {
				return cookie;
			},
			documentElement: scroll,
			addEventListener: (type, listener) => listeners.push({ type, listener }),
			removeEventListener: (type, listener) => listeners.splice(0, listeners.length, ...listeners.filter((item) => !(item.type === type && item.listener === listener))),
			leave: (event) => listeners.filter((item) => item.type === "mouseout").forEach((item) => item.listener(event)),
			listeners,
		};
	};
	const settings = { slug: "news", scrollPercent: 45, seconds: 15, frequencyDays: 14 };

	beforeEach(() => {
		storage = new Map();
		cookie = "";
		fakeWindow.isDesktop = true;
		globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
		mock.timers.enable({ apis: ["setTimeout"] });
	});
	afterEach(() => {
		mock.timers.reset();
		delete globalThis.localStorage;
	});

	test("on time: after the seconds, once, and not before", () => {
		const opened = [];
		armPopup({ ...settings, trigger: "time", open: (source) => opened.push(source) }, { window: fakeWindow(), document: fakeDocument() });
		mock.timers.tick(14_999);
		assert.deepEqual(opened, []);
		mock.timers.tick(1);
		assert.deepEqual(opened, ["time"]);
	});

	test("on scroll: once the reader is the chosen share down, then never again", () => {
		const opened = [];
		const win = fakeWindow();
		const scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
		armPopup({ ...settings, trigger: "scroll", open: (source) => opened.push(source) }, { window: win, document: fakeDocument(scroll) });
		win.fire("scroll");
		assert.deepEqual(opened, [], "40% of the page seen, 45 to go");
		scroll.scrollTop = 100;
		win.fire("scroll");
		assert.deepEqual(opened, ["scroll"], "50% seen");
		win.fire("scroll");
		assert.deepEqual(opened, ["scroll"]);
		assert.equal(win.listeners.length, 0, "the listener removed itself");
	});

	test("on exit: desktop only, armed after a moment, and only for a mouse leaving through the top", () => {
		const opened = [];
		const doc = fakeDocument();
		armPopup({ ...settings, trigger: "exit", open: (source) => opened.push(source) }, { window: fakeWindow(), document: doc });
		doc.leave({ relatedTarget: null, clientY: -1 });
		assert.deepEqual(opened, [], "not armed yet");
		mock.timers.tick(EXIT_ARM_MS);
		doc.leave({ relatedTarget: null, clientY: 300 });
		doc.leave({ relatedTarget: {}, clientY: -1 });
		assert.deepEqual(opened, [], "leaving through the side, or moving to another element");
		doc.leave({ relatedTarget: null, clientY: 0 });
		assert.deepEqual(opened, ["exit"]);

		fakeWindow.isDesktop = false;
		const phone = fakeDocument();
		assert.equal(armPopup({ ...settings, trigger: "exit", open: () => opened.push("phone") }, { window: fakeWindow(), document: phone }), undefined);
		mock.timers.tick(EXIT_ARM_MS);
		assert.equal(phone.listeners.length, 0, "a touch screen has no exit");
	});

	test("never for someone who signed up here, who is signed in, or who closed it within the days chosen", () => {
		const attempt = (extra = {}) => {
			const opened = [];
			armPopup({ ...settings, trigger: "time", seconds: 1, open: (source) => opened.push(source), ...extra }, { window: fakeWindow(), document: fakeDocument(), now: () => 1_000_000_000_000 });
			mock.timers.tick(1000);
			return opened;
		};
		assert.deepEqual(attempt(), ["time"]);
		storage.set(subscribedKey("news"), "1");
		assert.deepEqual(attempt(), [], "signed up in this browser");
		storage.clear();
		cookie = `other=1; ${readerMarkerName("news")}=1`;
		assert.deepEqual(attempt(), [], "signed in with an emailed link");
		cookie = `${readerMarkerName("another")}=1`;
		assert.deepEqual(attempt(), ["time"], "another newsletter's session is not this one's");
		storage.set(subscribeSnoozedKey("news"), String(1_000_000_000_000 - 13 * 86_400_000));
		assert.deepEqual(attempt(), [], "closed 13 days ago, 14 to wait");
		storage.set(subscribeSnoozedKey("news"), String(1_000_000_000_000 - 15 * 86_400_000));
		assert.deepEqual(attempt(), ["time"], "closed 15 days ago");
		assert.deepEqual(attempt({ frequencyDays: 30 }), [], "a longer wait");
	});

	test("a reader who signs up while it waits is left alone", () => {
		const opened = [];
		armPopup({ ...settings, trigger: "time", seconds: 5, open: (source) => opened.push(source) }, { window: fakeWindow(), document: fakeDocument() });
		storage.set(subscribedKey("news"), "1");
		mock.timers.tick(5000);
		assert.deepEqual(opened, []);
	});

	test("remembers the gated issue a reader signed up on, as a path on the site only", () => {
		storage.set(gateReturnKey("news"), "/p/an-issue");
		assert.equal(readGateReturn("news"), "/p/an-issue");
		for (const bad of ["https://evil.example/p/x", "//evil.example", "/admin", "/p/x?next=1", "javascript:alert(1)"]) {
			storage.set(gateReturnKey("news"), bad);
			assert.equal(readGateReturn("news"), "", bad);
		}
		storage.set(gateReturnKey("news"), "/archive/news/p/an-issue");
		assert.equal(readGateReturn("news"), "/archive/news/p/an-issue");
	});
});

describe("the website's pages", () => {
	test("carry the pop-up as it always was, and as it is set", async () => {
		const user = await creator("popup-pages");
		await addIssue(user, "first-issue");
		const triggerOf = (node) => find(node, named("TriggerSubscribe"))?.props;
		const issue = triggerOf(await openIssue(user, "first-issue"));
		assert.deepEqual({ trigger: issue.trigger, scrollPercent: issue.scrollPercent, frequencyDays: issue.frequencyDays, slug: issue.newsletterSlug }, { trigger: "scroll", scrollPercent: 45, frequencyDays: 14, slug: "popup-pages" });
		assert.equal(triggerOf(await openHome(user)), undefined, "not on the front page unless asked");

		await api(user.key, "PATCH", "/popup", { newsletter: user.slug, trigger: "time", seconds: 30, frequencyDays: 3, pages: "all" });
		const home = triggerOf(await openHome(user));
		assert.deepEqual({ trigger: home.trigger, seconds: home.seconds, frequencyDays: home.frequencyDays }, { trigger: "time", seconds: 30, frequencyDays: 3 });
		assert.ok(triggerOf(await openIssue(user, "first-issue")));
		const author = await m.authorPage({ params: Promise.resolve({ slug: user.slug, author: "popup-pages-news" }) }).catch(() => null);
		if (author) assert.ok(triggerOf(author), "on the author's page too");

		await api(user.key, "PATCH", "/popup", { newsletter: user.slug, enabled: false });
		assert.equal(triggerOf(await openIssue(user, "first-issue")), undefined);
		assert.equal(triggerOf(await openHome(user)), undefined);
	});

	test("the signup form in the pop-up says so, and a popup signup is recorded as one", async () => {
		const user = await creator("popup-source");
		await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email: "pop@gmail.com", via: "popup" })));
		assert.equal((await findContact(user, "pop@gmail.com")).source, "popup");
	});
});

describe("a gated issue", () => {
	async function gated(name, { freeLatest = 1, previewPercent = 30, issues = ["newest", "older"], confirm = true } = {}) {
		const user = await creator(name, { confirm });
		for (const [index, issue] of issues.entries()) await addIssue(user, issue, { sentAt: new Date(Date.now() - index * 86_400_000) });
		await api(user.key, "PATCH", "/popup", { newsletter: user.slug, gate: { enabled: true, freeLatest, previewPercent } });
		return user;
	}

	test("shows its beginning and the form, and none of the rest, while the newest stays open", async () => {
		const user = await gated("gate-page");
		const older = await openIssue(user, "older");
		const props = find(older, named("GateIssue")).props;
		assert.equal(props.post, slugOf(user, "older"));
		assert.match(props.preview, /alpha0/);
		assert.doesNotMatch(props.preview, /echo/, "the end of the text isn't in the page");
		const markup = html(older);
		assert.doesNotMatch(markup, /echo39|delta39|charlie39/, "nothing of the later paragraphs is printed");
		assert.match(markup, /Subscribe to read the rest/);
		assert.match(markup, /name="via" value="gate"/);
		assert.equal(find(older, named("TriggerSubscribe")), null, "the pop-up doesn't ask twice");

		const newest = await openIssue(user, "newest");
		assert.equal(find(newest, named("GateIssue")), null);
		assert.match(html(newest), /echo39/, "the newest issue is whole");
		assert.ok(find(newest, named("TriggerSubscribe")));
	});

	test("takes the share the owner chose, in plain text, never more", async () => {
		const user = await gated("gate-share", { previewPercent: 50 });
		const issue = await m.Campaign.findOne({ accountId: user.accountId, archiveSlug: slugOf(user, "older") }).lean();
		const full = MARKDOWN.replace(/\n\n/g, " ").length;
		for (const percent of [10, 30, 50, 80]) {
			const preview = makeTeaser(issue, getGateTeaserOptions({ gate: { previewPercent: percent } })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
			assert.ok(preview.length <= full * (percent / 100) + 1, `${percent}%: ${preview.length} of ${full}`);
			assert.ok(preview.length > 20);
		}
		const markup = makeTeaser({ ...issue, markdown: "<script>alert(1)</script>\n\nSecond paragraph of the issue with enough words to reach the preview budget easily." }, getGateTeaserOptions({ gate: { previewPercent: 80 } }));
		assert.doesNotMatch(markup, /<script>/, "text is escaped");
	});

	test("leaves paid issues to their own teaser, and a keeps-open count of 0 gates them all", async () => {
		const user = await gated("gate-paid", { freeLatest: 0 });
		await addIssue(user, "paid-one", { audience: "paid" });
		assert.equal(find(await openIssue(user, "paid-one"), named("GateIssue")), null);
		assert.ok(find(await openIssue(user, "newest"), named("GateIssue")), "even the newest");
	});

	test("an HTML issue is gated too, and its design isn't sent", async () => {
		const user = await gated("gate-html", { issues: ["newest", "designed"] });
		await m.Campaign.updateOne({ accountId: user.accountId, archiveSlug: slugOf(user, "designed") }, { $set: { format: "html", html: `<html><body><p>${WORDS("alpha", 40)}</p><p>${WORDS("zulu", 40)}</p></body></html>` } });
		const page = html(await openIssue(user, "designed"));
		assert.doesNotMatch(page, /zulu39|<iframe/);
		assert.match(page, /alpha0/);
	});

	test("the feed carries the same beginning and a link to subscribe, and the newest in full", async () => {
		const user = await gated("gate-feed");
		const response = await m.feedRoute.GET(new Request(`https://${user.slug}.flockstackmail.com/feed.xml`), { params: Promise.resolve({ slug: user.slug }) });
		const xml = await response.text();
		const items = xml.split("<item>").slice(1);
		const newest = items.find((item) => item.includes("<title>newest</title>"));
		const older = items.find((item) => item.includes("<title>older</title>"));
		assert.match(newest, /echo39/);
		assert.doesNotMatch(older, /echo39|delta39/);
		assert.match(older, /alpha0/);
		assert.match(older, /Subscribe to read the rest of this issue/);
		assert.equal(buildFeed({ newsletter: { name: "N", slug: "n" }, issues: [] }).xml.includes("<item>"), false);
	});
});

// The gate route as a visitor with these cookies reaches it.
function askGate(user, name, jar = new Map(), ip = nextIp()) {
	return runWithRequest({ jar, headers: { "x-forwarded-for": ip } }, () => m.gateRoute.GET(new m.NextRequest(`https://${user.slug}.flockstackmail.com/api/gate?n=${user.slug}&p=${name.includes("/") ? name : slugOf(user, name)}`, { headers: { "x-forwarded-for": ip } })));
}

async function setupGate(name, options) {
	const user = await creator(name, options);
	await addIssue(user, "newest");
	await addIssue(user, "older", { sentAt: new Date(Date.now() - 86_400_000) });
	await api(user.key, "PATCH", "/popup", { newsletter: user.slug, gate: { enabled: true } });
	return user;
}

// A subscriber the website knows, signed in the way an emailed link or a confirmation signs them in.
async function signedIn(user, email, { status = "active" } = {}) {
	const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status, source: "website" });
	const jar = new Map();
	const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	await runWithRequest({ jar }, () => m.readerSession.startReaderSession(newsletter, contact._id));
	return { contact, jar };
}

describe("the rest of a gated issue", () => {
	test("is given to a subscriber who is signed in, and to nobody else", async () => {
		const user = await setupGate("gate-rest");
		const { jar } = await signedIn(user, "reader@example.org");
		const ok = await askGate(user, "older", jar);
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("cache-control"), "private, no-store");
		const body = await ok.json();
		assert.equal(body.ok, true);
		assert.equal(body.kind, "article");
		assert.match(body.html, /echo39/);
		assert.match(body.html, /alpha0/);

		const nobody = await askGate(user, "older");
		assert.equal(nobody.status, 401);
		assert.doesNotMatch(JSON.stringify(await nobody.json()), /alpha/);
		assert.equal((await askGate(user, "../etc/passwd/")).status, 404);
		assert.equal((await askGate(user, "no-such-issue")).status, 404);
		assert.equal((await askGate({ slug: "no-such-news" }, "older")).status, 404);
	});

	test("is refused to a session of another newsletter, a subscriber who left, a forged cookie and a contact who never confirmed", async () => {
		const user = await setupGate("gate-refuse");
		const other = await setupGate("gate-refuse-other");
		const { jar: foreign } = await signedIn(other, "foreign@example.org");
		const fromOther = new Map([[`fs_reader_${user.slug}`, foreign.get(`fs_reader_${other.slug}`)]]);
		assert.equal((await askGate(user, "older", fromOther)).status, 401, "its signature is for another newsletter");

		const { contact, jar } = await signedIn(user, "leaver@example.org");
		await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { status: "unsubscribed" } });
		assert.equal((await askGate(user, "older", jar)).status, 401);
		assert.equal(jar.has(readerMarkerName(user.slug)), false, "the marker of a session that no longer works is removed");
		assert.equal((await askGate(user, "older", new Map([[`fs_reader_${user.slug}`, "forged.value"]]))).status, 401);
		const { jar: pendingJar } = await signedIn(user, "pending@example.org", { status: "pending" });
		assert.equal((await askGate(user, "older", pendingJar)).status, 401);
	});

	test("never gives a paid issue's full text, and stops a visitor who asks over and over", async () => {
		const user = await setupGate("gate-limit");
		await addIssue(user, "paid-one", { audience: "paid" });
		const { jar } = await signedIn(user, "member@example.org");
		assert.equal((await askGate(user, "paid-one", jar)).status, 403);
		const ip = nextIp();
		const statuses = [];
		for (let index = 0; index < 62; index += 1) statuses.push((await askGate(user, "older", jar, ip)).status);
		assert.equal(statuses[0], 200);
		assert.ok(statuses.includes(429));
	});

	test("opens on the newsletter's host through the proxy", async () => {
		const user = await setupGate("gate-host");
		const url = `https://${user.slug}.flockstackmail.com/api/gate?n=${user.slug}&p=${slugOf(user, "older")}`;
		const response = await m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
		assert.equal(response.headers.get("x-middleware-next"), "1");
	});
});

describe("getting in as a subscriber", () => {
	const requestLink = (user, email, name = "older", ip = nextIp()) =>
		visitAndFlush(ip, () => m.gateActions.requestGateSignIn(null, form({ newsletter: user.slug, email, p: slugOf(user, name) })));
	const SENT = { ok: true, message: "If this address is subscribed, a link to read the issue is on its way. It works once, for 30 minutes." };

	test("a link by email for a subscriber, the same answer for anyone, nothing for an issue that isn't gated", async () => {
		const user = await setupGate("gate-link", { confirm: false });
		await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "member@gmail.com", status: "active", source: "website" });
		const before = sesEmails.length;
		const known = await requestLink(user, "member@gmail.com");
		const unknown = await requestLink(user, "stranger@gmail.com");
		assert.deepEqual(known, unknown, "the answer doesn't tell the two apart");
		assert.deepEqual(known, SENT);
		const sentNow = sesEmails.slice(before).map((email) => JSON.stringify(email));
		const mail = sentNow.filter((email) => email.includes("member@gmail.com"));
		assert.equal(mail.length, 1);
		assert.equal(sentNow.some((email) => email.includes("stranger@gmail.com")), false);
		assert.match(mail[0], /Read older/);
		const link = /https:[^\s"<>)\\]*reader\/signin\?[^\s"<>)\\]*/.exec(mail[0].replaceAll("\\/", "/").replaceAll("&amp;", "&"))?.[0];
		assert.ok(link, mail[0].slice(0, 800));
		assert.equal(new URL(link).searchParams.get("g"), "1");
		assert.equal(new URL(link).searchParams.get("p"), slugOf(user, "older"));

		const open = sesEmails.length;
		await requestLink(user, "member@gmail.com", "newest");
		assert.equal(sesEmails.length, open, "the newest issue isn't gated: no link");
	});

	test("the link's page asks for a click, and the click opens the issue itself, not its comments", async () => {
		const user = await setupGate("gate-click", { confirm: false });
		const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "member@gmail.com", status: "active", source: "website" });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const post = slugOf(user, "older");
		const reference = { contactId: contact._id, newsletterId: user.newsletterId };
		const tokenOf = (link) => new URL(link).searchParams.get("token");
		const gateToken = tokenOf(m.readerLinks.getSignInUrl(reference, newsletter, { issueSlug: post, isGate: true }));
		const page = await anonymous(() => m.signinPage({ searchParams: Promise.resolve({ token: gateToken, p: post, g: "1" }) }));
		assert.match(text(page), /the full issue opens/);
		assert.match(html(page), /name="g" value="1"/);
		const jar = new Map();
		const destination = await runWithRequest({ jar }, () => catchRedirect(m.signinActions.continueSignIn(form({ token: gateToken, p: post, g: "1" }))));
		assert.equal(destination, `https://${user.slug}.flockstackmail.com/p/${post}`);
		assert.ok(jar.has(readerMarkerName(user.slug)), "the browser has a session");
		assert.equal((await askGate(user, "older", jar)).status, 200);

		// A link works once per subscriber and second, so the comment link is another subscriber's.
		const other = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "other@gmail.com", status: "active", source: "website" });
		const commentToken = tokenOf(m.readerLinks.getSignInUrl({ contactId: other._id, newsletterId: user.newsletterId }, newsletter, { issueSlug: post }));
		const comments = await runWithRequest({ jar: new Map() }, () => catchRedirect(m.signinActions.continueSignIn(form({ token: commentToken, p: post }))));
		assert.match(comments, /#comments$/, "a comment link still lands on the comments");
	});

	test("confirming a signup signs the browser in, so the issue opens", async () => {
		const user = await setupGate("gate-confirm");
		const result = await visitAndFlush(nextIp(), () => m.archive.subscribe(null, form({ newsletter: user.slug, email: "newbie@gmail.com", via: "gate" })));
		assert.equal(result.pending, true);
		const contact = await findContact(user, "newbie@gmail.com");
		assert.equal(contact.source, "gate");
		const token = m.confirmation.createConfirmToken({ contactId: contact._id, newsletterId: user.newsletterId });
		const jar = new Map();
		const confirmed = await runWithRequest({ jar }, () => m.confirm.confirmSubscription(token));
		assert.equal(confirmed.ok, true);
		assert.ok(jar.has(readerMarkerName(user.slug)), "the confirmation link signed the browser in");
		assert.equal((await askGate(user, "older", jar)).status, 200);
		const stranger = new Map();
		await runWithRequest({ jar: stranger }, () => m.confirm.confirmSubscription("not.a.token"));
		assert.equal(stranger.size, 0, "a link that doesn't work signs nobody in");
	});

	test("limits the links: 3 an hour for an address and 5 in 10 minutes for a network", async () => {
		const user = await setupGate("gate-link-limits", { confirm: false });
		const results = [];
		for (let index = 0; index < 4; index += 1) results.push(await requestLink(user, "same@gmail.com"));
		assert.deepEqual(results.slice(0, 3), [SENT, SENT, SENT]);
		assert.equal(results[3].error, "Too many requests for this address. Try again in an hour.");
		const ip = nextIp();
		const network = [];
		for (let index = 0; index < 7; index += 1) network.push((await requestLink(user, `net${index}@gmail.com`, "older", ip)).error ?? "ok");
		assert.deepEqual(network.slice(0, 5), Array(5).fill("ok"));
		assert.match(network[5], /Too many requests from your network/);
		const trap = await visitAndFlush(nextIp(), () => m.gateActions.requestGateSignIn(null, form({ newsletter: user.slug, email: "x@gmail.com", p: slugOf(user, "older"), website: "spam" })));
		assert.deepEqual(trap, SENT, "a bot is told it worked");
	});
});
