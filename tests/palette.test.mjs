import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { anonymous, as } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { ADMIN_PAGE, AUDIO_PAGE, BILLING_PAGE, PAGES, buildSections, filterItems, isPaletteShortcut, moveIndex, scoreMatch } from "../lib/palette.js";

// The command palette: what it lists for a query, the shortcut, and the search behind it.
let t;
let n = 0;

before(async () => {
	t = await setupAudienceTests();
});

after(() => t?.app.stop());

const customer = () => t.customer(`palette${++n}@example.com`);

function search(user, q, headers = {}) {
	return import("../app/api/palette/route.js").then(({ GET }) => {
		const request = new Request(`http://localhost:3000/api/palette?q=${encodeURIComponent(q)}`, { headers });
		return user ? as(user, () => GET(request)) : anonymous(() => GET(request));
	});
}

describe("the pages", () => {
	test("are the sidebar's, so the palette goes everywhere the menu does", async () => {
		const nav = await readFile(new URL("../components/NavLinks.jsx", import.meta.url), "utf8");
		const hrefs = [...nav.matchAll(/href: "([^"]+)", label:/g)].map(([, href]) => href).filter((href) => href !== ADMIN_PAGE.href);
		const pages = [...PAGES, AUDIO_PAGE];
		assert.ok(hrefs.length >= 15);
		for (const href of hrefs) assert.ok(pages.some((page) => page.href === href), `${href} is in the palette`);
		assert.equal(new Set(PAGES.map(({ href }) => href)).size, PAGES.length);
		assert.equal(BILLING_PAGE.href, "/billing");
	});
});

describe("matching", () => {
	test("ranks a name's start over its middle over the words people also use, and needs every word", () => {
		assert.equal(scoreMatch("", { label: "Contacts" }), 1, "no query matches everything");
		assert.ok(scoreMatch("con", { label: "Contacts" }) > scoreMatch("tac", { label: "Contacts" }));
		assert.ok(scoreMatch("keys", { label: "API keys" }) > scoreMatch("token", { label: "API keys", keywords: "token mcp" }));
		assert.ok(scoreMatch("token", { label: "API keys", keywords: "token mcp" }) > 0);
		assert.equal(scoreMatch("zzz", { label: "Contacts", keywords: "subscribers" }), 0);
		assert.equal(scoreMatch("api zzz", { label: "API keys" }), 0, "every word has to match");
		assert.ok(scoreMatch("api keys", { label: "API keys" }) > scoreMatch("api", { label: "API keys" }));
	});

	test("finds pages by their names and by other words for them, best first", () => {
		const labels = (query) => filterItems(query, PAGES).map(({ label }) => label);
		assert.equal(labels("cam")[0], "Campaigns");
		assert.deepEqual(labels("subscribers").slice(0, 1), ["Contacts"]);
		assert.ok(labels("calendar").includes("Calendar"));
		assert.equal(labels("media")[0], "Media");
		assert.deepEqual(labels("nonsense"), []);
		assert.equal(labels("").length, PAGES.length);
	});

	test("lists actions, pages, then what the server found, leaving empty sections out", () => {
		const found = {
			campaigns: [{ id: "c1", subject: "Launch week", status: "sent" }, { id: "c2", subject: "", status: "draft" }],
			contacts: [{ id: "p1", email: "jane+news@example.com", status: "active" }],
		};
		const sections = buildSections("med", { pages: PAGES, canCreate: true, found });
		assert.deepEqual(sections.map(({ title }) => title), ["Pages", "Issues", "Contacts"], "med matches no action");
		assert.deepEqual(sections[1].items.map(({ label, href }) => [label, href]), [["Launch week", "/campaigns/c1"], ["Untitled", "/campaigns/c2"]]);
		assert.equal(sections[2].items[0].href, "/contacts?q=jane%2Bnews%40example.com", "the address is encoded");

		const all = buildSections("", { pages: PAGES, canCreate: true });
		assert.deepEqual(all.map(({ title }) => title), ["Actions", "Pages"]);
		assert.equal(all[0].items[0].kind, "new-issue");
		assert.ok(!buildSections("new", { pages: PAGES, canCreate: false }).some(({ title }) => title === "Actions"), "no new issue without a newsletter");
		assert.deepEqual(buildSections("write", { pages: PAGES, canCreate: true }).map(({ title }) => title), ["Actions"], "write is another word for it");
	});

	test("moves the highlighted item round the list", () => {
		assert.equal(moveIndex(0, 3, -1), 2);
		assert.equal(moveIndex(2, 3, 1), 0);
		assert.equal(moveIndex(1, 3, 1), 2);
		assert.equal(moveIndex(0, 0, 1), 0);
	});
});

describe("the shortcut", () => {
	test("is Cmd+K or Ctrl+K, and leaves a press the editor used for a link alone", () => {
		assert.equal(isPaletteShortcut({ key: "k", metaKey: true }), true);
		assert.equal(isPaletteShortcut({ key: "K", ctrlKey: true }), true);
		assert.equal(isPaletteShortcut({ key: "k" }), false);
		assert.equal(isPaletteShortcut({ key: "k", metaKey: true, shiftKey: true }), false);
		assert.equal(isPaletteShortcut({ key: "j", metaKey: true }), false);
		assert.equal(isPaletteShortcut({ key: "k", metaKey: true, defaultPrevented: true }), false);
	});
});

describe("the search", () => {
	test("finds the account's issues by subject and the open newsletter's contacts by address", async () => {
		const user = await customer();
		await t.draft(user, { subject: "Launch week plans" });
		await t.draft(user, { subject: "The LAUNCH is today" });
		await t.draft(user, { subject: "Something else" });
		const discarded = await t.draft(user, { subject: "Launch discarded" });
		await t.api(user.key, "DELETE", `/campaigns/${discarded}`);
		await t.importReaders(user, 3, { prefix: "jane" });
		await t.importReaders(user, 1, { prefix: "bob" });

		const found = await (await search(user, "launch")).json();
		assert.deepEqual(found.campaigns.map(({ subject }) => subject).toSorted(), ["Launch week plans", "The LAUNCH is today"], "ignoring case, discarded ones left out");
		assert.deepEqual(found.campaigns[0].status, "draft");
		assert.equal(found.contacts.length, 0);

		const people = await (await search(user, "JANE")).json();
		assert.equal(people.contacts.length, 3);
		assert.ok(people.contacts.every(({ email }) => email.startsWith("jane")));
		assert.deepEqual(Object.keys(people.contacts[0]).toSorted(), ["email", "id", "status"], "no more of a contact than the list needs");
	});

	test("asks for two characters, is limited to five of each and stays inside the account", async () => {
		const user = await customer();
		const other = await customer();
		for (let index = 0; index < 7; index++) await t.draft(user, { subject: `Weekly ${index}` });
		await t.draft(other, { subject: "Weekly of someone else" });
		await t.importReaders(other, 2, { prefix: "weekly" });

		assert.deepEqual(await (await search(user, "w")).json(), { campaigns: [], contacts: [] });
		const found = await (await search(user, "weekly")).json();
		assert.equal(found.campaigns.length, 5);
		assert.ok(found.campaigns.every(({ subject }) => subject.startsWith("Weekly ")));
		assert.equal(found.contacts.length, 0, "the other account's contacts are not here");
	});

	test("answers only the dashboard's own pages, signed in", async () => {
		const user = await customer();
		assert.equal((await search(null, "launch")).status, 401);
		assert.equal((await search(user, "launch", { "sec-fetch-site": "cross-site" })).status, 403);
		assert.equal((await search(user, "launch", { "sec-fetch-site": "same-origin" })).status, 200);
	});

	test("is list_campaigns' and list_contacts' search, as the API has it", async () => {
		const user = await customer();
		await t.draft(user, { subject: "Spring sale (20% off)" });
		await t.draft(user, { subject: "Autumn" });
		const result = await t.api(user.key, "GET", `/campaigns?search=${encodeURIComponent("(20%")}`);
		assert.deepEqual(result.body.campaigns.map(({ subject }) => subject), ["Spring sale (20% off)"], "typed characters are not a pattern");
		assert.equal((await t.api(user.key, "GET", "/campaigns?search=SPRING")).body.campaigns.length, 1);
		assert.equal((await t.api(user.key, "GET", "/campaigns")).body.campaigns.length, 2);
	});
});
