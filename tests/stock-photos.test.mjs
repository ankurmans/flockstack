import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { mockUnsplash, withEnv } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// Unsplash stock photos with its API replaced by a stub: the key stays on the server, a photo is read by its ID, its use is
// reported to Unsplash, and it is credited to its photographer and to Unsplash with the utm links their guidelines ask for.
let t;
let n = 0;
let calls;
const KEY = "unsplash-test-access-key";

function raw(id, overrides = {}) {
	return {
		id,
		alt_description: "a lake in the mountains",
		description: null,
		width: 4000,
		height: 3000,
		color: "#336699",
		urls: { regular: `https://images.unsplash.com/photo-${id}?w=1080`, small: `https://images.unsplash.com/photo-${id}?w=400`, thumb: `https://images.unsplash.com/photo-${id}?w=200` },
		links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download?ixid=abc` },
		user: { name: "Ada Photographer", username: "ada", links: { html: "https://unsplash.com/@ada" } },
		...overrides,
	};
}

before(async () => {
	t = await setupAudienceTests();
});

afterEach(() => {
	mockUnsplash(null);
});

after(() => t?.app.stop());

function stub(answer) {
	calls = [];
	mockUnsplash(async (request) => {
		calls.push({ path: request.path, query: Object.fromEntries(request.query), authorization: request.headers.get("authorization") });
		return answer(request);
	});
}

const customer = () => t.customer(`stock${++n}@example.com`);
const search = (user, query) => t.api(user.key, "GET", `/stock-photos?query=${encodeURIComponent(query)}`);

describe("without a key", () => {
	test("the tools say so, and nothing is asked of Unsplash", async () => {
		const user = await customer();
		stub(() => assert.fail("no request without a key"));
		t.assertError(await search(user, "lake"), 503, "unavailable");
		t.assertError(await t.api(user.key, "POST", "/stock-photos/use", { id: "Dwu85P9SOIk" }), 503, "unavailable");
		const { getUnsplashKey } = await import("../lib/unsplash.js");
		assert.equal(getUnsplashKey({}), null);
		assert.equal(getUnsplashKey({ UNSPLASH_ACCESS_KEY: "  " }), null);
	});
});

describe("searching", () => {
	test("sends the words with the access key, and answers with the photographers' links carrying the app's name", async () => {
		await withEnv({ UNSPLASH_ACCESS_KEY: KEY }, async () => {
			const user = await customer();
			stub(() => ({ total: 2, total_pages: 1, results: [raw("abcDEF123"), raw("ghiJKL456", { alt_description: null, description: "Fog", user: { name: "Bo", username: "bo", links: {} } })] }));
			const { status, body } = await search(user, "mountain lake");
			assert.equal(status, 200, JSON.stringify(body));
			assert.deepEqual(calls[0], { path: "/search/photos", query: { query: "mountain lake", page: "1", per_page: "24", content_filter: "high" }, authorization: `Client-ID ${KEY}` });
			assert.equal(body.total, 2);
			assert.equal(body.photos[0].url, "https://images.unsplash.com/photo-abcDEF123?w=1080", "hotlinked from the URL the API gave");
			assert.equal(body.photos[0].photographer.url, "https://unsplash.com/@ada?utm_source=flockstack&utm_medium=referral");
			assert.equal(body.photos[0].pageUrl, "https://unsplash.com/photos/abcDEF123?utm_source=flockstack&utm_medium=referral");
			assert.equal(body.photos[1].description, "Fog");
			assert.equal(body.photos[1].photographer.url, "https://unsplash.com/@bo?utm_source=flockstack&utm_medium=referral");
			assert.match(body.unsplashUrl, /^https:\/\/unsplash\.com\/\?utm_source=flockstack&utm_medium=referral$/);
			assert.ok(!JSON.stringify(body).includes(KEY), "the key never leaves the server");
		});
	});

	test("use the app's registered name when UNSPLASH_APP_NAME is set", async () => {
		await withEnv({ UNSPLASH_ACCESS_KEY: KEY, UNSPLASH_APP_NAME: "My Newsletter App" }, async () => {
			const user = await customer();
			stub(() => ({ total: 1, total_pages: 1, results: [raw("abcDEF123")] }));
			assert.match((await search(user, "lake")).body.photos[0].photographer.url, /utm_source=my\+newsletter\+app&utm_medium=referral$/);
		});
	});

	test("turn Unsplash's limits and failures into FlockStack's codes", async () => {
		await withEnv({ UNSPLASH_ACCESS_KEY: KEY }, async () => {
			const user = await customer();
			stub(() => new Response("Rate Limit Exceeded", { status: 403 }));
			t.assertError(await search(user, "lake"), 429, "rate_limited");
			stub(() => new Response("{}", { status: 500 }));
			t.assertError(await search(user, "lake"), 503, "unavailable");
			mockUnsplash(async () => {
				throw new Error("network down");
			});
			t.assertError(await search(user, "lake"), 503, "unavailable");
			t.assertError(await t.api(user.key, "GET", "/stock-photos"), 400, "validation_failed");
		});
	});
});

describe("using a photo", () => {
	test("reads it by its ID, reports the download once and returns the photo with its credit", async () => {
		await withEnv({ UNSPLASH_ACCESS_KEY: KEY }, async () => {
			const user = await customer();
			stub(({ path }) => (path.endsWith("/download") ? { url: "https://images.unsplash.com/download" } : raw("abcDEF123")));
			const { status, body } = await t.api(user.key, "POST", "/stock-photos/use", { id: "abcDEF123" });
			assert.equal(status, 200, JSON.stringify(body));
			assert.deepEqual(calls.map(({ path }) => path), ["/photos/abcDEF123", "/photos/abcDEF123/download"]);
			assert.equal(calls[1].query.ixid, "abc");
			assert.equal(calls[1].authorization, `Client-ID ${KEY}`);

			assert.equal(body.url, "https://images.unsplash.com/photo-abcDEF123?w=1080");
			assert.equal(body.imageHtml, '<img src="https://images.unsplash.com/photo-abcDEF123?w=1080" alt="a lake in the mountains" width="600" height="450">');
			assert.match(body.creditHtml, /^<p><em>Photo by <a href="https:\/\/unsplash\.com\/@ada\?utm_source=flockstack&amp;utm_medium=referral">Ada Photographer<\/a> on <a href="https:\/\/unsplash\.com\/\?utm_source=flockstack&amp;utm_medium=referral">Unsplash<\/a><\/em><\/p>$/);
			assert.equal(body.html, body.imageHtml + body.creditHtml);

			const { cleanRichHtml } = await import("../lib/clean-html.js");
			const cleaned = cleanRichHtml(body.html);
			assert.match(cleaned, /<img [^>]*src="https:\/\/images\.unsplash\.com\/photo-abcDEF123\?w=1080"/, "the editor's cleaning keeps the photo");
			assert.match(cleaned, /Photo by <a href="https:\/\/unsplash\.com\/@ada/, "and its credit");
		});
	});

	test("escapes what Unsplash returns, and never calls a download address on another host", async () => {
		await withEnv({ UNSPLASH_ACCESS_KEY: KEY }, async () => {
			const user = await customer();
			stub(() =>
				raw("abcDEF123", {
					alt_description: 'a "quoted" <b>alt</b>',
					user: { name: "<script>alert(1)</script>", links: { html: "https://unsplash.com/@x" } },
					links: { html: "https://unsplash.com/photos/abcDEF123", download_location: "https://evil.example.com/steal?key=1" },
				})
			);
			const { body } = await t.api(user.key, "POST", "/stock-photos/use", { id: "abcDEF123" });
			assert.ok(!body.html.includes("<script>") && !body.html.includes("<b>"));
			assert.match(body.html, /&lt;script&gt;/);
			assert.match(body.html, /alt="a &quot;quoted&quot; &lt;b&gt;alt&lt;\/b&gt;"/);
			assert.deepEqual(calls.map(({ path }) => path), ["/photos/abcDEF123"], "only the photo was asked for");
		});
	});

	test("refuses an ID that isn't one, and answers a photo that isn't there", async () => {
		await withEnv({ UNSPLASH_ACCESS_KEY: KEY }, async () => {
			const user = await customer();
			stub(() => new Response("{}", { status: 404 }));
			t.assertError(await t.api(user.key, "POST", "/stock-photos/use", { id: "../users/me" }), 400, "validation_failed");
			assert.equal(calls.length, 0);
			t.assertError(await t.api(user.key, "POST", "/stock-photos/use", { id: "abcDEF123" }), 404, "not_found");
		});
	});
});

describe("the editor", () => {
	test("puts the credit under the picture, italic, with both links", async () => {
		const { creditContent } = await import("../lib/unsplash-client.js");
		const paragraph = creditContent({ photographer: { name: "Ada", url: "https://unsplash.com/@ada?utm_source=flockstack&utm_medium=referral" }, unsplashUrl: "https://unsplash.com/?utm_source=flockstack&utm_medium=referral" });
		assert.equal(paragraph.type, "paragraph");
		assert.deepEqual(paragraph.content.map(({ text }) => text), ["Photo by ", "Ada", " on ", "Unsplash"]);
		assert.ok(paragraph.content.every(({ marks }) => marks[0].type === "italic"));
		assert.deepEqual(paragraph.content.filter(({ marks }) => marks[1]).map(({ marks }) => marks[1].attrs.href), [
			"https://unsplash.com/@ada?utm_source=flockstack&utm_medium=referral",
			"https://unsplash.com/?utm_source=flockstack&utm_medium=referral",
		]);
	});

	test("shows the free photos tab only where the server has a key", async () => {
		const { getUnsplashKey } = await import("../lib/unsplash.js");
		await withEnv({ UNSPLASH_ACCESS_KEY: "" }, () => assert.equal(Boolean(getUnsplashKey()), false));
		await withEnv({ UNSPLASH_ACCESS_KEY: KEY }, () => assert.equal(Boolean(getUnsplashKey()), true));
	});
});
