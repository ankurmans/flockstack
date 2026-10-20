import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildBuckets, getBucketKey, getDefaultGranularity, listDayKeys, toCsv } from "../lib/report-rules.js";
import { api, assertError, creator } from "./helpers/growth.mjs";
import { as, startTestApp } from "./helpers/app.mjs";

// The reports: how a newsletter grew over any range by where signups came from, issues side by side, and every table as CSV.
const DAY = 86_400_000;
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		growthPage: (await import("../app/(app)/reports/page.js")).default,
		issuesPage: (await import("../app/(app)/reports/issues/page.js")).default,
		sitePage: (await import("../app/(app)/reports/site/page.js")).default,
		exportActions: await import("../app/(app)/reports/actions.js"),
		robots: (await import("../app/robots.js")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Campaign: (await import("../models/Campaign.js")).default,
		CampaignLink: (await import("../models/CampaignLink.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Form: (await import("../models/Form.js")).default,
	};
});

after(() => app?.stop());

const daysAgo = (count, hour = 10) => {
	const date = new Date(Date.now() - count * DAY);
	date.setUTCHours(hour, 0, 0, 0);
	return date;
};
const dayKey = (count) => daysAgo(count).toISOString().slice(0, 10);

describe("ranges and buckets", () => {
	test("a range is days ending today, bucketed by day, Monday-first week or month", () => {
		const days = listDayKeys("2026-10-20", 5);
		assert.deepEqual(days, ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]);
		assert.equal(getBucketKey("2026-10-18", "week"), "2026-10-12", "a Sunday belongs to the week of the Monday before");
		assert.equal(getBucketKey("2026-10-19", "week"), "2026-10-19");
		assert.equal(getBucketKey("2026-10-20", "month"), "2026-10");
		assert.deepEqual(
			buildBuckets(days, "week").map(({ key, days: count }) => [key, count]),
			[["2026-10-12", 3], ["2026-10-19", 2]]
		);
		assert.deepEqual([getDefaultGranularity(30), getDefaultGranularity(90), getDefaultGranularity(365), getDefaultGranularity(730)], ["day", "week", "week", "month"]);
	});

	test("a CSV quotes what a spreadsheet would run", () => {
		const csv = toCsv([["a", (row) => row.a], ["b", (row) => row.b]], [{ a: "=HYPERLINK(\"x\")", b: "plain, comma" }, { a: "+1", b: null }]);
		assert.equal(csv, 'a,b\r\n"\'=HYPERLINK(""x"")","plain, comma"\r\n\'+1,\r\n');
	});
});

async function seed(name) {
	const user = await creator(name, { confirm: false, issue: false });
	const form = await m.Form.create({ accountId: user.accountId, newsletterId: user.newsletterId, name: "Homepage" });
	const make = (email, extra) => m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: `${email}@example.org`, ...extra });
	await make("a", { status: "active", source: "website", subscribedAt: daysAgo(1), acquisition: { channel: "direct" } });
	await make("b", { status: "active", source: "popup", subscribedAt: daysAgo(1), acquisition: { channel: "direct" } });
	await make("c", { status: "active", source: `form:${form._id}`, subscribedAt: daysAgo(3), acquisition: { channel: "email", utm: { campaign: "swap" }, referrer: "partner.example" } });
	await make("d", { status: "unsubscribed", source: "website", subscribedAt: daysAgo(10), unsubscribedAt: daysAgo(2) });
	await make("e", { status: "active", source: "import", subscribedAt: daysAgo(5) });
	await make("f", { status: "pending", source: "website", subscribedAt: daysAgo(1) });
	await make("g", { status: "active", source: "recommendation:other", subscribedAt: daysAgo(40) });
	await make("h", { status: "unsubscribed", source: "import", subscribedAt: daysAgo(60), unsubscribedAt: daysAgo(2) });
	return { user, form };
}

describe("the growth report", () => {
	test("counts who joined and left, never a pending signup or an import's leaver, and works the total back from today", async () => {
		const { user } = await seed("rep-growth");
		const report = (await api(user.key, "GET", `/reports/growth?newsletter=${user.slug}&days=30&by=none`)).body;
		assert.deepEqual(report.totals, { new: 5, left: 1, net: 4, active: 5, pending: 1, startingActive: 1 });
		assert.equal(report.granularity, "day");
		assert.equal(report.buckets.length, 30);
		assert.equal(report.buckets.at(-1).key, dayKey(0));
		assert.equal(report.buckets.at(-1).total, 5, "the last day ends on today's subscribers");
		const byKey = Object.fromEntries(report.buckets.map((bucket) => [bucket.key, bucket]));
		assert.deepEqual({ new: byKey[dayKey(1)].new, total: byKey[dayKey(1)].total }, { new: 2, total: 5 });
		assert.deepEqual({ left: byKey[dayKey(2)].left, net: byKey[dayKey(2)].net, total: byKey[dayKey(2)].total }, { left: 1, net: -1, total: 3 });
		assert.deepEqual({ new: byKey[dayKey(3)].new, total: byKey[dayKey(3)].total }, { new: 1, total: 4 });
		assert.equal(byKey[dayKey(10)].new, 1);
		assert.equal(byKey[dayKey(29)].total, 1, "the starting subscribers");
		assert.deepEqual(report.groups, []);
	});

	test("goes beyond 30 days, by week and by month, with the same totals", async () => {
		const { user } = await seed("rep-range");
		const get = async (query) => (await api(user.key, "GET", `/reports/growth?newsletter=${user.slug}&by=none&${query}`)).body;
		const fortyFive = await get("days=45&granularity=week");
		assert.deepEqual({ new: fortyFive.totals.new, left: fortyFive.totals.left }, { new: 6, left: 1 }, "the signup 40 days ago is in range now");
		const ninety = await get("days=90");
		assert.equal(ninety.granularity, "week");
		assert.deepEqual({ new: ninety.totals.new, left: ninety.totals.left }, { new: 7, left: 1 }, "and the one 60 days ago, an import");
		const month = await get("days=730");
		assert.equal(month.granularity, "month");
		assert.equal(month.totals.new, 7);
		assert.equal(month.totals.left, 1, "the import's own leaver is never counted");
		const weeks = await get("days=90&granularity=week");
		const days = await get("days=90&granularity=day");
		assert.equal(days.buckets.length, 90);
		assert.equal(weeks.buckets.reduce((sum, bucket) => sum + bucket.new, 0), days.buckets.reduce((sum, bucket) => sum + bucket.new, 0));
		assert.equal(weeks.buckets.at(-1).total, days.buckets.at(-1).total);
		assert.equal(month.buckets.at(-1).total, 5);
	});

	test("splits the joins by source, channel, campaign and form, folding what an older contact never recorded", async () => {
		const { user, form } = await seed("rep-groups");
		const groups = async (by) => (await api(user.key, "GET", `/reports/growth?newsletter=${user.slug}&days=30&by=${by}`)).body.groups;
		const summary = (rows) => Object.fromEntries(rows.map(({ label, new: count, active }) => [label, [count, active]]));
		assert.deepEqual(summary(await groups("source")), { Website: [2, 1], "Pop-up": [1, 1], "Form: Homepage": [1, 1], Import: [1, 1] }, "the pending signup and the one outside the range aren't there");
		const channels = await groups("channel");
		assert.deepEqual(summary(channels), { Direct: [3, 2], Email: [1, 1], Imports: [1, 1] }, "contacts without a recorded channel have the one their source says");
		assert.equal(channels.find(({ label }) => label === "Direct").retention, 0.6667);
		assert.deepEqual(summary(await groups("campaign")), { "No campaign": [4, 3], swap: [1, 1] });
		assert.deepEqual(summary(await groups("form")), { "Form: Homepage": [1, 1] });
		const website = (await groups("source")).find(({ label }) => label === "Website");
		assert.equal(website.series.reduce((sum, value) => sum + value, 0), website.new);
		assert.equal(website.series.length, 30);

		await m.Form.deleteOne({ accountId: user.accountId, _id: form._id });
		assert.ok((await groups("source")).some(({ label }) => label === "Form: deleted form"), "a deleted form's signups keep their place");
	});

	test("folds a long tail into Other", async () => {
		const user = await creator("rep-fold", { confirm: false });
		for (let index = 0; index < 12; index += 1) {
			await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: `s${index}@example.org`, status: "active", source: "api", subscribedAt: daysAgo(1), acquisition: { channel: "api", utm: { campaign: `campaign-${index}` } } });
		}
		const groups = (await api(user.key, "GET", `/reports/growth?newsletter=${user.slug}&days=30&by=campaign`)).body.groups;
		assert.equal(groups.length, 9);
		assert.equal(groups.at(-1).label, "Other");
		assert.equal(groups.at(-1).new, 4);
		assert.equal(groups.reduce((sum, group) => sum + group.new, 0), 12);
	});

	test("checks its inputs and keeps accounts apart", async () => {
		const { user } = await seed("rep-isolation");
		const other = await creator("rep-isolation-other", { confirm: false });
		assertError(await api(user.key, "GET", `/reports/growth?newsletter=${user.slug}&days=0`), 400, "validation_failed");
		assertError(await api(user.key, "GET", `/reports/growth?newsletter=${user.slug}&days=731`), 400, "validation_failed");
		assertError(await api(user.key, "GET", `/reports/growth?newsletter=${user.slug}&by=nope`), 400, "validation_failed");
		assertError(await api(user.key, "GET", `/reports/growth?newsletter=${other.slug}`), 404, "not_found");
		const empty = (await api(other.key, "GET", `/reports/growth?newsletter=${other.slug}&days=30`)).body;
		assert.deepEqual({ new: empty.totals.new, active: empty.totals.active }, { new: 0, active: 0 }, "nothing of the other account");
	});
});

describe("comparing issues", () => {
	async function issues(name) {
		const user = await creator(name, { confirm: false, issue: false });
		const make = async (subject, daysBack, stats, extra = {}) =>
			m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject, status: "sent", sentAt: daysAgo(daysBack), startedAt: daysAgo(daysBack), stats, webViews: 7, ...extra });
		const one = await make("First", 30, { sent: 100, delivered: 98, opened: 49, clicked: 10, unsubscribed: 2, bounced: 2, complained: 0 });
		const two = await make("=SUM(1,1) Second", 20, { sent: 200, delivered: 200, opened: 50, clicked: 40, unsubscribed: 1, bounced: 0, complained: 1 });
		const three = await make("Third", 10, { sent: 0, delivered: 0 });
		await make("Imported post", 5, { sent: 9 }, { importKey: "substack:1" });
		await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "A draft", status: "draft" });
		await m.CampaignLink.create({ accountId: user.accountId, campaignId: one._id, index: 0, url: "https://example.com/a", uniqueClicks: 3, clicks: 4 });
		await m.CampaignLink.create({ accountId: user.accountId, campaignId: one._id, index: 1, url: "https://example.com/b", uniqueClicks: 6, clicks: 6 });
		return { user, one, two, three };
	}

	test("lists the newest sent issues with their rates, a most-clicked link, and leaves out drafts and imports", async () => {
		const { user, one } = await issues("rep-issues");
		const { issues: rows } = (await api(user.key, "GET", `/reports/issues?newsletter=${user.slug}`)).body;
		assert.deepEqual(rows.map(({ subject }) => subject), ["Third", "=SUM(1,1) Second", "First"]);
		const first = rows.find(({ id }) => id === String(one._id));
		assert.deepEqual(
			{ openRate: first.openRate, clickRate: first.clickRate, unsubscribeRate: first.unsubscribeRate, webViews: first.webViews, topLink: first.topLink },
			{ openRate: 0.5, clickRate: 0.102, unsubscribeRate: 0.0204, webViews: 7, topLink: { url: "https://example.com/b", uniqueClicks: 6 } }
		);
		const empty = rows[0];
		assert.deepEqual({ openRate: empty.openRate, topLink: empty.topLink }, { openRate: null, topLink: null }, "no delivered email, no rate");
	});

	test("compares chosen issues, a date range or a count", async () => {
		const { user, one, two } = await issues("rep-issues-filter");
		const get = async (query) => (await api(user.key, "GET", `/reports/issues?newsletter=${user.slug}&${query}`)).body.issues.map(({ subject }) => subject);
		assert.deepEqual(await get(`ids=${one._id},${two._id}`), ["=SUM(1,1) Second", "First"]);
		assert.deepEqual(await get("limit=1"), ["Third"]);
		assert.deepEqual(await get(`from=${dayKey(25)}&to=${dayKey(15)}`), ["=SUM(1,1) Second"]);
		assertError(await api(user.key, "GET", `/reports/issues?newsletter=${user.slug}&ids=nope`), 400, "validation_failed");
		assert.match(assertError(await api(user.key, "GET", `/reports/issues?newsletter=${user.slug}&ids=${Array.from({ length: 11 }, (_, index) => index.toString(16).padStart(24, "0")).join(",")}`), 400, "validation_failed"), /10 issues at most/);
		assertError(await api(user.key, "GET", `/reports/issues?newsletter=${user.slug}&from=yesterday`), 400, "validation_failed");
		assertError(await api(user.key, "GET", `/reports/issues?newsletter=${user.slug}&limit=26`), 400, "validation_failed");
	});
});

describe("the CSV export", () => {
	test("has each table of each report, with the same numbers as the page", async () => {
		const { user } = await seed("rep-csv");
		const csv = async (query) => (await api(user.key, "GET", `/reports/export?newsletter=${user.slug}&${query}`)).body;
		const series = await csv("report=growth&days=30&by=none");
		assert.match(series.filename, /^growth-by-day-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
		const lines = series.csv.trimEnd().split("\r\n");
		assert.equal(lines[0], "period,new,left,net,total");
		assert.equal(lines.length - 1, 30);
		assert.equal(series.rows, 30);
		assert.equal(lines.at(-1), `${dayKey(0)},0,0,0,5`);

		const breakdown = await csv("report=growth&days=30&by=channel&table=breakdown");
		const header = breakdown.csv.split("\r\n")[0].split(",");
		assert.deepEqual(header.slice(0, 4), ["group", "new", "still_subscribed", "retention"]);
		assert.equal(header.length, 4 + 30);
		assert.ok(breakdown.csv.includes("Direct,3,2,0.6667,"));
		assert.match(breakdown.filename, /^growth-channel-/);
		assert.match(assertError(await api(user.key, "GET", `/reports/export?newsletter=${user.slug}&report=growth&table=nope`), 400, "validation_failed"), /series, breakdown/);
		assert.match(assertError(await api(user.key, "GET", `/reports/export?newsletter=${user.slug}&report=issues&table=daily`), 400, "validation_failed"), /issues has issues/);
	});

	test("quotes an issue's subject that a spreadsheet would run as a formula", async () => {
		const user = await creator("rep-csv-issues", { confirm: false, issue: false });
		await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "=HYPERLINK(\"http://evil.example\")", status: "sent", sentAt: daysAgo(1), stats: { sent: 10, delivered: 10, opened: 5 } });
		const { csv, filename, rows } = (await api(user.key, "GET", `/reports/export?newsletter=${user.slug}&report=issues`)).body;
		assert.equal(filename, "issues.csv");
		assert.equal(rows, 1);
		const [header, line] = csv.trimEnd().split("\r\n");
		assert.equal(header, "subject,sent_at,audience,sent,delivered,opened,open_rate,clicked,click_rate,unsubscribed,unsubscribe_rate,bounced,complained,web_views,top_link,top_link_unique_clicks");
		assert.ok(line.startsWith(`"'=HYPERLINK(""http://evil.example"")",`), line);
		assert.match(line, /,all,10,10,5,0\.5,/);
	});
});

describe("the dashboard", () => {
	test("shows the growth report, the issues and the website, and robots keeps crawlers off", async () => {
		const { user } = await seed("rep-pages");
		const render = async (element) => renderToStaticMarkup(createElement(m.TooltipProvider, null, await element));
		const growth = await as(user, () => render(m.growthPage({ searchParams: Promise.resolve({ days: "90", by: "channel" }) })));
		assert.match(growth, /Direct/);
		assert.match(growth, /Export periods/);
		assert.match(growth, /href="\/reports\?[^"]*days=180/);
		assert.match(growth, /role="img"/);
		const fallback = await as(user, () => render(m.growthPage({ searchParams: Promise.resolve({ days: "nonsense", by: "<script>" }) })));
		assert.match(fallback, /Source/);
		assert.doesNotMatch(fallback, /<script>/);
		const issuesPage = await as(user, () => render(m.issuesPage({ searchParams: Promise.resolve({}) })));
		assert.match(issuesPage, /No sent issues yet/);
		assert.match(await as(user, () => render(m.sitePage({ searchParams: Promise.resolve({ days: "7" }) }))), /Page views/);
		assert.ok(m.robots().rules.disallow.includes("/reports"));
		const exported = await as(user, () => m.exportActions.exportReport({ report: "growth", newsletter: user.slug, days: 30, by: "none" }));
		assert.equal(exported.rows, 30);
		const refused = await as(user, () => m.exportActions.exportReport({ report: "growth", newsletter: user.slug, table: "nope" }));
		assert.match(refused.error, /series, breakdown/);
	});
});
