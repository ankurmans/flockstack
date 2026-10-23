import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, setupSender } from "./helpers/sending.mjs";

// check_campaign: the review step's ready-to-send check through the registry, with real contacts, fields, uploads, plans and
// senders behind it.
let app;
let m;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = { ...(await loadSendingModules()), apiKeys: await import("../app/(app)/api-keys/actions.js"), Upload: (await import("../models/Upload.js")).default, CustomField: (await import("../models/CustomField.js")).default };
});

after(() => app?.stop());

const find = (result, id) => result.items.find((entry) => entry.id === id);

describe("check_campaign", () => {
	test("reads a draft: who it goes to, merge tags, pictures and what is fine", async () => {
		const user = await setupSender(m, "check-data@example.com", { contacts: 10 });
		await act(m, user, "create_custom_field", { newsletter: user.newsletterId, key: "first_name", label: "First name", type: "text" });
		await Promise.all(
			[0, 1, 2, 3, 4, 5, 6].map((index) =>
				act(m, user, "set_contact_field", { newsletter: user.newsletterId, email: `reader${index}@check-data.example.org`, field: "first_name", value: "Sam" }).catch(() => null)
			)
		);
		const big = "https://cdn.example.org/uploads/big.png";
		const small = "https://cdn.example.org/uploads/small.png";
		await m.Upload.insertMany([
			{ accountId: user.accountId, url: big, pathname: "uploads/big.png", contentType: "image/png", bytes: 2_400_000 },
			{ accountId: user.accountId, url: small, pathname: "uploads/small.png", contentType: "image/png", bytes: 90_000 },
		]);
		const id = await createDraft(m, user, {
			subject: "Hello {{first_name|there}}",
			previewText: "A short note",
			body: `<p>Hi {{first_name|there}}</p><img src="${big}" alt="Big"><img src="${small}">`,
		});

		const result = await act(m, user, "check_campaign", { id });
		assert.equal(result.campaignId, id);
		assert.equal(result.canSend, true);
		assert.equal(find(result, "audience").message, "It goes to 10 readers: everyone on the list.");
		assert.equal(find(result, "sender").status, "pass");
		assert.equal(find(result, "plan").status, "pass");
		assert.equal(find(result, "images-alt").status, "warning");
		assert.match(find(result, "images-alt").message, /An image has no alt text/);
		assert.equal(find(result, "images-size").status, "warning");
		assert.match(find(result, "images-size").message, /An image is over 1\.0 MB \(the biggest is 2\.4 MB\)/);
		const tags = find(result, "merge-tags");
		assert.equal(tags.status, "warning");
		assert.match(tags.message, /\{\{first_name\}\} is empty for \d+ of 10 contacts, who see "there"/);
		assert.equal(find(result, "links").status, "pass", "no links to open");
		assert.equal(tags.fix.url, `http://localhost:3000/campaigns/${id}`);
		assert.equal(find(result, "plan").fix, null);
	});

	test("says what the send itself would refuse, in its own words", async () => {
		const user = await setupSender(m, "check-refuse@example.com", { contacts: 6 });
		const id = await createDraft(m, user, { subject: "Refused", previewText: "p" });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 99_998 } });
		const result = await act(m, user, "check_campaign", { id });
		assert.equal(result.canSend, false);
		assert.equal(find(result, "plan").status, "blocker");
		assert.match(find(result, "plan").message, /needs 6 emails and your plan has 2 left this month/);
		assert.equal(find(result, "plan").fix.url, "http://localhost:3000/billing");

		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { postalAddress: "", postalAddressCleared: true } });
		const without = await act(m, user, "check_campaign", { id });
		assert.equal(find(without, "address").status, "blocker");
		assert.equal(find(without, "address").fix.url, "http://localhost:3000/newsletters#postal-address");
	});

	test("on the Free plan names its footer and refuses a first campaign that is too big, as the send does", async () => {
		const user = await signIn("check-free@example.com");
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "Free news", slug: "check-free", postalAddress: "1 Main St, Paris" }))));
		user.newsletterId = url.split("/").at(-1);
		await m.Contact.insertMany(Array.from({ length: 501 }, (_, index) => ({ accountId: user.accountId, newsletterId: user.newsletterId, email: `reader${index}@check-free.example.org`, status: "active", source: "import" })));
		const id = await createDraft(m, user, { subject: "Free", previewText: "p" });
		const result = await act(m, user, "check_campaign", { id });
		assert.equal(find(result, "free-footer").status, "info");
		assert.equal(find(result, "plan").status, "blocker");
		assert.match(find(result, "plan").message, /500 people at most\. This one would go to 501\./);
	});

	test("notes a paywall break, and a web only issue is checked as a page", async () => {
		const user = await setupSender(m, "check-paywall@example.com", { contacts: 3 });
		const id = await createDraft(m, user, { subject: "Paid part", previewText: "p", body: '<p>Free part</p><div data-paywall></div><p>Paid part</p>' });
		assert.equal(find(await act(m, user, "check_campaign", { id }), "paywall").status, "info");
		await act(m, user, "update_newsletter", { id: user.newsletterId, archiveEnabled: true });
		await act(m, user, "update_campaign", { id, publishTo: "web" });
		const web = await act(m, user, "check_campaign", { id });
		assert.equal(find(web, "website").status, "pass");
		assert.equal(find(web, "audience"), undefined);
	});

	test("is a read action: a read only key runs it, and it is the same through the REST API", async () => {
		const { getActionClass } = await import("../lib/action-scopes.js");
		assert.equal(getActionClass("check_campaign"), "read");
		const user = await setupSender(m, "check-key@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Key", previewText: "p" });
		const key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Reader", level: "read_only" })))).key;
		const response = await callApi("GET", `/api/v1/campaigns/${id}/check`, { key });
		assert.equal(response.status, 200);
		assert.equal(response.body.campaignId, id);
		assert.ok(Array.isArray(response.body.items));
		assert.equal((await callApi("POST", `/api/v1/campaigns/${id}/send`, { key, body: {} })).status, 403);
	});

	test("answers conflict for a campaign that already went out", async () => {
		const user = await setupSender(m, "check-sent@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Sent", previewText: "p" });
		await act(m, user, "send_campaign", { id });
		await assert.rejects(act(m, user, "check_campaign", { id }), { code: "conflict" });
	});
});

describe("what the review step and the approval show", () => {
	test("the checklist lists what to fix first, then what to check, then what passed, with the fix buttons and a test button", async () => {
		const { default: PanelReady } = await import("../components/PanelReady.jsx");
		const ready = {
			error: null,
			result: {
				isChecking: true,
				items: [
					{ id: "subject", status: "pass", title: "Subject", message: "Fine.", fix: null },
					{ id: "address", status: "blocker", title: "Postal address", message: "Add a postal address.", fix: { label: "Add a postal address", target: "settings", path: "/newsletters#postal-address", url: "x" } },
					{ id: "preview", status: "warning", title: "Preview text", message: "Add preview text.", fix: { label: "Add preview text", target: "previewText", url: "x" } },
					{ id: "links", status: "info", title: "Links", message: "Checking 2 links…", fix: null },
				],
			},
		};
		const html = renderToStaticMarkup(createElement(PanelReady, { ready, onFix() {}, onTest() {}, isTesting: false, isTestDisabled: false }));
		assert.ok(html.indexOf("Postal address") < html.indexOf("Preview text"), "blockers first");
		assert.ok(html.indexOf("Preview text") < html.indexOf("Links"));
		assert.ok(html.indexOf("Links") < html.indexOf("Subject"), "passes last");
		assert.match(html, /1 to fix/);
		assert.match(html, /1 to check/);
		assert.match(html, /Send a test to me/);
		assert.match(html, /href="\/newsletters#postal-address"/);
		assert.match(html, /aria-label="Checking"/);
		assert.doesNotMatch(renderToStaticMarkup(createElement(PanelReady, { ready, isApproval: true })), /Send a test to me|Add preview text<\/button>/);
	});

	test("the preview frames run nothing, at phone and desktop width, light and dark", async () => {
		const { PreviewReady } = await import("../components/PanelReady.jsx");
		const html = renderToStaticMarkup(createElement(PreviewReady, { html: "<html><head></head><body><p>Hi</p></body></html>" }));
		assert.match(html, /<iframe[^>]*sandbox=""/);
		assert.doesNotMatch(html, /allow-scripts|allow-same-origin/);
		assert.match(html, /style="width:375px"/);
		assert.match(html, /Phone, 375 pixels wide/);
		assert.match(html, /Desktop, 640 pixels wide/);
		assert.match(html, /aria-label="Light"/);
		assert.match(html, /aria-label="Dark"/);
	});

	test("an agent's request to send shows the check under it, and other requests don't", async () => {
		const { default: CardApproval } = await import("../components/CardApproval.jsx");
		const approval = (action) => ({
			id: "a1",
			action,
			input: { id: "64b7f0f0f0f0f0f0f0f0f0f0" },
			inputHash: "0".repeat(64),
			preview: { title: "Send a campaign now", lines: [], links: [] },
			actor: { name: "Agent", type: "key" },
			createdAt: new Date().toISOString(),
			reason: "key",
		});
		assert.match(renderToStaticMarkup(createElement(CardApproval, { approval: approval("send_campaign") })), /Ready to send\?/);
		assert.match(renderToStaticMarkup(createElement(CardApproval, { approval: approval("schedule_campaign") })), /Ready to send\?/);
		assert.doesNotMatch(renderToStaticMarkup(createElement(CardApproval, { approval: approval("delete_campaign") })), /Ready to send\?/);
	});
});
