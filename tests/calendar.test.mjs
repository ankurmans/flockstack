import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// The content calendar: a month's scheduled and sent issues by local day, from the action and on the page.
let t;
let m;
let n = 0;

before(async () => {
	t = await setupAudienceTests();
	m = { calendar: await import("../lib/calendar.js") };
});

after(() => t?.app.stop());

const customer = () => t.customer(`calendar${++n}@example.com`);

function addIssue(user, fields) {
	return t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Issue", ...fields });
}

const calendar = async (user, query) => (await t.api(user.key, "GET", `/calendar${query}`)).body;
const subjects = (body) => body.issues.map(({ subject }) => subject);

describe("the month's days", () => {
	test("run Monday to Sunday over whole weeks, and months step across years", () => {
		assert.deepEqual(m.calendar.getMonthGrid("2026-10"), { first: "2026-10-01", lastDay: "2026-10-31", start: "2026-09-28", end: "2026-11-01" });
		assert.deepEqual(m.calendar.getMonthGrid("2026-02"), { first: "2026-02-01", lastDay: "2026-02-28", start: "2026-01-26", end: "2026-03-01" }, "a month that fits four weeks exactly");
		assert.equal(m.calendar.shiftMonthKey("2026-12", 1), "2027-01");
		assert.equal(m.calendar.shiftMonthKey("2026-01", -1), "2025-12");
		assert.equal(m.calendar.isMonthKey("2026-13"), false);
		assert.equal(m.calendar.isMonthKey("2026-1"), false);
		assert.equal(m.calendar.isMonthKey("2026-10"), true);
	});
});

describe("get_content_calendar", () => {
	test("lists scheduled issues on the day they go out and sent ones on the day they went, drafts and other months left out", async () => {
		const user = await customer();
		await addIssue(user, { subject: "Scheduled for the 12th", status: "scheduled", scheduledAt: new Date("2026-11-12T09:00:00Z") });
		await addIssue(user, { subject: "Sent on the 3rd", status: "sent", startedAt: new Date("2026-11-03T08:00:00Z"), sentAt: new Date("2026-11-03T08:05:00Z"), stats: { recipients: 120 } });
		await addIssue(user, { subject: "Imported on the 20th", status: "sent", sentAt: new Date("2026-11-20T12:00:00Z") });
		await addIssue(user, { subject: "Sending on the 5th", status: "sending", startedAt: new Date("2026-11-05T07:00:00Z") });
		await addIssue(user, { subject: "A draft", status: "draft" });
		await addIssue(user, { subject: "Discarded", status: "canceled", scheduledAt: new Date("2026-11-14T09:00:00Z") });
		await addIssue(user, { subject: "In October", status: "sent", sentAt: new Date("2026-10-31T10:00:00Z") });
		await addIssue(user, { subject: "In December", status: "scheduled", scheduledAt: new Date("2026-12-01T10:00:00Z") });

		const november = await calendar(user, "?month=2026-11");
		assert.equal(november.month, "2026-11");
		assert.deepEqual(subjects(november), ["Sent on the 3rd", "Sending on the 5th", "Scheduled for the 12th", "Imported on the 20th"], "in time order");
		assert.deepEqual(november.issues.map(({ date }) => date), ["2026-11-03", "2026-11-05", "2026-11-12", "2026-11-20"]);
		assert.equal(november.issues[0].recipients, 120);
		assert.equal(november.issues[2].status, "scheduled");
		assert.deepEqual(subjects(await calendar(user, "?month=2026-10")), ["In October"]);
		assert.deepEqual(subjects(await calendar(user, "?month=2026-12")), ["In December"]);
		assert.deepEqual(subjects(await calendar(user, "?month=2027-03")), []);
	});

	test("puts an issue on its day in the timezone asked", async () => {
		const user = await customer();
		await addIssue(user, { subject: "Late on the 31st", status: "sent", sentAt: new Date("2026-10-31T23:30:00Z") });
		assert.deepEqual((await calendar(user, "?month=2026-10")).issues.map(({ date }) => date), ["2026-10-31"]);
		assert.deepEqual(subjects(await calendar(user, "?month=2026-10&timeZone=Europe/Paris")), [], "already November 1 in Paris");
		const paris = await calendar(user, "?month=2026-11&timeZone=Europe/Paris");
		assert.deepEqual(paris.issues.map(({ date }) => date), ["2026-11-01"]);
		assert.equal(paris.timeZone, "Europe/Paris");
		assert.equal((await calendar(user, "?month=2026-11&timeZone=Not/AZone")).timeZone, "UTC", "an unknown zone is UTC");
	});

	test("stays inside the account and can be narrowed to a newsletter", async () => {
		const user = await customer();
		const other = await customer();
		await addIssue(user, { subject: "Mine", status: "scheduled", scheduledAt: new Date("2026-11-12T09:00:00Z") });
		await t.m.Campaign.create({ accountId: other.accountId, newsletterId: other.newsletterId, subject: "Theirs", status: "scheduled", scheduledAt: new Date("2026-11-12T09:00:00Z") });
		assert.deepEqual(subjects(await calendar(user, "?month=2026-11")), ["Mine"]);

		const second = await t.api(user.key, "POST", "/newsletters", { name: "Second", slug: `${user.slug}-two`, postalAddress: "1 Main St, Paris" });
		assert.equal(second.status, 201, JSON.stringify(second.body));
		await t.m.Campaign.create({ accountId: user.accountId, newsletterId: second.body.id, subject: "On the second", status: "scheduled", scheduledAt: new Date("2026-11-13T09:00:00Z") });
		assert.deepEqual(subjects(await calendar(user, "?month=2026-11")), ["Mine", "On the second"]);
		assert.deepEqual(subjects(await calendar(user, `?month=2026-11&newsletter=${user.slug}`)), ["Mine"]);
		assert.deepEqual(subjects(await calendar(user, `?month=2026-11&newsletter=${user.slug}-two`)), ["On the second"]);
		t.assertError(await t.api(user.key, "GET", "/calendar?month=2026-11&newsletter=nope"), 404, "not_found");
		t.assertError(await t.api(user.key, "GET", "/calendar?month=November"), 400, "validation_failed");
	});
});

describe("the page", () => {
	test("shows the month's issues in their days, links to each and steps between months", async () => {
		const user = await customer();
		await addIssue(user, { subject: "Planned launch", status: "scheduled", scheduledAt: new Date("2026-11-12T09:00:00Z") });
		const sent = await addIssue(user, { subject: "Already out", status: "sent", sentAt: new Date("2026-11-03T08:00:00Z") });
		const page = (await import("../app/(app)/campaigns/calendar/page.js")).default;
		const html = renderToStaticMarkup(await as(user, () => page({ searchParams: Promise.resolve({ month: "2026-11" }) })));
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

		assert.match(text, /November 2026/);
		assert.match(text, /Planned launch/);
		assert.match(text, /Already out/);
		assert.match(text, /2 issues this month/);
		assert.ok(html.includes(`href="/campaigns/${sent._id}"`));
		assert.ok(html.includes('href="/campaigns/calendar?month=2026-10"') && html.includes('href="/campaigns/calendar?month=2026-12"'));
		assert.equal((html.match(/<ol[^>]*aria-label="November 2026, by day"/g) ?? []).length, 1);
		assert.match(renderToStaticMarkup(await as(user, () => page({ searchParams: Promise.resolve({ month: "2027-02" }) }))), /Nothing scheduled or sent in February 2027/);
	});
});
