import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { isReservedRedirectPath, normalizeRedirectPath, normalizeRedirectTarget, withQuery } from "../lib/redirect-paths.js";
import { activate, as, callApi, form, signIn, startTestApp } from "./helpers/app.mjs";

const SHARED_DOMAIN = "flockstackmail.com";
let app;
let m;

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	user.newsletter = await m.Newsletter.create({
		accountId: user.accountId,
		name: `${slug} notes`,
		slug,
		fromName: "Jane Doe",
		fromEmail: `hello@${slug}.${SHARED_DOMAIN}`,
		archiveEnabled: true,
	});
	return user;
}

function visitHost(slug, path) {
	m.clearRedirectCache();
	const url = `https://${slug}.${SHARED_DOMAIN}${path}`;
	return m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
}

before(async () => {
	app = await startTestApp();
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		clearRedirectCache: (await import("../lib/redirect-routing.js")).clearRedirectCache,
		Campaign: (await import("../models/Campaign.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("redirect paths", () => {
	test("paths match without case, query, trailing slash or encoding; the website's own pages can't redirect", () => {
		assert.equal(normalizeRedirectPath("/P/Old-Post/?utm_source=x#top"), "/p/old-post");
		assert.equal(normalizeRedirectPath("https://news.example.com/2023/05/12/hello-world/"), "/2023/05/12/hello-world");
		assert.equal(normalizeRedirectPath("p/caf%C3%A9"), "/p/café");
		assert.equal(normalizeRedirectPath("/a//b/"), "/a/b");
		assert.equal(normalizeRedirectPath("/bad%E0%A4%A"), null);
		assert.equal(normalizeRedirectPath(`/${"a".repeat(400)}`), null);
		for (const path of ["/", "/feed.xml", "/sitemap.xml", "/robots.txt", "/shop", "/subscribe", "/unsubscribe", "/o/abc", "/c/abc", "/api/views", "/reader/in"]) {
			assert.ok(isReservedRedirectPath(normalizeRedirectPath(path) ?? path), path);
		}
		assert.ok(!isReservedRedirectPath("/p/old-post"));
	});

	test("a target is a path on the website or an https:// address", () => {
		assert.equal(normalizeRedirectTarget("/p/new-post"), "/p/new-post");
		assert.equal(normalizeRedirectTarget("https://example.com/a?b=1"), "https://example.com/a?b=1");
		for (const target of ["http://example.com/", "javascript:alert(1)", "//evil.example.com/", "https://user:pass@example.com/", "p/no-slash", ""]) {
			assert.equal(normalizeRedirectTarget(target), null, target);
		}
		assert.equal(withQuery("/p/new", "?utm_source=x"), "/p/new?utm_source=x");
		assert.equal(withQuery("/p/new?ref=1", "?utm_source=x"), "/p/new?ref=1");
		assert.equal(withQuery("/p/new#top", "?a=1"), "/p/new?a=1#top");
	});
});

describe("redirects by hand", () => {
	let lee;

	before(async () => {
		lee = await customer("lee-redirects@example.com", "lee-letters");
		await m.Campaign.create({ accountId: lee.accountId, newsletterId: lee.newsletter._id, subject: "Live", status: "sent", archiveSlug: "lee-live", sentAt: new Date() });
	});

	test("added, listed, refused when they can't work, replaced by CSV and deleted, through the API", async () => {
		const added = await callApi("POST", "/api/v1/redirects", { key: lee.key, body: { newsletter: "lee-letters", from: "/Old-Post/", to: "/p/lee-live" } });
		assert.equal(added.status, 201, JSON.stringify(added.body));
		assert.equal(added.body.from, "/old-post");
		assert.equal((await callApi("POST", "/api/v1/redirects", { key: lee.key, body: { from: "/old-post", to: "/p/other" } })).status, 409);
		assert.equal((await callApi("POST", "/api/v1/redirects", { key: lee.key, body: { from: "/feed.xml", to: "/p/x" } })).status, 400);
		assert.equal((await callApi("POST", "/api/v1/redirects", { key: lee.key, body: { from: "/x", to: "javascript:alert(1)" } })).status, 400);
		assert.equal((await callApi("POST", "/api/v1/redirects", { key: lee.key, body: { from: "/loop", to: "/loop/" } })).status, 400);

		const csv = "from,to\n/old-post,https://example.com/elsewhere\n/2020/01/01/hi/,/p/lee-live\n/shop,/p/lee-live\nnot a row\n";
		const imported = await callApi("POST", "/api/v1/redirects/import", { key: lee.key, body: { csv } });
		assert.equal(imported.status, 200, JSON.stringify(imported.body));
		assert.deepEqual({ ...imported.body, problems: imported.body.problems.map(({ line }) => line) }, { added: 1, updated: 1, invalid: 2, problems: [4, 5] });

		const listed = await callApi("GET", "/api/v1/redirects?newsletter=lee-letters", { key: lee.key });
		assert.equal(listed.body.total, 2);
		assert.deepEqual(listed.body.redirects.map(({ from, to }) => [from, to]).sort(), [["/2020/01/01/hi", "/p/lee-live"], ["/old-post", "https://example.com/elsewhere"]]);
		const elsewhere = await visitHost("lee-letters", "/old-post");
		assert.equal(elsewhere.status, 301);
		assert.equal(elsewhere.headers.get("location"), "https://example.com/elsewhere");

		const stranger = await customer("stranger-redirects@example.com", "stranger-notes");
		const id = listed.body.redirects[0].id;
		assert.equal((await callApi("DELETE", `/api/v1/redirects/${id}`, { key: stranger.key })).status, 404);
		assert.equal((await callApi("DELETE", `/api/v1/redirects/${id}`, { key: lee.key })).status, 200);
		assert.equal((await callApi("DELETE", `/api/v1/redirects/${id}`, { key: lee.key })).status, 404);
	});
});
