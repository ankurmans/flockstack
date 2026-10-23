import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { findScans, openMigrated } from "../scripts/explain-queries.mjs";

// What the dashboard's busiest pages and the send path ask of the database, counted: every call to the driver is a round trip to D1
// (a Worker waits on each, and a page waits on a chain of them), so a page that quietly grows from 14 to 40 is slower for everybody and
// bills more rows. The budgets are what each page costs now with a little room; a page that needs more has to say why here.
// The statements are also asked of SQLite, on a database built from the migrations as D1's is, which must not read a table whole.
let app;
let m;
let user;
let driver;
const log = [];

before(async () => {
	// React.cache only dedupes inside a server render; these renders share one memo, as a request would.
	const react = createRequire(import.meta.url)("react");
	let epoch = 0;
	react.cache = (fn) => {
		const memo = new Map();
		return (...args) => {
			const key = `${epoch}:${JSON.stringify(args)}`;
			if (!memo.has(key)) memo.set(key, fn(...args));
			return memo.get(key);
		};
	};
	m = { bump: () => ++epoch };
	const helpers = await import("./helpers/app.mjs");
	app = await helpers.startTestApp();
	Object.assign(m, {
		...helpers,
		render: (await import("react-dom/server")).renderToReadableStream,
		createElement: react.createElement,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Layout: (await import("../app/(app)/layout.js")).default,
		driver: await import("../lib/docdb/driver.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		Campaign: (await import("../models/Campaign.js")).default,
	});
	driver = m.driver;
	// D1 answers what a page asks in one turn as one batch (coalescingDriver): that is how production runs, so that is what is counted.
	driver.setDriver(driver.coalescingDriver(await driver.getDriver()));
	user = await m.signIn("budget@example.com");
	await m.activate(user);
	const url = await m.as(user, () => m.catchRedirect(m.newsletters.saveNewsletter(null, m.form({ name: "Budget news", slug: "budget-news", postalAddress: "1 Main St, Paris" }))));
	user.newsletterId = url.split("/").at(-1);
	await m.as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows: Array.from({ length: 300 }, (_, index) => ({ email: `reader${index}@example.org`, status: "active" })) }));
	// Issues with a body each: a list of them must not read the bodies.
	for (let index = 0; index < 30; index++) {
		await m.Campaign.create({
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			subject: `Issue ${index}`,
			status: index < 24 ? "sent" : "draft",
			sentAt: index < 24 ? new Date(Date.now() - index * 86_400_000) : undefined,
			stats: { recipients: 300, sent: 300 },
			html: `<p>${"body ".repeat(4000)}</p>`,
		});
	}
	driver.setQueryObserver((event) => log.push(event));
});

after(async () => {
	driver?.setQueryObserver(null);
	await app?.stop();
});

// Renders a page inside the dashboard's layout, as a signed-in visit, and returns what it asked the database.
async function visit(load, props = {}) {
	log.length = 0;
	m.bump();
	await m.as(user, async () => {
		const page = m.createElement((await load()).default, { searchParams: Promise.resolve({}), params: Promise.resolve({}), ...props });
		const stream = await m.render(m.createElement(m.TooltipProvider, null, m.createElement(m.Layout, null, page)), {
			onError: (error) => assert.fail(`the page failed to render: ${error?.message}`),
		});
		await stream.allReady;
		await new Response(stream).text();
	});
	// A round trip is a call to the driver; the statements are what it carried.
	const trips = log.filter(({ sql }) => !/^\s*(CREATE|PRAGMA)/i.test(sql));
	const calls = trips.flatMap((event) => (event.list ? event.list.map(({ sql, params }) => ({ sql, params })) : [{ sql: event.sql, params: event.params }]));
	return { calls, statements: calls.length, roundTrips: trips.length, rows: trips.reduce((total, { rows }) => total + rows, 0) };
}

// page: how many round trips (calls to the database, which the Worker waits on), statements (what they carry) and rows it may take.
// Round trips were 22, 15, 22, 19 and 13 before the reads of a turn went to D1 as one batch (lib/docdb/driver.js coalescingDriver).
const BUDGETS = {
	// The overview reads a row for each signup of the last 60 days (the subscriber chart groups them by day in the Worker): 300 here.
	overview: { roundTrips: 7, statements: 26, rows: 400 },
	campaigns: { roundTrips: 7, statements: 18, rows: 60 },
	// A page of 50 contacts, and the rows every dashboard page reads.
	contacts: { roundTrips: 7, statements: 25, rows: 80 },
	reports: { roundTrips: 7, statements: 22, rows: 30 },
	segments: { roundTrips: 5, statements: 16, rows: 30 },
};
const PAGES = {
	overview: () => import("../app/(app)/(overview)/page.js"),
	campaigns: () => import("../app/(app)/campaigns/(list)/page.js"),
	contacts: () => import("../app/(app)/contacts/page.js"),
	reports: () => import("../app/(app)/reports/page.js"),
	segments: () => import("../app/(app)/segments/page.js"),
};

describe("the dashboard's pages", () => {
	const seen = new Map();

	for (const [name, load] of Object.entries(PAGES)) {
		test(`${name} stays inside its budget of ${BUDGETS[name].roundTrips} round trips, ${BUDGETS[name].statements} statements and ${BUDGETS[name].rows} rows`, async () => {
			const { calls, roundTrips, statements, rows } = await visit(load);
			for (const { sql, params } of calls) seen.set(sql, params);
			assert.ok(roundTrips <= BUDGETS[name].roundTrips, `${name} made ${roundTrips} round trips (budget ${BUDGETS[name].roundTrips}): ${calls.map(({ sql }) => sql.replace(/\s+/g, " ").slice(0, 70)).join("\n  ")}`);
			assert.ok(statements <= BUDGETS[name].statements, `${name} ran ${statements} statements (budget ${BUDGETS[name].statements})`);
			assert.ok(rows <= BUDGETS[name].rows, `${name} read ${rows} rows (budget ${BUDGETS[name].rows})`);
		});
	}

	test("a user and an account are each read once per visit, and a session twice: Better Auth's, and the one that finds the account beside it", async () => {
		const { calls } = await visit(PAGES.campaigns);
		const reads = (table) => calls.filter(({ sql }) => new RegExp(`FROM ${table}\\b`).test(sql) && !/COUNT/.test(sql) && /WHERE (json_extract\(data, '\$\.token'\)|_id|json_extract\(data, '\$\.ownerId'\))/.test(sql)).length;
		assert.equal(reads("c_users"), 1);
		assert.equal(reads("c_accounts"), 1);
		assert.equal(calls.filter(({ sql }) => /FROM c_sessions\b/.test(sql)).length, 2);
	});

	test("the reads a page asks together go to the database together: far fewer round trips than statements", async () => {
		const { roundTrips, statements } = await visit(PAGES.overview);
		assert.ok(statements >= roundTrips * 3, `${statements} statements in ${roundTrips} round trips`);
	});

	test("a list of campaigns reads the fields it shows, not their bodies", async () => {
		const { calls } = await visit(PAGES.overview);
		const listings = calls.filter(({ sql }) => /FROM c_campaigns/.test(sql) && /newsletterId/.test(sql));
		assert.ok(listings.length > 0);
		const whole = listings.filter(({ sql }) => /^SELECT data FROM c_campaigns WHERE accountId = \? AND json_extract\(data, '\$\.newsletterId'\) = \?/.test(sql));
		assert.deepEqual(whole.map(({ sql }) => sql.slice(0, 90)), [], "no page reads every campaign whole");
	});

	test("none of the statements the pages ran reads a table whole", () => {
		const db = openMigrated();
		const scans = [];
		for (const [sql, params] of seen) {
			const found = findScans(db, sql, params ?? []);
			for (const line of found.scans) scans.push(`${line}: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
		}
		assert.deepEqual(scans, []);
	});
});
