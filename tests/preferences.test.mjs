import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderEmail } from "../lib/render-email.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";
import { createSubscriberToken, getPreferencesUrl } from "../lib/subscriber-links.js";
import { form } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

let t;
let actions;
let page;

before(async () => {
	t = await setupAudienceTests();
	actions = await import("../app/preferences/actions.js");
	page = await import("../app/preferences/page.js");
});

after(() => t?.app.stop());

let visitor = 0;
const save = (token, formData) => runWithRequest({ headers: { "x-forwarded-for": `198.18.9.${++visitor}` } }, () => actions.savePreferenceForm(token, null, formData));

async function setup(email) {
	const user = await t.customer(email);
	await t.api(user.key, "POST", "/custom-fields", { label: "First name", type: "text", readerEditable: true });
	await t.api(user.key, "POST", "/custom-fields", { label: "Frequency", type: "list", options: ["Weekly", "Monthly"], readerEditable: true });
	await t.api(user.key, "POST", "/custom-fields", { label: "Topics", type: "list", options: ["News", "Deals"], multiple: true, readerEditable: true });
	await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" });
	await t.importReaders(user, 2, { fields: () => ({ plan: "internal" }) });
	const contacts = (await t.api(user.key, "GET", "/contacts")).body.contacts;
	const newsletter = await t.m.Newsletter.findOne({ accountId: user.accountId }).lean();
	const token = (contact, kind = "preferences") => createSubscriberToken(kind, { contactId: contact.id, newsletterId: user.newsletterId });
	return { user, contacts, newsletter, token };
}

describe("the preference center", () => {
	test("lets a reader change the fields marked editable, and nothing else", async () => {
		const { user, contacts, token } = await setup("prefs-save@example.com");
		const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ token: token(contacts[0]) }) }));
		assert.ok(html.includes("First name") && html.includes("Frequency") && html.includes("Topics"));
		assert.ok(!html.includes("Plan") && !html.includes("internal"), "a field the owner didn't open stays out");
		assert.ok(html.includes("/unsubscribe?token="), "and they can leave");

		const result = await save(token(contacts[0]), form({ field_first_name: "  Ann ", field_frequency: "monthly", field_plan: "hacked", status: "unsubscribed", tags: "vip" }));
		assert.deepEqual(result, { ok: true });
		const topics = new FormData();
		topics.append("field_topics", "Deals");
		topics.append("field_topics", "News");
		assert.deepEqual(await save(token(contacts[0]), topics), { ok: true });
		const stored = await t.m.Contact.findOne({ accountId: user.accountId, _id: contacts[0].id }).lean();
		assert.deepEqual(stored.fields, { plan: "internal", topics: ["News", "Deals"] }, "a blank clears what the form left empty");
		assert.equal(stored.status, "active");
		assert.equal(stored.tags, undefined);

		await save(token(contacts[0]), form({ field_first_name: "Ann", field_frequency: "Weekly" }));
		assert.equal((await t.m.Contact.findOne({ accountId: user.accountId, _id: contacts[0].id }).lean()).fields.frequency, "Weekly");
		assert.match((await save(token(contacts[0]), form({ field_frequency: "Daily" }))).error, /Frequency/);
	});

	test("refuse links that are forged, of another kind, or for a contact who left", async () => {
		const { user, contacts, token } = await setup("prefs-tamper@example.com");
		const good = token(contacts[0]);
		const [payload, signature] = good.split(".");
		const forged = `${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
		for (const bad of [forged, token(contacts[0], "poll"), token(contacts[0], "survey"), "nonsense"]) {
			assert.match((await save(bad, form({ field_first_name: "X" }))).error, /link doesn't work/);
			assert.ok(renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ token: bad }) })).includes("doesn&#x27;t work"));
		}
		await t.m.Contact.updateOne({ accountId: user.accountId, _id: contacts[1].id }, { $set: { status: "unsubscribed" } });
		assert.match((await save(token(contacts[1]), form({ field_first_name: "X" }))).error, /link doesn't work/);
		assert.equal((await t.m.Contact.findOne({ accountId: user.accountId, _id: contacts[1].id }).lean()).fields.first_name, undefined);
	});

	test("are linked from the footer when the newsletter turns it on, and from {{preferences_url}} in a body", async () => {
		const { user, contacts, newsletter } = await setup("prefs-links@example.com");
		const campaign = { _id: contacts[0].id, format: "rich", subject: "Issue", html: '<p>Hi <a href="{{preferences_url}}">your preferences</a></p>' };
		const contact = { _id: contacts[0].id, email: contacts[0].email };
		const withoutFooter = buildRecipientEmail({ campaign, newsletter, contact, messageId: contacts[1].id });
		const link = /href="([^"]*\/preferences\?token=[^"]+)"/.exec(withoutFooter.html)?.[1];
		assert.ok(link, "the tag becomes the reader's link");
		assert.ok(!withoutFooter.html.includes("Update your preferences"), "no footer link while the setting is off");
		assert.ok(!withoutFooter.html.includes("{{preferences_url}}"));
		assert.equal(link, getPreferencesUrl({ contactId: contacts[0].id, newsletterId: user.newsletterId }, newsletter), "not wrapped in a click link");

		assert.equal((await t.api(user.key, "PATCH", `/newsletters/${user.slug}`, { preferencesLink: true })).body.preferencesLink, true);
		const withFooter = buildRecipientEmail({ campaign, newsletter: { ...newsletter, preferencesLink: true }, contact, messageId: contacts[1].id });
		assert.ok(withFooter.html.includes(">Update your preferences</a>"));
		assert.ok(withFooter.text.includes(`Update your preferences: ${link}`));
		assert.ok(!withFooter.html.includes("{{preferences_url}}"));

		const preview = renderEmail({ format: "rich", html: campaign.html, newsletter, preferencesUrl: "{{preferences_url}}" });
		assert.ok(preview.html.includes("Update your preferences"));
	});

	test("show the editable setting in the fields API", async () => {
		const { user } = await setup("prefs-api@example.com");
		const fields = (await t.api(user.key, "GET", "/custom-fields")).body.fields;
		assert.deepEqual(fields.map(({ key, readerEditable }) => [key, readerEditable]), [["first_name", true], ["frequency", true], ["topics", true], ["plan", false]]);
	});
});
