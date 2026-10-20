import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildVisit, hasOptedOut, readVisitedPage } from "../lib/visit-beacon.js";
import { api, assertError, creator, nextIp } from "./helpers/growth.mjs";
import { startTestApp } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

// The website's own analytics: page views, distinct visitors per day, referrers, countries and issues, counted in one row for
// each newsletter and day, with no cookie and nothing stored about a visitor.
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		route: await import("../app/api/visit/route.js"),
		lib: await import("../lib/web-analytics.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		Campaign: (await import("../models/Campaign.js")).default,
		WebDay: (await import("../models/WebDay.js")).default,
	};
});

after(() => app?.stop());

// A visit as a browser reports it, from its own address and browser.
function visit(body, { ip = nextIp(), userAgent = FIREFOX, headers = {} } = {}) {
	const request = new Request("https://news.flockstackmail.com/api/visit", {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": userAgent, "x-forwarded-for": ip, "cf-ipcountry": "NL", ...headers },
		body: JSON.stringify(body),
	});
	return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => m.route.POST(request));
}

const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (user) => m.WebDay.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, day: today() }).lean();

describe("the sketch of a day's visitors", () => {
	test("estimates how many distinct visitors raised it: exact for a few, within 15% for thousands", () => {
		const raise = (count) => {
			const registers = {};
			for (let index = 0; index < count; index += 1) {
				const { index: at, rank } = m.lib.getVisitorRegister({ ip: `10.${index >> 8}.${index & 255}.1`, userAgent: `agent ${index}`, newsletterId: "n", day: "2026-10-20" });
				registers[at] = Math.max(registers[at] ?? 0, rank);
			}
			return m.lib.estimateVisitors(registers);
		};
		assert.equal(m.lib.estimateVisitors({}), 0);
		assert.equal(raise(1), 1);
		for (const count of [10, 50]) assert.ok(Math.abs(raise(count) - count) <= Math.ceil(count * 0.1), `${count}: ${raise(count)}`);
		for (const count of [500, 5000]) assert.ok(Math.abs(raise(count) - count) / count < 0.15, `${count}: ${raise(count)}`);
	});

	test("the same visitor is the same register on a day, another on the next, and another at another newsletter", () => {
		const who = { ip: "203.0.113.9", userAgent: FIREFOX, newsletterId: "6650f1c2e9b1d4a012345678", day: "2026-10-20" };
		const a = m.lib.getVisitorRegister(who);
		assert.deepEqual(m.lib.getVisitorRegister(who), a);
		const spread = new Set();
		for (const change of [{ day: "2026-10-21" }, { newsletterId: "6650f1c2e9b1d4a012345679" }, { ip: "203.0.113.10" }, { userAgent: "other" }]) {
			spread.add(JSON.stringify(m.lib.getVisitorRegister({ ...who, ...change })));
		}
		assert.ok(spread.size >= 3, "different days, newsletters and visitors land in different places");
		assert.ok(a.index >= 0 && a.index < 256 && a.rank >= 1 && a.rank <= 25);
	});

	test("the day's key is not the app secret nor anything of the visitor", () => {
		const output = JSON.stringify(m.lib.getVisitorRegister({ ip: "203.0.113.9", userAgent: FIREFOX, newsletterId: "n", day: "2026-10-20" }));
		assert.ok(!output.includes("203.0.113") && !output.includes("Firefox"));
	});
});

describe("what a page tells the counter", () => {
	test("is its kind, the issue and where the visitor came from, and honors Do Not Track and Global Privacy Control", () => {
		assert.deepEqual(readVisitedPage("/"), { kind: "home" });
		assert.deepEqual(readVisitedPage("/archive/news"), { kind: "home" });
		assert.deepEqual(readVisitedPage("/p/an-issue"), { kind: "issue", post: "an-issue" });
		assert.deepEqual(readVisitedPage("/archive/news/p/an-issue/"), { kind: "issue", post: "an-issue" });
		assert.deepEqual(readVisitedPage("/authors/jane"), { kind: "other" });
		assert.deepEqual(readVisitedPage("/shop"), { kind: "other" });
		assert.deepEqual(buildVisit({ slug: "news", pathname: "/p/x", referrer: "https://news.ycombinator.com/" }), { n: "news", kind: "issue", post: "x", ref: "https://news.ycombinator.com/" });
		assert.deepEqual(buildVisit({ slug: "news", pathname: "/", referrer: "" }), { n: "news", kind: "home" });
		assert.equal(hasOptedOut({ navigator: { doNotTrack: "1" } }), true);
		assert.equal(hasOptedOut({ navigator: { msDoNotTrack: "1" } }), true);
		assert.equal(hasOptedOut({ window: { doNotTrack: "1" } }), true);
		assert.equal(hasOptedOut({ navigator: { globalPrivacyControl: true } }), true);
		assert.equal(hasOptedOut({ navigator: { doNotTrack: "0" }, window: {} }), false);
		assert.equal(hasOptedOut({ navigator: {}, window: {} }), false);
	});
});

describe("a visit", () => {
	test("counts a view, the country, the referrer's host and a published issue, and a visitor once a day", async () => {
		const user = await creator("web-count");
		const issue = await m.Campaign.findOne({ accountId: user.accountId, newsletterId: user.newsletterId }).lean();
		await m.Campaign.updateOne({ accountId: user.accountId, _id: issue._id }, { $set: { archiveSlug: "web-count-issue" } });
		const ip = nextIp();
		assert.equal((await visit({ n: user.slug, kind: "issue", post: "web-count-issue", ref: "https://www.News.Ycombinator.com/item?id=1" }, { ip })).status, 204);
		await visit({ n: user.slug, kind: "home" }, { ip });
		await visit({ n: user.slug, kind: "home" }, { ip: nextIp(), headers: { "cf-ipcountry": "FR" } });
		await visit({ n: user.slug, kind: "other", ref: `https://${user.slug}.flockstackmail.com/` }, { ip: nextIp(), headers: { "cf-ipcountry": "T1" } });
		const day = await dayOf(user);
		assert.equal(day.views, 4);
		assert.deepEqual(day.countries, { NL: 2, FR: 1, XX: 1 }, "T1 (Tor) and unknown are counted as unknown");
		assert.deepEqual(day.referrers, { "news,ycombinator,com": 1, direct: 3 }, "dots written as commas, the newsletter's own host isn't a referrer");
		assert.deepEqual(day.pages, { "web-count-issue": 1 });
		assert.equal(m.lib.estimateVisitors(day.hll), 3, "four views by three visitors");
	});

	test("keeps nothing that names the visitor", async () => {
		const user = await creator("web-private");
		const ip = "203.0.113.77";
		await visit({ n: user.slug, kind: "home", ref: "https://blog.example/post?email=secret@example.org" }, { ip, userAgent: "Mozilla/5.0 UniqueBrowser/9" });
		const stored = JSON.stringify(await dayOf(user));
		for (const secret of [ip, "UniqueBrowser", "secret@example.org", "/post", "203.0.113"]) assert.ok(!stored.includes(secret), `${secret} was kept`);
		assert.ok(stored.includes("blog,example"));
		const rows = await m.WebDay.countDocuments({ accountId: user.accountId, newsletterId: user.newsletterId });
		assert.equal(rows, 1, "one row for the day, not one for the visit");
	});

	test("isn't counted for Do Not Track, Global Privacy Control, a crawler, a flood, or a page that isn't a newsletter's", async () => {
		const user = await creator("web-skip");
		const body = { n: user.slug, kind: "home" };
		assert.equal((await visit(body, { headers: { dnt: "1" } })).status, 204);
		assert.equal((await visit(body, { headers: { "sec-gpc": "1" } })).status, 204);
		assert.equal((await visit(body, { userAgent: "Googlebot/2.1" })).status, 204);
		assert.equal((await visit(body, { userAgent: "" })).status, 204);
		assert.equal((await visit({ n: "no-such-news", kind: "home" })).status, 204);
		assert.equal((await visit({ n: "Bad Slug!", kind: "home" })).status, 204);
		assert.equal((await visit({ n: user.slug, kind: "admin" })).status, 204);
		assert.equal(await dayOf(user), null, "none of that was counted");
		await visit({ n: user.slug, kind: "home", ref: 42 });
		assert.equal((await dayOf(user)).views, 1, "a referrer that isn't text is ignored, the view counts");

		const ip = nextIp();
		for (let index = 0; index < 100; index += 1) await visit(body, { ip });
		assert.equal((await dayOf(user)).views, 1 + 90, "a visitor past 90 in 10 minutes isn't");
	});

	test("doesn't count a post that isn't a published issue of the newsletter, and caps the referrers a day can hold", async () => {
		const user = await creator("web-caps");
		await visit({ n: user.slug, kind: "issue", post: "not-an-issue" });
		assert.deepEqual((await dayOf(user)).pages ?? {}, {}, "counted as a view only");
		const filter = { accountId: user.accountId, newsletterId: user.newsletterId, day: today() };
		const crowded = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`site${index},example`, 1]));
		await m.WebDay.updateOne(filter, { $set: { referrers: crowded } });
		await visit({ n: user.slug, kind: "home", ref: "https://one-more.example/" });
		await visit({ n: user.slug, kind: "home", ref: "https://site7.example/" });
		const day = await dayOf(user);
		assert.equal(day.referrers.other, 1, "past 100 hosts a day, the rest are counted together");
		assert.equal(Object.keys(day.referrers).length, 101 + 0);
		assert.equal(day.referrers["one-more,example"], undefined);
	});

	test("counts another day's visitor again, and the report adds the days up", async () => {
		const user = await creator("web-days");
		const newsletter = await (await import("../models/Newsletter.js")).default.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const args = { newsletter, kind: "home", referrer: "", country: "NL", ip: "203.0.113.5", userAgent: FIREFOX };
		await m.lib.countVisit({ ...args, now: new Date("2026-10-18T12:00:00Z") });
		await m.lib.countVisit({ ...args, now: new Date("2026-10-18T13:00:00Z") });
		await m.lib.countVisit({ ...args, now: new Date("2026-10-19T12:00:00Z") });
		const report = await m.lib.getSiteReport({ account: { _id: user.accountId }, newsletter, days: 3, now: new Date("2026-10-20T08:00:00Z") });
		assert.deepEqual(report.daily, [
			{ date: "2026-10-18", views: 2, visitors: 1 },
			{ date: "2026-10-19", views: 1, visitors: 1 },
			{ date: "2026-10-20", views: 0, visitors: 0 },
		]);
		assert.deepEqual(report.totals, { views: 3, visitors: 2 });
	});

	test("opens on the newsletter's host through the proxy", async () => {
		const url = "https://anything.flockstackmail.com/api/visit";
		const response = await m.proxy(new m.NextRequest(url, { method: "POST", headers: { host: new URL(url).host } }));
		assert.equal(response.headers.get("x-middleware-next"), "1");
	});
});

describe("the website report", () => {
	test("reads the days, who sent the visitors, their countries and the issues, from the API", async () => {
		const user = await creator("web-report");
		const issue = await m.Campaign.findOne({ accountId: user.accountId, newsletterId: user.newsletterId }).lean();
		await m.Campaign.updateOne({ accountId: user.accountId, _id: issue._id }, { $set: { archiveSlug: "web-report-issue", subject: "The issue" } });
		for (let index = 0; index < 3; index += 1) await visit({ n: user.slug, kind: "issue", post: "web-report-issue", ref: "https://news.ycombinator.com/" });
		await visit({ n: user.slug, kind: "home" }, { headers: { "cf-ipcountry": "FR" } });
		const report = (await api(user.key, "GET", `/reports/site?newsletter=${user.slug}&days=7`)).body;
		assert.equal(report.daily.length, 7);
		assert.deepEqual(report.daily.at(-1), { date: today(), views: 4, visitors: 4 });
		assert.deepEqual(report.referrers, [{ referrer: "Direct or unknown", views: 1 }, { referrer: "news.ycombinator.com", views: 3 }].sort((a, b) => b.views - a.views));
		assert.deepEqual(report.countries.map(({ country, code, views }) => [country, code, views]), [["Netherlands", "NL", 3], ["France", "FR", 1]]);
		assert.deepEqual(report.pages, [{ slug: "web-report-issue", title: "The issue", views: 3 }]);
		assert.deepEqual(report.totals, { views: 4, visitors: 4 });
		assertError(await api(user.key, "GET", `/reports/site?newsletter=${user.slug}&days=366`), 400, "validation_failed");
	});

	test("exports each table as CSV", async () => {
		const user = await creator("web-csv");
		await visit({ n: user.slug, kind: "home", ref: "https://news.ycombinator.com/" });
		const get = async (table) => (await api(user.key, "GET", `/reports/export?newsletter=${user.slug}&report=site&days=7&table=${table}`)).body;
		assert.equal((await get("daily")).csv.split("\r\n")[0], "date,views,visitors");
		assert.equal((await get("referrers")).csv, "referrer,views\r\nnews.ycombinator.com,1\r\n");
		assert.equal((await get("countries")).csv, "country,views\r\nNetherlands,1\r\n");
		assert.equal((await get("pages")).csv.split("\r\n")[0], "issue,address,views");
		assert.match((await get("daily")).filename, /^site-daily-/);
	});

	test("the sketch is a small number of registers, however many visitors", async () => {
		const user = await creator("web-size");
		for (let index = 0; index < 40; index += 1) await visit({ n: user.slug, kind: "home" }, { ip: `203.0.${index}.1`, userAgent: `browser ${crypto.randomUUID()}` });
		const day = await dayOf(user);
		assert.ok(Object.keys(day.hll).length <= 256);
		assert.ok(JSON.stringify(day).length < 4000);
	});
});

describe("a newsletter's website", () => {
	const ROOT = fileURLToPath(new URL("../", import.meta.url));
	const COMPONENTS = ["TrackVisit", "TrackView", "ProviderSubscribe", "TriggerSubscribe", "GateIssue", "FormSubscribe", "FooterArchive", "HeaderArchive", "PitchSubscribe", "FormEmbed"];

	async function sources() {
		const files = [];
		for (const entry of await readdir(join(ROOT, "app/archive"), { recursive: true })) if (entry.endsWith(".js")) files.push(join("app/archive", entry));
		files.push(...COMPONENTS.map((name) => `components/${name}.jsx`), "lib/web-analytics.js", "lib/visit-beacon.js", "lib/popup-trigger.js", "lib/storage.js", "app/api/visit/route.js", "app/f/[id]/route.js");
		return Promise.all(files.map(async (file) => [file, await readFile(join(ROOT, file), "utf8")]));
	}

	test("loads no script, pixel or tracking call from another company, and sets no cookie for its counts", async () => {
		for (const [file, source] of await sources()) {
			assert.doesNotMatch(source, /<script[^>]*\bsrc=/i, `${file} loads a script`);
			assert.doesNotMatch(source, /new Image\(/, `${file} makes a pixel`);
			assert.doesNotMatch(source, /(?:fetch|sendBeacon)\(\s*["'`]https?:/, `${file} calls another address`);
			assert.doesNotMatch(source, /(?:gtag|fbq|_paq|plausible|posthog|googletagmanager|facebook\.net)/i, `${file} names a tracker`);
		}
		for (const file of ["lib/web-analytics.js", "app/api/visit/route.js", "components/TrackVisit.jsx"]) {
			const source = await readFile(join(ROOT, file), "utf8");
			assert.doesNotMatch(source, /cookies\(\)|document\.cookie|Set-Cookie|localStorage|sessionStorage/i, `${file} keeps something on the visitor`);
		}
	});
});
