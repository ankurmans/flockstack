import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { mockGiphy, withEnv } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// GIF search (parity item W17) with GIPHY's API replaced by a stub: only active with a key, no key needed to run or test the
// app, the key stays on the server, and only GIPHY's own media hosts are ever put in an issue.
let t;
let n = 0;
let calls;
const KEY = "giphy-test-api-key";

function raw(id, overrides = {}) {
	return {
		id,
		title: "happy dance GIF",
		url: `https://giphy.com/gifs/happy-dance-${id}`,
		images: {
			downsized: { url: `https://media1.giphy.com/media/${id}/giphy-downsized.gif`, width: "480", height: "270", size: "1500000" },
			fixed_width: { url: `https://media1.giphy.com/media/${id}/200w.gif`, width: "200", height: "113" },
			fixed_width_small: { url: `https://media1.giphy.com/media/${id}/100w.gif`, width: "100", height: "56" },
			original: { url: `https://media1.giphy.com/media/${id}/giphy.gif`, width: "720", height: "405" },
		},
		...overrides,
	};
}

before(async () => {
	t = await setupAudienceTests();
});

afterEach(() => {
	mockGiphy(null);
});

after(() => t?.app.stop());

function stub(answer) {
	calls = [];
	mockGiphy(async (request) => {
		calls.push({ path: request.path, query: Object.fromEntries(request.query) });
		return answer(request);
	});
}

const customer = () => t.customer(`gifs${++n}@example.com`);
const search = (user, query, extra = "") => t.api(user.key, "GET", `/gifs?query=${encodeURIComponent(query)}${extra}`);

describe("without a key", () => {
	test("the tool says so, nothing is asked of GIPHY, and the key check is empty", async () => {
		await withEnv({ GIPHY_API_KEY: "" }, async () => {
			const user = await customer();
			stub(() => assert.fail("no request without a key"));
			t.assertError(await search(user, "dance"), 503, "unavailable");
			const { getGiphyKey } = await import("../lib/giphy.js");
			assert.equal(getGiphyKey({}), null);
			assert.equal(getGiphyKey({ GIPHY_API_KEY: "  " }), null);
			assert.equal(getGiphyKey({ GIPHY_API_KEY: ` ${KEY} ` }), KEY);
		});
	});

	test("the editor, the pages and the settings all work: the tab is off", async () => {
		await withEnv({ GIPHY_API_KEY: "" }, async () => {
			const { getGiphyKey } = await import("../lib/giphy.js");
			assert.equal(Boolean(getGiphyKey()), false);
			const user = await customer();
			const id = await t.draft(user);
			assert.equal((await t.api(user.key, "GET", `/campaigns/${id}`)).status, 200);
		});
	});
});

describe("searching", () => {
	test("sends the words with the key and a G rating, and answers with GIFs on GIPHY's media hosts", async () => {
		await withEnv({ GIPHY_API_KEY: KEY }, async () => {
			const user = await customer();
			stub(() => ({ data: [raw("abc123"), raw("def456", { title: 'a "quoted" <b>title</b>' })], pagination: { total_count: 60, count: 2, offset: 0 } }));
			const { status, body } = await search(user, "happy dance");
			assert.equal(status, 200, JSON.stringify(body));
			assert.deepEqual(calls[0], { path: "/v1/gifs/search", query: { q: "happy dance", limit: "24", offset: "0", rating: "g", lang: "en", api_key: KEY } });
			assert.equal(body.total, 60);
			assert.equal(body.nextOffset, 2);
			assert.equal(body.giphyUrl, "https://giphy.com/");
			assert.deepEqual(body.gifs[0], {
				id: "abc123",
				title: "happy dance GIF",
				width: 480,
				height: 270,
				thumbUrl: "https://media1.giphy.com/media/abc123/100w.gif",
				url: "https://media1.giphy.com/media/abc123/giphy-downsized.gif",
				pageUrl: "https://giphy.com/gifs/happy-dance-abc123",
				html: '<img src="https://media1.giphy.com/media/abc123/giphy-downsized.gif" alt="happy dance GIF" width="480" height="270">',
			});
			assert.match(body.gifs[1].html, /alt="a &quot;quoted&quot; &lt;b&gt;title&lt;\/b&gt;"/);
			assert.ok(!JSON.stringify(body).includes(KEY), "the key never leaves the server");
		});
	});

	test("pages by offset and perPage, and ends with a null offset", async () => {
		await withEnv({ GIPHY_API_KEY: KEY }, async () => {
			const user = await customer();
			stub(({ query }) => ({ data: [raw("g1")], pagination: { total_count: Number(query.get("offset")) + 1, count: 1, offset: Number(query.get("offset")) } }));
			const last = await search(user, "dance", "&offset=40&perPage=5");
			assert.equal(last.status, 200, JSON.stringify(last.body));
			assert.equal(calls[0].query.offset, "40");
			assert.equal(calls[0].query.limit, "5");
			assert.equal(last.body.nextOffset, null);
			t.assertError(await search(user, "dance", "&offset=-1"), 400, "validation_failed");
			t.assertError(await search(user, "dance", "&perPage=31"), 400, "validation_failed");
			t.assertError(await t.api(user.key, "GET", "/gifs"), 400, "validation_failed");
		});
	});

	test("drops a result that isn't on GIPHY's media hosts or has no usable image", async () => {
		await withEnv({ GIPHY_API_KEY: KEY }, async () => {
			const user = await customer();
			const hostile = raw("bad1", { images: { downsized: { url: "https://evil.example.com/x.gif", width: "10", height: "10" }, fixed_width_small: { url: "https://media1.giphy.com/media/bad1/100w.gif", width: "10", height: "10" } } });
			const insecure = raw("bad2", { images: { downsized: { url: "http://media1.giphy.com/media/bad2/a.gif", width: "10", height: "10" } } });
			const lookalike = raw("bad3", { images: { downsized: { url: "https://media1.giphy.com.evil.example/a.gif", width: "10", height: "10" } } });
			stub(() => ({ data: [hostile, insecure, lookalike, { images: {} }, raw("good1")], pagination: { total_count: 5, count: 5 } }));
			const { body } = await search(user, "dance");
			assert.deepEqual(body.gifs.map(({ id }) => id), ["good1"]);
			for (const gif of body.gifs) {
				assert.match(gif.url, /^https:\/\/media\d*\.giphy\.com\//);
				assert.match(gif.thumbUrl, /^https:\/\/media\d*\.giphy\.com\//);
			}
			assert.ok(!body.gifs.some(({ url }) => url.includes("evil.example")));
		});
	});

	test("turn GIPHY's limits and failures into FlockStack's codes", async () => {
		await withEnv({ GIPHY_API_KEY: KEY }, async () => {
			const user = await customer();
			stub(() => new Response("Too Many Requests", { status: 429 }));
			t.assertError(await search(user, "dance"), 429, "rate_limited");
			stub(() => new Response("{}", { status: 500 }));
			t.assertError(await search(user, "dance"), 503, "unavailable");
			stub(() => ({ meta: { status: 200 } }));
			t.assertError(await search(user, "dance"), 503, "unavailable");
			mockGiphy(async () => {
				throw new Error("network down");
			});
			t.assertError(await search(user, "dance"), 503, "unavailable");
		});
	});
});

describe("the editor's GIF", () => {
	test("is a plain image the editor's cleaning keeps, so it reaches the email", async () => {
		await withEnv({ GIPHY_API_KEY: KEY }, async () => {
			const user = await customer();
			stub(() => ({ data: [raw("abc123")], pagination: { total_count: 1, count: 1 } }));
			const { body } = await search(user, "dance");
			const { cleanRichHtml } = await import("../lib/clean-html.js");
			assert.match(cleanRichHtml(body.gifs[0].html), /<img [^>]*src="https:\/\/media1\.giphy\.com\/media\/abc123\/giphy-downsized\.gif"/);
			const campaign = await t.api(user.key, "PATCH", `/campaigns/${await t.draft(user, { format: "rich", content: body.gifs[0].html })}`, { content: body.gifs[0].html, format: "rich" });
			assert.equal(campaign.status, 200, JSON.stringify(campaign.body));
		});
	});

	test("searches through the dashboard's action with the same limits", async () => {
		await withEnv({ GIPHY_API_KEY: KEY }, async () => {
			const user = await customer();
			stub(() => ({ data: [raw("abc123")], pagination: { total_count: 1, count: 1 } }));
			const { as } = await import("./helpers/app.mjs");
			const actions = await import("../app/(app)/campaigns/actions.js");
			const answer = await as(user, () => actions.searchGifs("dance", 18));
			assert.equal(answer.gifs.length, 1);
			assert.deepEqual([calls[0].query.limit, calls[0].query.offset], ["18", "18"]);
			assert.equal((await as(user, () => actions.searchGifs("", 0))).error !== undefined, true, "an empty search is refused");
		});
	});
});
