import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { findScans, openMigrated } from "../scripts/explain-queries.mjs";
import { activate, as, callApi, catchRedirect, form, mockPolar, signIn, startTestApp } from "./helpers/app.mjs";

// What three REST reads ask of the database and of Polar, counted like tests/query-budget.test.mjs counts the dashboard's pages. The live smoke
// test (scripts/smoke-live.mjs) found GET /billing at 3.8 s, GET /reader-settings at 1.15 s and GET /newsletters at 1.3 s on the US Worker:
// the newsletters list read every contact of every newsletter, whole, to count the active ones, and get_billing waited for its reads one
// after the other, the call to Polar among them. A budget here is what the call costs now with a little room.
let app;
let m;
let driver;
let user;
const log = [];
const polarCalls = [];

const PLANS = ["starter", "growth", "pro", "scale", "max"];
const product = (planId, interval, amount) => ({
	id: `prod_${planId}_${interval}`,
	is_archived: false,
	recurring_interval: interval,
	recurring_interval_count: 1,
	prices: [{ amount_type: "fixed", price_amount: amount, price_currency: "usd", is_archived: false }],
	metadata: { flockstack_plan: planId, interval },
});

before(async () => {
	app = await startTestApp({ POLAR_ACCESS_TOKEN: "polar_oat_test" });
	const helpers = await import("./helpers/app.mjs");
	const plans = await import("../lib/plans.js");
	driver = await import("../lib/docdb/driver.js");
	m = {
		...helpers,
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
	};
	mockPolar(async ({ method, path }) => {
		polarCalls.push({ method, path, dbBefore: log.length, contactCountsBefore: log.filter(isContactCount).length });
		if (method === "GET" && path === "/v1/products/") {
			const items = PLANS.flatMap((planId) => ["month", "year"].map((interval) => product(planId, interval, plans.getPrice(plans.getPlan(planId), interval) * 100)));
			items.push({
				id: "prod_ip_month",
				is_archived: false,
				recurring_interval: "month",
				recurring_interval_count: 1,
				prices: [{ amount_type: "fixed", price_amount: plans.DEDICATED_IP_PRICE * 100, price_currency: "usd", is_archived: false }],
				metadata: { interval: "month", flockstack_addon: "dedicated_ip" },
			});
			return { items, pagination: { total_count: items.length, max_page: 1 } };
		}
		return { status: 404, error: `No mock for ${method} ${path}` };
	});
	driver.setDriver(driver.coalescingDriver(await driver.getDriver()));
	user = await signIn("api-budget@example.com");
	await activate(user, { plan: "pro" });
	const slugs = ["budget-one", "budget-two", "budget-three"];
	const ids = [];
	for (const slug of slugs) {
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris" }))));
		ids.push(url.split("/").at(-1));
	}
	user.newsletterId = ids[0];
	await as(user, () => m.contacts.importContacts({ newsletterId: ids[0], consent: true, rows: Array.from({ length: 300 }, (_, index) => ({ email: `reader${index}@example.org`, status: "active" })) }));
	await as(user, () => m.contacts.importContacts({ newsletterId: ids[1], consent: true, rows: Array.from({ length: 40 }, (_, index) => ({ email: `other${index}@example.org`, status: index < 25 ? "active" : "unsubscribed" })) }));
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Budget", level: "full" })))).key;
	driver.setQueryObserver((event) => log.push(event));
});

after(async () => {
	driver?.setQueryObserver(null);
	await app?.stop();
});

const isContactCount = ({ sql, list }) => (list ?? [{ sql }]).some((statement) => /SELECT COUNT\(\*\)[^]*FROM c_contacts/i.test(statement.sql));

async function read(path) {
	log.length = 0;
	polarCalls.length = 0;
	const response = await callApi("GET", path, { key: user.key });
	assert.equal(response.status, 200, JSON.stringify(response.body));
	const trips = log.filter(({ sql }) => !/^\s*(CREATE|PRAGMA)/i.test(sql));
	const calls = trips.flatMap((event) => (event.list ? event.list.map(({ sql, params }) => ({ sql, params })) : [{ sql: event.sql, params: event.params }]));
	return { body: response.body, calls, statements: calls.length, roundTrips: trips.length, rows: trips.reduce((total, { rows }) => total + rows, 0) };
}

// How many round trips, statements and rows each read may take. Seven or eight round trips of each are the key, its account, the rate limit,
// the daily count and the activity record that every call to the API makes before and after its action (lib/api/rest.js, lib/agent-guard.js).
const BUDGETS = {
	newsletters: { roundTrips: 11, statements: 16, rows: 20 },
	reader_settings: { roundTrips: 9, statements: 10, rows: 10 },
	billing: { roundTrips: 10, statements: 13, rows: 10 },
};

describe("GET /api/v1/newsletters", () => {
	test("counts the active contacts of each newsletter in the database, without reading the contacts", async () => {
		const { body, calls, roundTrips, statements, rows } = await read("/api/v1/newsletters");
		assert.deepEqual(body.newsletters.map(({ slug, activeContacts }) => [slug, activeContacts]), [["budget-one", 300], ["budget-two", 25], ["budget-three", 0]]);
		assert.ok(rows <= BUDGETS.newsletters.rows, `read ${rows} rows (budget ${BUDGETS.newsletters.rows}): 365 contacts exist, none is read to be counted`);
		assert.ok(roundTrips <= BUDGETS.newsletters.roundTrips, `${roundTrips} round trips (budget ${BUDGETS.newsletters.roundTrips})`);
		assert.ok(statements <= BUDGETS.newsletters.statements, `${statements} statements (budget ${BUDGETS.newsletters.statements}): ${calls.map(({ sql }) => sql.replace(/\s+/g, " ").slice(0, 80)).join("\n  ")}`);
		// The cleanup totals read the contacts that were ever sent a last chance (none here); every other read of a contact is a count.
		const wholeContacts = calls.filter(({ sql }) => /^SELECT (c_contacts\.)?data FROM c_contacts/i.test(sql) && !/lastChanceAt/.test(sql));
		assert.deepEqual(wholeContacts.map(({ sql }) => sql.slice(0, 100)), [], "no contact is read whole to be counted");
	});

	test("the statements it ran do not read a table whole", async () => {
		const { calls } = await read("/api/v1/newsletters");
		const db = openMigrated();
		const scans = calls.flatMap(({ sql, params }) => findScans(db, sql, params ?? []).scans.map((line) => `${line}: ${sql.replace(/\s+/g, " ").slice(0, 100)}`));
		assert.deepEqual(scans, []);
	});
});

describe("GET /api/v1/reader-settings", () => {
	test("is one newsletter read and stays inside its budget", async () => {
		const { body, roundTrips, statements, rows } = await read("/api/v1/reader-settings");
		assert.equal(body.language, "en");
		assert.ok(roundTrips <= BUDGETS.reader_settings.roundTrips, `${roundTrips} round trips (budget ${BUDGETS.reader_settings.roundTrips})`);
		assert.ok(statements <= BUDGETS.reader_settings.statements, `${statements} statements (budget ${BUDGETS.reader_settings.statements})`);
		assert.ok(rows <= BUDGETS.reader_settings.rows, `${rows} rows (budget ${BUDGETS.reader_settings.rows})`);
	});
});

describe("GET /api/v1/billing", () => {
	test("asks Polar for its products once, for the plans and the add-on together, and starts that call with the database reads, not after them", async () => {
		const { body, roundTrips, statements, rows } = await read("/api/v1/billing");
		assert.deepEqual(body.plans.map(({ id }) => id), PLANS);
		assert.equal(body.dedicatedIp.available, true, "the add-on is on sale");
		assert.deepEqual(polarCalls.map(({ method, path }) => `${method} ${path}`), ["GET /v1/products/"], "one call to Polar");
		assert.equal(polarCalls[0].contactCountsBefore, 0, "Polar was asked before the subscribers were counted: the reads start together");
		assert.ok(roundTrips <= BUDGETS.billing.roundTrips, `${roundTrips} round trips (budget ${BUDGETS.billing.roundTrips})`);
		assert.ok(statements <= BUDGETS.billing.statements, `${statements} statements (budget ${BUDGETS.billing.statements})`);
		assert.ok(rows <= BUDGETS.billing.rows, `${rows} rows (budget ${BUDGETS.billing.rows})`);
	});

	test("the products are kept for the next read", async () => {
		await read("/api/v1/billing");
		assert.deepEqual(polarCalls, [], "no second call to Polar within the cache's time");
	});
});

// Polar's product list, as get_billing reads it. The organization is shared, so the catalog can be several pages of other products. The
// clock is moved on between tests so each starts without the last one's list (it is kept for ten minutes).
describe("Polar's product list", () => {
	const PAGE = 100;
	let epoch = 0;
	let polar;
	const other = (index) => ({ id: `prod_other_${index}`, is_archived: false, recurring_interval: "month", recurring_interval_count: 1, prices: [], metadata: { app: "something else" } });
	const flockstack = async () => {
		const plans = await import("../lib/plans.js");
		const items = PLANS.flatMap((planId) => ["month", "year"].map((interval) => product(planId, interval, plans.getPrice(plans.getPlan(planId), interval) * 100)));
		items.push({ id: "prod_ip_month", is_archived: false, recurring_interval: "month", recurring_interval_count: 1, prices: [{ amount_type: "fixed", price_amount: plans.DEDICATED_IP_PRICE * 100, price_currency: "usd", is_archived: false }], metadata: { interval: "month", flockstack_addon: "dedicated_ip" } });
		return items;
	};
	const tick = (t) => t.mock.timers.enable({ apis: ["Date"], now: Date.now() + ++epoch * 12 * 60_000 });

	before(async () => {
		polar = await import("../lib/polar.js");
	});

	test("the first page says how many there are and the others are asked for together, then taken in order", async (t) => {
		tick(t);
		const items = await flockstack();
		const pages = { 1: Array.from({ length: PAGE }, (_, index) => other(index)), 2: items.slice(0, 6), 3: items.slice(6) };
		const started = [];
		let inFlight = 0;
		let peak = 0;
		let release;
		const twoUnderWay = new Promise((resolve) => (release = resolve));
		mockPolar(async ({ query }) => {
			const page = Number(query.get("page"));
			started.push(page);
			if (page > 1) {
				peak = Math.max(peak, ++inFlight);
				if (inFlight === 2) release();
				// Served one after the other, the second page would never be asked for while the first waits.
				await Promise.race([twoUnderWay, new Promise((resolve) => setTimeout(resolve, 400))]);
				inFlight--;
			}
			return { items: pages[page], pagination: { total_count: 211, max_page: 3 } };
		});
		const onSale = await polar.findPlansOnSale();
		assert.deepEqual(onSale.map(({ id }) => id), PLANS, "every plan is on sale, found on pages 2 and 3");
		assert.equal(started[0], 1, "the first page first");
		assert.deepEqual(started.slice().sort(), [1, 2, 3], "each page once");
		assert.equal(peak, 2, "pages 2 and 3 were under way at the same time");
		assert.equal(await polar.isDedicatedIpOnSale(), true, "and the add-on comes from the same list");
		assert.equal(started.length, 3, "without asking again");
	});

	test("a first page that already has every plan's product and the add-on is the only page asked for", async (t) => {
		tick(t);
		const asked = [];
		mockPolar(async ({ query }) => {
			asked.push(Number(query.get("page")));
			return { items: await flockstack(), pagination: { total_count: 900, max_page: 9 } };
		});
		assert.equal((await polar.findPlansOnSale()).length, PLANS.length);
		assert.deepEqual(asked, [1]);
	});

	test("the plans and the add-on asked for together make one set of requests; a failure is not asked again for a minute", async (t) => {
		tick(t);
		t.mock.method(console, "error", () => {});
		const asked = [];
		mockPolar(async ({ query }) => {
			asked.push(Number(query.get("page")));
			return { status: 500, error: "Polar is down" };
		});
		const [plans, addOn] = await Promise.all([polar.findPlansOnSale(), polar.isDedicatedIpOnSale()]);
		assert.equal(plans.length, PLANS.length, "every plan shows while Polar cannot be read");
		assert.equal(addOn, false);
		assert.deepEqual(asked, [1], "one request for both");
		assert.equal(await polar.isDedicatedIpOnSale(), false);
		assert.equal((await polar.findPlansOnSale()).length, PLANS.length);
		assert.deepEqual(asked, [1], "and none for the minute after");
	});
});
