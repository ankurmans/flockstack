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
		automationsPage: await import("../app/(app)/automations/page.js"),
		automationPage: await import("../app/(app)/automations/[id]/page.js"),
		automationActions: await import("../app/(app)/automations/actions.js"),
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

describe("automations", () => {
	test("are listed with what starts them and how many contacts they hold", async () => {
		const user = await t.customer("pages-automations@example.com");
		assert.match(await render(user, m.automationsPage), /No automations yet/);
		const created = await t.api(user.key, "POST", "/automations", {
			name: "Welcome series",
			trigger: { type: "subscribed" },
			steps: [
				{ type: "email", subject: "Welcome", content: "Hello." },
				{ type: "wait", amount: 2, unit: "days" },
				{ type: "email", subject: "Next", content: "More." },
			],
		});
		const html = await render(user, m.automationsPage);
		assert.match(html, /Welcome series/);
		assert.match(html, /A contact subscribes/);
		assert.match(html, /Draft/);
		assert.match(html, new RegExp(`/automations/${created.body.id}`));
	});

	test("open in an editor with the trigger, the steps and the counts, and are made from the dashboard", async () => {
		const user = await t.customer("pages-automation-editor@example.com");
		const created = await t.api(user.key, "POST", "/automations", {
			name: "Welcome series",
			trigger: { type: "tag_added", tag: "vip" },
			steps: [{ type: "email", subject: "Welcome", content: "Hello." }, { type: "add_tag", tag: "welcomed" }],
		});
		const html = await render(user, m.automationPage, { params: Promise.resolve({ id: created.body.id }) });
		assert.match(html, /value="Welcome series"/);
		assert.match(html, /Starts when/);
		assert.match(html, /Welcome/);
		assert.match(html, /Add a tag/);
		assert.match(html, />Contacts</);
		assert.match(html, />Activate</);

		await t.api(user.key, "POST", `/automations/${created.body.id}/activate`);
		const active = await render(user, m.automationPage, { params: Promise.resolve({ id: created.body.id }) });
		assert.match(active, /Pause it to change its trigger or steps/);
		assert.match(active, />Pause</);

		const redirected = await as(user, () => m.automationActions.createAutomation(user.newsletterId).catch((error) => error));
		assert.match(redirected.url, /^\/automations\/[a-f0-9]{24}$/);
		assert.equal((await t.api(user.key, "GET", "/automations")).body.automations.length, 2);
	});

	test("name a wait of one unit in the singular", async () => {
		const user = await t.customer("pages-automation-waits@example.com");
		const created = await t.api(user.key, "POST", "/automations", {
			name: "Waits",
			trigger: { type: "subscribed" },
			steps: [{ type: "wait", amount: 1, unit: "days" }, { type: "wait", amount: 3, unit: "hours" }, { type: "wait", amount: 1, unit: "minutes" }],
		});
		const html = await render(user, m.automationPage, { params: Promise.resolve({ id: created.body.id }) });
		assert.match(html, />1 day</);
		assert.match(html, />3 hours</);
		assert.match(html, />1 minute</);
		assert.doesNotMatch(html, />1 days</);
	});

	test("say what's wrong in the editor's words: steps from 1, no field names", async () => {
		const user = await t.customer("pages-automation-errors@example.com");
		const created = await t.api(user.key, "POST", "/automations", { name: "Errors", trigger: { type: "subscribed" }, steps: [{ type: "email", subject: "Hi", content: "Hello." }] });
		const save = (changes) => as(user, () => m.automationActions.saveAutomation(created.body.id, { name: "Errors", trigger: { type: "subscribed" }, steps: [], ...changes }));
		const email = { type: "email", subject: "Hi", format: "rich", content: "<p>Hello.</p>" };
		assert.deepEqual(await save({ steps: [email, { type: "wait", amount: 1, unit: "days" }, { type: "add_tag", tag: "" }] }), {
			error: "Step 3 needs a tag: letters, digits, spaces and - _ . : / + &",
		});
		assert.deepEqual(await save({ steps: [email, { type: "wait", amount: 400, unit: "days" }] }), { error: "Step 2: a wait is a year at most" });
		assert.deepEqual(await save({ trigger: { type: "tag_added", tag: "" }, steps: [email] }), { error: "Pick the tag that starts it" });
		assert.deepEqual(await save({ name: "", steps: [email] }), { error: "Name the automation" });
		assert.deepEqual(await save({ steps: [email] }), { ok: true });
	});
});
