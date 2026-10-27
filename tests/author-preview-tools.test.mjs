import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setupAudienceTests } from "./helpers/audience.mjs";
let t, m, owner, other, guest;
before(async () => { t = await setupAudienceTests(); m = t.m; owner = await t.customer("author-owner@example.com"); other = await t.customer("other-author-owner@example.com"); });
after(() => t?.app.stop());
const api = (method, path, body, who = owner) => t.api(who.key, method, path, body);
async function campaign(extra = {}) { const response = await api("POST", "/campaigns", { newsletter: owner.newsletterId, subject: "Issue {{first_name|friend}}", format: "rich", content: '<p>Public {{first_name|friend}}</p><div data-paywall=""></div><h2>PAID_HEADING</h2><p>PRIVATE_REMAINDER</p>', ...extra }); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body; }
test("guest profiles have unique stable slugs, stay account scoped and can be assigned without changing the sender", async () => {
	const made = await api("POST", "/authors", { newsletter: owner.newsletterId, name: "A guest writer", bio: "Public biography" }); assert.equal(made.status, 200, JSON.stringify(made.body)); guest = made.body.authors.find(({ id }) => id !== "default");
	assert.equal((await api("POST", "/authors", { newsletter: owner.newsletterId, name: "A guest writer" })).status, 400);
	const changed = await api("POST", "/authors", { newsletter: owner.newsletterId, id: guest.id, name: "Renamed guest" }); assert.equal(changed.status, 200); assert.equal(changed.body.authors.find(({ id }) => id === guest.id).slug, guest.slug);
	assert.equal((await api("POST", "/authors", { newsletter: owner.newsletterId, name: "Intruder" }, other)).status, 404);
	const issue = await campaign({ authorId: guest.id }); assert.equal(issue.authorId, guest.id);
	const stored = await m.Campaign.findOne({ accountId: owner.accountId, _id: issue.id }).lean(); const newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	assert.equal((await import("../lib/archive-author.js")).getIssueAuthor(newsletter, stored).name, "Renamed guest"); assert.equal(stored.fromName, undefined);
	assert.equal((await api("PATCH", `/campaigns/${issue.id}/author`, { authorId: guest.id }, other)).status, 404);
});
test("archiving preserves past bylines and refuses new assignments; stale concurrent profile edits do not overwrite", async () => {
	const issue = await campaign({ authorId: guest.id });
	assert.equal((await api("PATCH", `/authors/${guest.id}`, { newsletter: owner.newsletterId, archived: true })).status, 200);
	assert.equal((await api("PATCH", `/campaigns/${issue.id}/author`, { authorId: guest.id })).status, 400);
	const newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	assert.equal((await import("../lib/archive-author.js")).getIssueAuthor(newsletter, { authorId: guest.id }).name, "Renamed guest");
	assert.equal((await api("PATCH", `/authors/${guest.id}`, { newsletter: owner.newsletterId, archived: false })).status, 200);
	const stale = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean(); const account = await m.Account.findById(owner.accountId).lean(); const { upsertAuthor } = await import("../lib/authors.js");
	await upsertAuthor(account, stale, { name: "First concurrent author" });
	await assert.rejects(upsertAuthor(account, stale, { name: "Second concurrent author" }), /authors changed/);
	assert.equal((await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean()).authors.some(({ name }) => name === "Second concurrent author"), false);
});
test("bulk tags and authors change only the scoped editable or completed issues, and moving clears the old byline", async () => {
	const first = await campaign({ tags: ["original"] }); const second = await campaign();
	let response = await api("POST", "/campaigns/bulk", { ids: [first.id, second.id], operation: "tag", tags: ["new"], tagMode: "add" }); assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.done, 2);
	assert.deepEqual((await api("GET", `/campaigns/${first.id}`)).body.tags, ["original", "new"]);
	response = await api("POST", "/campaigns/bulk", { ids: [first.id], operation: "tag", tags: ["ORIGINAL"], tagMode: "remove" }); assert.equal(response.body.done, 1); assert.deepEqual((await api("GET", `/campaigns/${first.id}`)).body.tags, ["new"]);
	response = await api("POST", "/campaigns/bulk", { ids: [first.id], operation: "author", authorId: guest.id }); assert.equal(response.body.done, 1); assert.equal((await api("GET", `/campaigns/${first.id}`)).body.authorId, guest.id);
	assert.equal((await api("POST", "/campaigns/bulk", { ids: [first.id], operation: "tag", tags: [] }, other)).body.done, 0);
	const target = await m.Newsletter.create({ accountId: owner.accountId, name: "Other publication", slug: "other-publication", fromEmail: "other@example.com" });
	assert.equal((await api("POST", "/campaigns/bulk", { ids: [first.id], operation: "move", newsletter: String(target._id) })).body.done, 1);
	assert.equal((await m.Campaign.findOne({ accountId: owner.accountId, _id: first.id }).lean()).authorId, undefined);
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: second.id }, { $set: { status: "sending" } });
	assert.equal((await api("POST", "/campaigns/bulk", { ids: [second.id], operation: "tag", tags: ["blocked"] })).body.skipped, 1);
});
test("subscriber previews merge personal fields and respect paywall and paid-tier access without issuing account capabilities", async () => {
	const issue = await campaign();
	const free = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "free-preview@example.com", status: "active", fields: { first_name: "<script>Unsafe name</script>" } });
	let preview = await api("POST", `/campaigns/${issue.id}/preview`, { email: free.email, mode: "email" }); assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.paidAccess, false); assert.doesNotMatch(preview.body.html, /PRIVATE_REMAINDER|PAID_HEADING|<script>/); assert.match(preview.body.html, /&lt;script&gt;/); assert.doesNotMatch(preview.body.html, /token=|\/reader\/in\?|\/api\/shop\/portal\?/);
	preview = await api("POST", `/campaigns/${issue.id}/preview`, { tier: "paid" }); assert.match(preview.body.html, /PRIVATE_REMAINDER/);
	const wrong = await m.Contact.create({ accountId: other.accountId, newsletterId: other.newsletterId, email: "other-preview@example.com", status: "active" });
	assert.equal((await api("POST", `/campaigns/${issue.id}/preview`, { contactId: String(wrong._id) })).status, 404);
	assert.equal((await api("POST", `/campaigns/${issue.id}/preview`, { email: free.email, tier: "paid" })).status, 400);
	assert.equal(await m.Message.countDocuments({ accountId: owner.accountId, campaignId: issue.id }), 0);
});
test("guest author pages and feed metadata use the selected profile and leave other writers' issues out", async () => {
	const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server");
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { archiveEnabled: true } });
	const own = await campaign({ subject: "SELECTED_GUEST_ISSUE", authorId: guest.id }); const regular = await campaign({ subject: "DEFAULT_WRITER_ISSUE" });
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: own.id }, { $set: { status: "sent", archiveSlug: "selected-guest", sentAt: new Date() } });
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: regular.id }, { $set: { status: "sent", archiveSlug: "default-writer", sentAt: new Date() } });
	const page = (await import("../app/archive/[slug]/authors/[author]/page.js")).default;
	const html = renderToStaticMarkup(createElement("div", null, await page({ params: Promise.resolve({ slug: owner.slug, author: guest.slug }) })));
	assert.match(html, /Renamed guest/); assert.match(html, /SELECTED_GUEST_ISSUE/); assert.doesNotMatch(html, /DEFAULT_WRITER_ISSUE/);
	const { getIssueSeo } = await import("../lib/archive-seo.js"); const newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	const seo = getIssueSeo(newsletter, await m.Campaign.findOne({ accountId: owner.accountId, _id: own.id }).lean());
	assert.match(JSON.stringify(seo.jsonLd), /Renamed guest/); assert.match(JSON.stringify(seo.jsonLd), new RegExp(guest.slug));
});
