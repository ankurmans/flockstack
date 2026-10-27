import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setupAudienceTests } from "./helpers/audience.mjs";
let t, m, owner, other, target, draft, targetUrl;
before(async () => { t = await setupAudienceTests(); m = t.m; owner = await t.customer("links-owner@example.com"); other = await t.customer("links-other@example.com"); await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { archiveEnabled: true } }); });
after(() => t?.app.stop());
const api = (method, path, body) => t.api(owner.key, method, path, body);
const reference = (id, url, text = "Read the issue") => `<p><a data-issue-link="${id}" href="${url}">${text}</a></p>`;
test("new content saves track internal links and resolve only the current publication's actual URL", async () => {
	target = await m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, status: "sent", archiveSlug: "published-target", subject: "Published target", html: "<p>Target</p>" });
	const targetResponse = await api("GET", `/campaigns/${target._id}`); targetUrl = targetResponse.body.archiveUrl;
	assert.ok(targetUrl);
	const result = await api("POST", "/campaigns", { newsletter: owner.newsletterId, subject: "Draft with link", format: "rich", content: reference(target._id, targetUrl) }); assert.equal(result.status, 201); draft = result.body.id;
	let links = await api("GET", `/campaigns/${draft}/internal-links`); assert.equal(links.status, 200, JSON.stringify(links.body)); assert.deepEqual(links.body.outgoing.map(({ id }) => id), [String(target._id)]);
	links = await api("GET", `/campaigns/${target._id}/internal-links`); assert.deepEqual(links.body.incoming.map(({ id }) => id), [draft]);
	await api("PATCH", `/campaigns/${draft}`, { content: reference(target._id, "https://elsewhere.example.com/wrong-page") });
	assert.deepEqual((await api("GET", `/campaigns/${draft}/internal-links`)).body.outgoing, []); assert.deepEqual((await api("GET", `/campaigns/${target._id}/internal-links`)).body.incoming, []);
	const foreign = await m.Campaign.create({ accountId: other.accountId, newsletterId: other.newsletterId, status: "sent", archiveSlug: "private-target", subject: "OTHER_ACCOUNT_SUBJECT" });
	await api("PATCH", `/campaigns/${draft}`, { content: reference(foreign._id, targetUrl) }); assert.deepEqual((await api("GET", `/campaigns/${draft}/internal-links`)).body.outgoing, []);
	assert.equal((await api("GET", `/campaigns/${foreign._id}/internal-links`)).status, 404);
});
test("bounded indexing covers historical references and a new save removes stale incoming links", async () => {
	const old = await m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, subject: "Old linked draft", html: reference(target._id, targetUrl) });
	let links = (await api("GET", `/campaigns/${target._id}/internal-links`)).body; assert.ok(links.unindexedIssues > 0); assert.ok(!links.incoming.some(({ id }) => id === String(old._id)));
	const before = await m.Campaign.findOne({ accountId: owner.accountId, _id: old._id }).lean();
	const batch = await api("POST", "/campaigns/internal-links/index", { newsletter: owner.newsletterId }); assert.equal(batch.status, 200, JSON.stringify(batch.body)); assert.equal(batch.body.next, null);
	links = (await api("GET", `/campaigns/${target._id}/internal-links`)).body; assert.ok(links.incoming.some(({ id }) => id === String(old._id))); assert.equal(links.unindexedIssues, 0);
	const after = await m.Campaign.findOne({ accountId: owner.accountId, _id: old._id }).lean(); assert.equal(after.html, before.html); assert.equal(after.status, before.status);
	await api("PATCH", `/campaigns/${old._id}`, { content: "<p>No link now</p>" }); assert.ok(!(await api("GET", `/campaigns/${target._id}/internal-links`)).body.incoming.some(({ id }) => id === String(old._id)));
	assert.equal((await t.api(other.key, "POST", "/campaigns/internal-links/index", { newsletter: owner.newsletterId })).status, 404);
});
test("the editor search wrapper returns only linkable sent issues, and membership metadata stays out of archive data", async () => {
	await m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, status: "sent", subject: "Email only", archiveSlug: "email-only", publishTo: "email" });
	const { as } = await import("./helpers/app.mjs"); const { searchIssueLinks } = await import("../app/(app)/campaigns/actions.js"); const result = await as(owner, () => searchIssueLinks(owner.newsletterId, ""));
	assert.ok(result.issues.some(({ id }) => id === String(target._id))); assert.ok(result.issues.every(({ url }) => !url.includes("email-only")));
	const { getArchiveIssue, getArchiveNewsletter } = await import("../lib/archive-data.js"); const newsletter = await getArchiveNewsletter(owner.slug); const issue = await getArchiveIssue(newsletter, target.archiveSlug); assert.equal(issue.internalLinkIds, undefined);
});

test("restoring content restores its derived link index and moving to another newsletter clears it", async () => {
	const created = await api("POST", "/campaigns", { newsletter: owner.newsletterId, subject: "Versioned link", format: "rich", content: reference(target._id, targetUrl) }); const id = created.body.id;
	await api("PATCH", `/campaigns/${id}`, { content: "<p>Removed reference</p>" });
	const versions = await api("GET", `/campaigns/${id}/versions`); const version = versions.body.versions[0]; assert.ok(version);
	const restored = await api("POST", `/campaigns/${id}/versions/${version.id}/restore`, {}); assert.equal(restored.status, 200, JSON.stringify(restored.body));
	assert.ok((await api("GET", `/campaigns/${target._id}/internal-links`)).body.incoming.some((link) => link.id === id));
	const second = await m.Newsletter.create({ accountId: owner.accountId, slug: "links-second", name: "Second", fromEmail: "hello@links-second.example.com" });
	const moved = await api("POST", "/campaigns/bulk", { ids: [id], operation: "move", newsletter: String(second._id) });
	assert.equal(moved.status, 200, JSON.stringify(moved.body));
	const fresh = await m.Campaign.findOne({ accountId: owner.accountId, _id: id }).lean(); assert.equal(fresh.internalLinkIds, undefined);
	assert.ok(!(await api("GET", `/campaigns/${target._id}/internal-links`)).body.incoming.some((link) => link.id === id));
});
