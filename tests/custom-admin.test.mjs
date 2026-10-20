import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as, catchNotFound, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// The admins' view of the Custom plan's requests: admin-only, newest first, status and notes to change, and the counts
// that say which feature to build first.
let app;
let m;
let admin;
let customer;
const ids = {};

const textOf = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

function request(fields) {
	return m.CustomRequest.create({ name: "Test Person", email: "person@publisher.example.com", company: "Publisher", region: "us", ...fields });
}

async function dated(doc, createdAt) {
	await m.CustomRequest.collection.updateOne({ _id: doc._id }, { $set: { createdAt, updatedAt: createdAt } });
}

before(async () => {
	app = await startTestApp({ ADMIN_EMAILS: "ops@example.com" });
	m = {
		actions: await import("../app/admin/actions.js"),
		page: await import("../app/admin/custom/page.js"),
		rules: await import("../lib/custom-rules.js"),
		CustomRequest: (await import("../models/CustomRequest.js")).default,
	};
	admin = await signIn("ops@example.com");
	customer = await signIn("customer-custom@example.com");

	const first = await request({ company: "Alpha", needs: ["sso", "soc2", "audit-logs"], subscribers: "400k-1m", platform: "beehiiv", timeline: "this-month" });
	const second = await request({ company: "Beta", needs: ["sso", "dpa-security"], subscribers: "400k-1m", message: "Line one\n\nLine two" });
	const third = await request({ company: "Gamma", needs: ["sso", "other"], otherNeed: "Per-newsletter billing", subscribers: "1m-5m", status: "contacted" });
	const fourth = await request({ company: "Delta", needs: [], subscribers: "" });
	ids.first = String(first._id);
	ids.second = String(second._id);
	ids.third = String(third._id);
	ids.fourth = String(fourth._id);
	await dated(first, new Date("2026-08-15T10:00:00Z"));
	await dated(second, new Date("2026-09-02T10:00:00Z"));
	await dated(third, new Date("2026-09-20T10:00:00Z"));
	await dated(fourth, new Date("2026-10-05T10:00:00Z"));
});

after(() => app?.stop());

describe("admin only", () => {
	test("the page and its actions answer 404 to anyone outside ADMIN_EMAILS, and change nothing", async () => {
		assert.equal(await as(customer, () => catchNotFound(m.page.default())), true);
		assert.equal(await as(customer, () => catchNotFound(m.actions.saveCustomRequest(null, form({ id: ids.first, status: "won", notes: "hacked" })))), true);
		assert.equal(await as(customer, () => catchNotFound(m.actions.removeCustomRequest(ids.first))), true);
		const untouched = await m.CustomRequest.findById(ids.first).lean();
		assert.equal(untouched.status, "new");
		assert.equal(untouched.notes, undefined);
	});

	test("signed-out visitors get the same 404", async () => {
		const anonymous = { jar: new Map(), ip: "203.0.113.200" };
		assert.equal(await as(anonymous, () => catchNotFound(m.page.default())), true);
		assert.equal(await as(anonymous, () => catchNotFound(m.actions.removeCustomRequest(ids.first))), true);
	});

	test("a self-hosted server has no such page", async () => {
		await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => assert.equal(await as(admin, () => catchNotFound(m.page.default())), true));
	});
});

describe("the tally", () => {
	test("counts the requests that ticked each need, by subscriber range and by month", async () => {
		const tally = m.rules.tallyCustomRequests(await m.CustomRequest.find({}).lean());
		assert.equal(tally.total, 4);
		const needs = Object.fromEntries(tally.needs.map(({ id, count }) => [id, count]));
		assert.equal(needs.sso, 3);
		assert.deepEqual([needs.soc2, needs["audit-logs"], needs["dpa-security"], needs.other, needs.scim, needs.sla], [1, 1, 1, 1, 0, 0]);
		assert.equal(tally.needs[0].id, "sso", "the most asked for first");
		assert.equal(tally.needs.length, 14, "every need is listed, ticked or not");

		const subscribers = Object.fromEntries(tally.subscribers.map(({ id, count }) => [id, count]));
		assert.deepEqual([subscribers["400k-1m"], subscribers["1m-5m"], subscribers["100k-400k"], subscribers.unknown], [2, 1, 0, 1]);
		assert.deepEqual(tally.months, [
			{ month: "2026-08", count: 1 },
			{ month: "2026-09", count: 2 },
			{ month: "2026-10", count: 1 },
		]);
	});

	test("a need ticked twice in one request counts once, and an unknown need is ignored", () => {
		const tally = m.rules.tallyCustomRequests([{ needs: ["sso", "sso", "made-up"], subscribers: "weird", createdAt: new Date("2026-10-01T00:00:00Z") }]);
		assert.equal(tally.needs.find(({ id }) => id === "sso").count, 1);
		assert.equal(tally.needs.some(({ id }) => id === "made-up"), false);
		assert.equal(tally.subscribers.find(({ id }) => id === "unknown").count, 1);
	});
});

describe("the page", () => {
	test("lists the requests newest first, with the tally above them", async () => {
		const html = renderToStaticMarkup(await as(admin, () => m.page.default()));
		const text = textOf(html);
		const order = ["Delta", "Gamma", "Beta", "Alpha"].map((company) => html.indexOf(`<h3 class="truncate font-semibold">${company}</h3>`));
		assert.ok(order.every((position) => position > 0), "all four are there");
		assert.deepEqual([...order].sort((a, b) => a - b), order, "newest first");

		assert.ok(text.indexOf("What people would need") < text.indexOf("Requests, newest first"));
		const needs = /data-tally="needs"[\s\S]*?data-tally="subscribers"/.exec(html)[0];
		assert.match(textOf(needs), /SSO\/SAML 3 SOC 2 report 1|SSO\/SAML 3/);
		assert.match(textOf(html), /Sep 2026 2/);
		assert.match(textOf(html), /Requests by subscribers/);
		assert.ok(text.includes("Per-newsletter billing"), "the free-text need");
		assert.ok(text.includes("Line one") && text.includes("Line two"), "the message");
		assert.match(html, /href="mailto:person@publisher\.example\.com"/);
	});
});

describe("changing a request", () => {
	test("saves a status and notes, and the change counts as the request's last", async () => {
		const before = (await m.CustomRequest.findById(ids.second).lean()).updatedAt;
		const result = await as(admin, () => m.actions.saveCustomRequest(null, form({ id: ids.second, status: "contacted", notes: "  Called on Tuesday.\r\n\r\n\r\n\r\nSend the migration plan.  " })));
		assert.equal(result.ok, true);
		const saved = await m.CustomRequest.findById(ids.second).lean();
		assert.equal(saved.status, "contacted");
		assert.equal(saved.notes, "Called on Tuesday.\n\nSend the migration plan.");
		assert.ok(saved.updatedAt > before, "so the two years start from here");
		assert.equal(saved.company, "Beta");
	});

	test("refuses a status that isn't one, an unknown request and a made-up id", async () => {
		assert.deepEqual(await as(admin, () => m.actions.saveCustomRequest(null, form({ id: ids.second, status: "ghosted" }))), { error: "Pick a status" });
		assert.deepEqual(await as(admin, () => m.actions.saveCustomRequest(null, form({ id: "6a0000000000000000000009", status: "won" }))), { error: "Request not found" });
		assert.deepEqual(await as(admin, () => m.actions.saveCustomRequest(null, form({ id: "nope", status: "won" }))), { error: "Request not found" });
		assert.equal((await m.CustomRequest.findById(ids.second).lean()).status, "contacted");
	});

	test("caps the notes", async () => {
		await as(admin, () => m.actions.saveCustomRequest(null, form({ id: ids.first, status: "won", notes: "n".repeat(9000) })));
		assert.equal((await m.CustomRequest.findById(ids.first).lean()).notes.length, 4000);
	});

	test("a request is deleted on the admin's word, and only that one", async () => {
		assert.deepEqual(await as(admin, () => m.actions.removeCustomRequest(ids.fourth)), { ok: true });
		assert.equal(await m.CustomRequest.findById(ids.fourth).lean(), null);
		assert.ok(await m.CustomRequest.findById(ids.third).lean());
		assert.deepEqual(await as(admin, () => m.actions.removeCustomRequest(ids.fourth)), { error: "Request not found" });
		assert.deepEqual(await as(admin, () => m.actions.removeCustomRequest("nope")), { error: "Request not found" });
	});
});
