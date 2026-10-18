import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// The dashboard pages for tags, segments and automations, rendered with real data.
let t;
let m;

before(async () => {
	t = await setupAudienceTests();
	m = {
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		contactsPage: await import("../app/(app)/contacts/page.js"),
		segmentsPage: await import("../app/(app)/segments/page.js"),
		newSegmentPage: await import("../app/(app)/segments/new/page.js"),
		segmentPage: await import("../app/(app)/segments/[id]/page.js"),
		campaignPage: await import("../app/(app)/campaigns/[id]/page.js"),
	};
});

after(() => t?.app.stop());

async function render(user, page, props = {}) {
	const element = await as(user, () => page.default(props));
	return renderToStaticMarkup(createElement(m.TooltipProvider, null, element));
}

describe("contacts", () => {
	test("show their tags and offer the tag filter and the custom fields", async () => {
		const user = await t.customer("pages-contacts@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text" });
		await t.importReaders(user, 2, { tags: (index) => (index === 0 ? ["vip", "beta"] : []) });
		const html = await render(user, m.contactsPage, { searchParams: Promise.resolve({}) });
		assert.match(html, />vip</);
		assert.match(html, />beta</);
		assert.match(html, /Tags and fields/);
		assert.match(html, /aria-label="Tag"/);

		const filtered = await render(user, m.contactsPage, { searchParams: Promise.resolve({ tag: "vip" }) });
		assert.match(filtered, /reader0@/);
		assert.doesNotMatch(filtered, /reader1@/);
	});
});

describe("segments", () => {
	test("are listed with their counts, built and edited", async () => {
		const user = await t.customer("pages-segments@example.com");
		await t.importReaders(user, 3, { tags: () => ["vip"] });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIP readers", rules: { match: "all", conditions: [{ type: "tag", value: "vip" }] } })).body;

		const list = await render(user, m.segmentsPage);
		assert.match(list, /VIP readers/);
		assert.match(list, /Has the tag vip/);
		assert.match(list, />3</);

		assert.match(await render(user, m.newSegmentPage), /Rules/);
		const edit = await render(user, m.segmentPage, { params: Promise.resolve({ id: segment.id }) });
		assert.match(edit, /value="VIP readers"/);
		assert.match(edit, /Who matches now/);
	});

	test("have an empty page that says what they are", async () => {
		const user = await t.customer("pages-no-segments@example.com");
		assert.match(await render(user, m.segmentsPage), /No segments yet/);
	});
});

describe("a campaign's send step", () => {
	test("lets the audience be picked among the saved segments", async () => {
		const user = await t.customer("pages-send@example.com");
		await t.importReaders(user, 2, { tags: (index) => (index === 0 ? ["vip"] : []) });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIP readers", rules: { match: "all", conditions: [{ type: "tag", value: "vip" }] } })).body;
		const id = await t.draft(user, { segment: segment.id });
		const html = await render(user, m.campaignPage, { params: Promise.resolve({ id }) });
		assert.match(html, /aria-label="Audience"/);
		assert.match(html, /1 contact/);
	});
});
