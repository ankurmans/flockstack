import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as, jsonRequest, platformEmails, startTestApp } from "./helpers/app.mjs";
import { readFixture, serveFeeds } from "./helpers/feeds.mjs";
import { QSTASH_KEYS, act, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { sent } from "./stubs/ses.mjs";

// beehiiv parity S7: a series makes an issue from a feed's new items on a schedule, as a draft or sent, once per slot.

let app;
let m;
let feeds;
let body;

const BLOG = "https://blog.example.com/feed.xml";
const AT = (text) => new Date(text);

function item(id, title, date) {
	return `<item><title>${title}</title><link>https://blog.example.com/${id}</link><guid>${id}</guid>${date ? `<pubDate>${new Date(date).toUTCString()}</pubDate>` : ""}<description>About ${title}.</description></item>`;
}

function feedWith(...items) {
	return `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${items.join("")}</channel></rss>`;
}

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = {
		...(await loadSendingModules()),
		rules: await import("../lib/series-rules.js"),
		series: await import("../lib/series.js"),
		jobRoute: await import("../app/api/jobs/run-series/route.js"),
		FeedCache: (await import("../models/FeedCache.js")).default,
		SeriesPlan: (await import("../models/SeriesPlan.js")).default,
		SeriesRun: (await import("../models/SeriesRun.js")).default,
	};
	body = readFixture("blog.rss.xml");
	feeds = serveFeeds(new Map([[BLOG, () => body]]));
});

after(() => {
	feeds?.restore();
	return app?.stop();
});

describe("the schedule", () => {
	const weekly = { frequency: "weekly", days: [1, 4], hour: 8, timeZone: "Europe/Paris" };

	test("the next run is the schedule's hour in its time zone on a day it runs, daylight saving included", () => {
		let at = AT("2026-10-20T10:00:00Z");
		const runs = [];
		for (let index = 0; index < 4; index++) runs.push((at = m.rules.getNextRun(weekly, at)).toISOString());
		assert.deepEqual(runs, ["2026-10-22T06:00:00.000Z", "2026-10-26T07:00:00.000Z", "2026-10-29T07:00:00.000Z", "2026-11-02T07:00:00.000Z"]);
		assert.equal(m.rules.getNextRun({ frequency: "daily", hour: 8, timeZone: "UTC" }, AT("2026-10-20T07:59:59Z")).toISOString(), "2026-10-20T08:00:00.000Z");
		assert.equal(m.rules.getNextRun({ frequency: "daily", hour: 8, timeZone: "UTC" }, AT("2026-10-20T08:00:00Z")).toISOString(), "2026-10-21T08:00:00.000Z");
		assert.equal(m.rules.getNextRun({ frequency: "monthly", dayOfMonth: 28, hour: 0, timeZone: "UTC" }, AT("2027-02-28T00:00:00Z")).toISOString(), "2027-03-28T00:00:00.000Z");
		assert.equal(m.rules.getNextRun({ frequency: "daily", hour: 2, timeZone: "America/New_York" }, AT("2026-11-01T05:30:00Z")).toISOString(), "2026-11-01T07:00:00.000Z");
		assert.equal(m.rules.describeSchedule(weekly), "Weekly on Mondays and Thursdays at 08:00 (Europe/Paris)");
		assert.equal(m.rules.describeSchedule({ frequency: "monthly", dayOfMonth: 3, hour: 9, timeZone: "UTC" }), "Monthly on day 3 at 09:00 (UTC)");
	});

	test("subjects fill in the date in the series' time zone, the first title and the count, and leave other tags alone", () => {
		const filled = m.rules.fillSeriesTemplate("{{date}}: {{first_title}} and {{count}} more, {{first_name|there}}", { date: AT("2026-10-20T23:30:00Z"), firstTitle: "Hello", count: 3, timeZone: "Asia/Tokyo" });
		assert.equal(filled, "Oct 21, 2026: Hello and 3 more, {{first_name|there}}");
	});

	test("the settings are checked", () => {
		const valid = { name: "Links", feedUrl: BLOG, subject: "S", mode: "draft", count: 3, schedule: weekly };
		assert.equal(m.rules.getSeriesProblem(valid), null);
		const problems = [
			[{ name: " " }, /Name the series/],
			[{ feedUrl: "http://blog.example.com/feed" }, /https/],
			[{ feedUrl: "https://10.0.0.1/feed" }, /private network/],
			[{ subject: "" }, /subject/],
			[{ mode: "yolo" }, /send automatically/],
			[{ count: 11 }, /1 to 10/],
			[{ schedule: { ...weekly, days: [] } }, /days of the week/],
			[{ schedule: { ...weekly, days: [7] } }, /days of the week/],
			[{ schedule: { frequency: "monthly", dayOfMonth: 31, hour: 8 } }, /1 to 28/],
			[{ schedule: { ...weekly, hour: 24 } }, /0 to 23/],
			[{ schedule: { ...weekly, timeZone: "Mars/Olympus" } }, /time zone/],
			[{ schedule: { frequency: "hourly", hour: 1 } }, /daily, weekly or monthly/],
		];
		for (const [change, pattern] of problems) assert.match(m.rules.getSeriesProblem({ ...valid, ...change }), pattern, JSON.stringify(change));
	});
});

describe("managing a series", () => {
	let user;

	before(async () => {
		user = await setupSender(m, "series-manage@example.com", { contacts: 1 });
	});

	test("created off, turned on with a next run, changed, paused and deleted, through the API", async () => {
		const created = await act(m, user, "create_series", { name: "Weekly links", feedUrl: BLOG, subject: "This week: {{first_title}}", schedule: { frequency: "weekly", days: [1, 4], hour: 8, timeZone: "europe/paris" } });
		assert.equal(created.active, false);
		assert.equal(created.nextRunAt, null);
		assert.equal(created.mode, "draft");
		assert.equal(created.schedule.timeZone, "Europe/Paris");
		assert.equal(created.scheduleSummary, "Weekly on Mondays and Thursdays at 08:00 (Europe/Paris)");
		assert.deepEqual([created.count, created.order, created.image, created.excerpt, created.date], [3, "newest", true, true, true]);

		const on = await act(m, user, "update_series", { id: created.id, active: true });
		assert.equal(on.active, true);
		assert.ok(new Date(on.nextRunAt) > new Date());

		const daily = await act(m, user, "update_series", { id: created.id, schedule: { frequency: "daily", hour: 6 }, mode: "send" });
		assert.deepEqual([daily.schedule.frequency, daily.schedule.days, daily.schedule.hour, daily.schedule.timeZone, daily.mode], ["daily", [], 6, "Europe/Paris", "send"]);
		assert.match(daily.scheduleSummary, /^Every day at 06:00/);

		const off = await act(m, user, "update_series", { id: created.id, active: false });
		assert.equal(off.nextRunAt, null);
		assert.equal((await act(m, user, "list_series", {})).series.length, 1);
		await assert.rejects(act(m, user, "update_series", { id: created.id, schedule: { frequency: "monthly", dayOfMonth: 30 } }), { code: "validation_failed" });
		await assert.rejects(act(m, user, "update_series", { id: created.id, feedUrl: "http://example.com/feed" }), { code: "validation_failed" });

		assert.deepEqual(await act(m, user, "delete_series", { id: created.id }), { id: created.id, deleted: true });
		assert.deepEqual((await act(m, user, "list_series", {})).series, []);
		await assert.rejects(act(m, user, "update_series", { id: created.id, active: true }), { code: "not_found" });
	});

	test("a newsletter has 10 series at most, and an account sees only its own", async () => {
		const newsletter = user.newsletterId;
		for (let index = 0; index < 10; index++) {
			await act(m, user, "create_series", { newsletter, name: `Series ${index}`, feedUrl: BLOG, subject: "S" });
		}
		await assert.rejects(act(m, user, "create_series", { newsletter, name: "One more", feedUrl: BLOG, subject: "S" }), { code: "conflict" });
		const other = await setupSender(m, "series-other@example.com", { contacts: 1 });
		assert.deepEqual((await act(m, other, "list_series", {})).series, []);
		const [first] = (await act(m, user, "list_series", {})).series;
		await assert.rejects(act(m, other, "update_series", { id: first.id, name: "Mine now" }), { code: "not_found" });
		await assert.rejects(act(m, other, "run_series", { id: first.id }), { code: "not_found" });
	});
});

describe("runs", () => {
	let user;

	async function makeSeries(overrides = {}) {
		const series = await act(m, user, "create_series", { name: "Links", feedUrl: BLOG, subject: "{{date}}: {{first_title}}", previewText: "{{count}} new", schedule: { frequency: "daily", hour: 8 }, active: true, ...overrides });
		return series;
	}

	async function makeDue(series, at = new Date(Date.now() - 60_000)) {
		await m.SeriesPlan.updateOne({ accountId: user.accountId, _id: series.id }, { $set: { nextRunAt: at } });
	}

	before(async () => {
		user = await setupSender(m, "series-runs@example.com", { contacts: 2 });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });
	});

	test("a due series makes a draft of the feed's items once, however many jobs run, and the owner is told", async () => {
		const series = await makeSeries({ count: 2 });
		await makeDue(series);
		const results = await Promise.all([m.series.runDueSeries(), m.series.runDueSeries()]);
		assert.equal(results.reduce((total, { ran }) => total + ran, 0), 1, "claimed by one of the two");

		const campaigns = await m.Campaign.find({ accountId: user.accountId, seriesId: series.id }).lean();
		assert.equal(campaigns.length, 1);
		const [campaign] = campaigns;
		assert.deepEqual([campaign.status, campaign.source, campaign.format], ["draft", "series", "rich"]);
		assert.match(campaign.subject, /^[A-Z][a-z]{2} \d{1,2}, \d{4}: Third post: what changed$/);
		assert.equal(campaign.previewText, "2 new");
		assert.match(campaign.html, /<h3><a href="https:\/\/blog\.example\.com\/third">Third post: what changed<\/a><\/h3>/);
		assert.match(campaign.html, /Second post/);
		assert.doesNotMatch(campaign.html, /First post/);
		assert.equal(campaign.thumbnailUrl, "https://cdn.example.com/third.jpg");

		const [run] = (await act(m, user, "list_series_runs", { id: series.id })).runs;
		assert.deepEqual([run.status, run.itemCount, run.campaignId, run.isManual], ["drafted", 2, String(campaign._id), false]);
		const after = (await act(m, user, "list_series", {})).series.find(({ id }) => id === series.id);
		assert.ok(new Date(after.nextRunAt) > new Date());
		assert.equal(after.lastRun.status, "drafted");
		assert.ok(platformEmails.some(({ subject }) => /draft is ready to review/i.test(subject)));

		const slot = (await m.SeriesRun.findOne({ accountId: user.accountId, seriesId: series.id }).lean()).slot;
		const same = await m.series.runSeries({ series: await m.SeriesPlan.findOne({ accountId: user.accountId, _id: series.id }).lean(), slot });
		assert.deepEqual(same, { skipped: "this slot already ran" });
		assert.equal(await m.Campaign.countDocuments({ accountId: user.accountId, seriesId: series.id }), 1);
	});

	test("the next run has only the items that are new, and with none it makes nothing and says so", async () => {
		body = feedWith(item("c", "Item C", "2026-10-21T08:00:00Z"), item("b", "Item B", "2026-10-20T08:00:00Z"), item("a", "Item A", "2026-10-19T08:00:00Z"), item("u", "Undated U"));
		const series = await makeSeries({ feedUrl: `${BLOG}?v=new`, count: 5 });
		feeds.restore();
		feeds = serveFeeds(new Map([[BLOG, () => body], [`${BLOG}?v=new`, () => body]]));
		await makeDue(series);
		await m.series.runDueSeries();
		const [first] = await m.Campaign.find({ accountId: user.accountId, seriesId: series.id }).lean();
		assert.match(first.html, /Item C[\s\S]*Item B[\s\S]*Item A[\s\S]*Undated U/);

		await makeDue(series);
		await m.series.runDueSeries();
		assert.equal(await m.Campaign.countDocuments({ accountId: user.accountId, seriesId: series.id }), 1, "nothing new, nothing made");
		const [skipped] = (await act(m, user, "list_series_runs", { id: series.id })).runs;
		assert.deepEqual([skipped.status, skipped.reason, skipped.campaignId], ["skipped", "No new items in the feed", null]);

		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=new`, () => feedWith(item("d", "Item D", "2026-10-22T08:00:00Z"), item("c", "Item C", "2026-10-21T08:00:00Z"), item("u", "Undated U"), item("v", "Undated V"))]]));
		await m.FeedCache.deleteMany({}).setOptions({ crossAccount: true });
		await makeDue(series);
		await m.series.runDueSeries();
		const made = await m.Campaign.find({ accountId: user.accountId, seriesId: series.id }).sort({ createdAt: 1 }).lean();
		assert.equal(made.length, 2);
		assert.match(made[1].html, /Item D/);
		assert.match(made[1].html, /Undated V/);
		assert.doesNotMatch(made[1].html, /Item C|Undated U/);
	});

	test("after downtime a series runs once, not once for each day it missed", async () => {
		body = readFixture("blog.rss.xml");
		const series = await makeSeries({ feedUrl: `${BLOG}?v=late` });
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=late`, () => body]]));
		await makeDue(series, new Date(Date.now() - 5 * 86_400_000));
		const result = await m.series.runDueSeries();
		assert.equal(result.ran >= 1, true);
		assert.equal((await m.SeriesRun.countDocuments({ accountId: user.accountId, seriesId: series.id })), 1);
		assert.equal((await m.series.runDueSeries()).due >= 0, true);
		assert.equal((await m.SeriesRun.countDocuments({ accountId: user.accountId, seriesId: series.id })), 1);
	});

	test("in send mode the issue goes to the list by itself", async () => {
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=send`, () => readFixture("blog.rss.xml")]]));
		const series = await makeSeries({ feedUrl: `${BLOG}?v=send`, mode: "send", count: 1, subject: "Auto: {{first_title}}" });
		await makeDue(series);
		await m.series.runDueSeries();
		await runJobs(sendRoutes(m));
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, seriesId: series.id }).lean();
		assert.equal(campaign.status, "sent");
		const [run] = (await act(m, user, "list_series_runs", { id: series.id })).runs;
		assert.equal(run.status, "sent");
		const [email] = sent.filter(({ to, subject }) => to === "reader0@series-runs.example.org" && subject === "Auto: Third post: what changed");
		assert.match(email.html, /Third post: what changed/);
	});

	test("a send that can't start leaves the draft and says why", async () => {
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=nosend`, () => readFixture("blog.rss.xml")]]));
		const series = await makeSeries({ feedUrl: `${BLOG}?v=nosend`, mode: "send" });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { postalAddressCleared: true }, $unset: { postalAddress: 1 } });
		await makeDue(series);
		await m.series.runDueSeries();
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, seriesId: series.id }).lean();
		assert.equal(campaign.status, "draft");
		const [run] = (await act(m, user, "list_series_runs", { id: series.id })).runs;
		assert.equal(run.status, "drafted");
		assert.match(run.reason, /^Not sent: /);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { postalAddress: "1 Main St" }, $unset: { postalAddressCleared: 1 } });
	});

	test("a feed that can't be read is a failed run that tries again at the next one", async () => {
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=fail`, { status: 503 }]]));
		const series = await makeSeries({ feedUrl: `${BLOG}?v=fail` });
		await makeDue(series);
		await m.series.runDueSeries();
		const [run] = (await act(m, user, "list_series_runs", { id: series.id })).runs;
		assert.deepEqual([run.status, run.reason, run.campaignId], ["failed", "The feed answered 503", null]);
		assert.equal(await m.Campaign.countDocuments({ accountId: user.accountId, seriesId: series.id }), 0);
		const next = (await act(m, user, "list_series", {})).series.find(({ id }) => id === series.id);
		assert.ok(new Date(next.nextRunAt) > new Date());
		assert.ok(platformEmails.some(({ subject }) => /couldn't make its issue/i.test(subject)));
	});

	test("an off series isn't run, and an account waiting to be deleted is skipped", async () => {
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=off`, () => readFixture("blog.rss.xml")]]));
		const series = await makeSeries({ feedUrl: `${BLOG}?v=off`, active: false });
		await m.SeriesPlan.updateOne({ accountId: user.accountId, _id: series.id }, { $set: { nextRunAt: new Date(Date.now() - 60_000) } });
		await m.series.runDueSeries();
		assert.equal(await m.SeriesRun.countDocuments({ accountId: user.accountId, seriesId: series.id }), 0);

		await m.SeriesPlan.updateOne({ accountId: user.accountId, _id: series.id }, { $set: { active: true } });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { deletion: { requestedAt: new Date(), purgeAt: new Date(Date.now() + 86_400_000) } } });
		try {
			await m.series.runDueSeries();
			const run = await m.SeriesRun.findOne({ accountId: user.accountId, seriesId: series.id }).lean();
			assert.deepEqual([run.status, run.reason], ["skipped", "The account is being deleted"]);
		} finally {
			await m.Account.updateOne({ _id: user.accountId }, { $unset: { deletion: 1 } });
		}
	});

	test("run_series makes a draft now, even in send mode, and the job's route runs the due series", async () => {
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=manual`, () => readFixture("blog.rss.xml")]]));
		const series = await makeSeries({ feedUrl: `${BLOG}?v=manual`, mode: "send", active: false });
		const run = await act(m, user, "run_series", { id: series.id });
		assert.deepEqual([run.status, run.isManual, run.itemCount], ["drafted", true, 3]);
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: run.campaignId }).lean();
		assert.equal(campaign.status, "draft");
		assert.equal((await act(m, user, "run_series", { id: series.id })).status, "skipped");

		const due = await makeSeries({ feedUrl: `${BLOG}?v=route`, name: "Route" });
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=route`, () => readFixture("blog.rss.xml")]]));
		await makeDue(due);
		const response = await m.jobRoute.POST(jsonRequest("/api/jobs/run-series", { method: "POST", body: {} }));
		assert.equal(response.status, 200);
		assert.equal((await response.json()).ran >= 1, true);
		assert.equal(await m.Campaign.countDocuments({ accountId: user.accountId, seriesId: due.id }), 1);
	});
});

describe("the dashboard", () => {
	test("makes, saves, runs and deletes a series through the server actions, and the pages list it with its runs", async () => {
		const user = await setupSender(m, "series-dashboard@example.com", { contacts: 1 });
		const actions = await import("../app/(app)/series/actions.js");
		const list = await import("../app/(app)/series/page.js");
		const detail = await import("../app/(app)/series/[id]/page.js");
		feeds.restore();
		feeds = serveFeeds(new Map([[`${BLOG}?v=ui`, () => readFixture("blog.rss.xml")]]));

		const values = { name: "Dashboard links", feedUrl: `${BLOG}?v=ui`, frequency: "weekly", days: [1, 3], hour: 7, timeZone: "UTC", mode: "draft", subject: "{{first_title}}", previewText: "", count: 2, order: "newest", image: true, excerpt: true, date: true, intro: "<p>Hello</p>", active: true };
		const bad = await as(user, () => actions.createSeries(user.newsletterId, { ...values, feedUrl: "http://example.com/feed" }));
		assert.match(bad.error, /https/);
		const created = await as(user, () => actions.createSeries(user.newsletterId, values));
		assert.equal(created.ok, true);

		const listed = renderToStaticMarkup(await as(user, () => list.default()));
		assert.match(listed, /Dashboard links/);
		assert.match(listed, /Weekly on Mondays and Wednesdays at 07:00 \(UTC\), draft for review/);
		assert.match(listed, /None yet/);

		assert.equal((await as(user, () => actions.updateSeries(created.id, { ...values, mode: "send", count: 1 }))).ok, true);
		const run = await as(user, () => actions.runSeriesNow(created.id));
		assert.equal(run.run.status, "drafted");
		const page = renderToStaticMarkup(await as(user, () => detail.default({ params: Promise.resolve({ id: created.id }) })));
		assert.match(page, /Dashboard links/);
		assert.match(page, /Run by hand/);
		assert.match(page, /Open the issue/);
		assert.match(page, /Sent automatically|Send automatically to the whole list/);

		assert.equal((await as(user, () => actions.deleteSeries(created.id))).ok, true);
		assert.doesNotMatch(renderToStaticMarkup(await as(user, () => list.default())), /Dashboard links/);
	});
});
