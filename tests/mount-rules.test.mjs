import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { getArchiveHostUrl, getArchiveUrls, getLinkBaseUrl, getMountUpstream, getMountUrl } from "../lib/archive-hosts.js";
import { createAssetRefStream } from "../lib/mount-rewrite.js";
import {
	getChunkBaseScript,
	getMountPageUrl,
	getMountUrlProblem,
	getMountedAssetPath,
	isMountPagePath,
	normalizeMountUrl,
	toHostPath,
	toMountedAssetRefs,
	toMountedLocation,
	toMountedSrcset,
	toMountedUrl,
} from "../lib/mount-rules.js";
import { MOUNT_TOKEN_OVERLAP_MS, createMountToken, hashMountToken, matchMountToken } from "../lib/mount-tokens.js";
import { getReaderPathname, withReaderBase } from "../lib/reader-base.js";
import { buildVisit } from "../lib/visit-beacon.js";

// Subfolder hosting (docs/MOUNT-PATH-DESIGN.md): the rules every part reads, without a database or a request.
const MOUNT = "https://example.com/newsletter/underwritten";
const VERIFIED = { url: MOUNT, tokenHash: "x", verifiedAt: new Date("2026-10-28T00:00:00Z") };
const shared = { sharedDomain: "flockstackmail.com", appUrl: "https://app.example.net" };
const noShared = { sharedDomain: null, appUrl: "https://app.example.net" };

describe("the mount's address", () => {
	test("is https on the default port, a public name, a path of one to three parts and no query", () => {
		assert.equal(getMountUrlProblem("https://example.com/newsletter"), null);
		assert.equal(getMountUrlProblem("https://Example.com/newsletter/underwritten/"), null);
		assert.match(getMountUrlProblem(""), /Enter the address/);
		assert.match(getMountUrlProblem("http://example.com/newsletter"), /https:\/\//);
		assert.match(getMountUrlProblem("https://example.com"), /Add the path/);
		assert.match(getMountUrlProblem("https://example.com/"), /Add the path/);
		assert.match(getMountUrlProblem("https://example.com/a/b/c/d"), /3 parts at most/);
		assert.match(getMountUrlProblem("https://example.com/news?x=1"), /query/);
		assert.match(getMountUrlProblem("https://example.com/news#top"), /query/);
		assert.match(getMountUrlProblem("https://example.com:8443/news"), /port/);
		assert.match(getMountUrlProblem("https://user:pass@example.com/news"), /user name/);
		assert.match(getMountUrlProblem("https://example.com/news%20letter"), /letters, digits/);
		assert.match(getMountUrlProblem("not a url"), /full address/);
	});

	test("is refused inside a private network and on FlockStack's own names", () => {
		for (const url of ["https://localhost/news", "https://127.0.0.1/news", "https://10.1.2.3/news", "https://[::1]/news", "https://intranet.local/news", "https://metadata.google.internal/news", "https://printer/news"]) {
			assert.match(getMountUrlProblem(url), /private network/, url);
		}
		const own = { appHost: "app.example.net", sharedDomain: "flockstackmail.com" };
		assert.match(getMountUrlProblem("https://app.example.net/news", own), /FlockStack's own/);
		assert.match(getMountUrlProblem("https://weekly.flockstackmail.com/news", own), /FlockStack's own/);
		assert.equal(getMountUrlProblem("https://example.com/news", own), null);
	});

	test("is kept with the host in lowercase and no trailing slash", () => {
		assert.equal(normalizeMountUrl(" https://Example.COM/newsletter/underwritten/ "), MOUNT);
	});
});

describe("the archive's URLs", () => {
	test("without a mount: the shared host, or APP_URL/archive/<slug> without a shared domain, as before", () => {
		const onShared = getArchiveUrls({ slug: "underwritten" }, shared);
		assert.equal(onShared.siteIndex, "https://underwritten.flockstackmail.com/");
		assert.equal(onShared.feed, "https://underwritten.flockstackmail.com/feed.xml");
		assert.equal(onShared.mount, null);
		const onApp = getArchiveUrls({ slug: "underwritten" }, noShared);
		assert.equal(onApp.index, "/archive/underwritten");
		assert.equal(onApp.siteIndex, "https://app.example.net/archive/underwritten");
		assert.equal(onApp.feed, "https://app.example.net/archive/underwritten/feed");
		assert.equal(onApp.absoluteMarkdown("one"), "https://app.example.net/archive/underwritten/markdown/one");
	});

	test("a mount that isn't verified yet changes nothing", () => {
		const newsletter = { slug: "underwritten", mount: { url: MOUNT, tokenHash: "x" } };
		assert.equal(getMountUrl(newsletter), null);
		assert.equal(getArchiveUrls(newsletter, shared).siteIndex, "https://underwritten.flockstackmail.com/");
		assert.equal(getArchiveUrls(newsletter, noShared).siteIndex, "https://app.example.net/archive/underwritten");
	});

	test("a verified mount is the base of every page, in the host's shape, whatever the upstream", () => {
		for (const options of [shared, noShared]) {
			const urls = getArchiveUrls({ slug: "underwritten", mount: VERIFIED }, options);
			assert.equal(urls.mount, MOUNT);
			assert.equal(urls.index, `${MOUNT}/`);
			assert.equal(urls.siteIndex, `${MOUNT}/`);
			assert.equal(urls.post("first"), `${MOUNT}/p/first`);
			assert.equal(urls.absolutePost("first"), `${MOUNT}/p/first`);
			assert.equal(urls.absoluteMarkdown("first"), `${MOUNT}/p/first.md`);
			assert.equal(urls.feed, `${MOUNT}/feed.xml`);
			assert.equal(urls.sitemap, `${MOUNT}/sitemap.xml`);
			assert.equal(urls.robots, `${MOUNT}/robots.txt`);
			assert.equal(urls.llms, `${MOUNT}/llms.txt`);
			assert.equal(urls.podcast, `${MOUNT}/podcast.xml`);
			assert.equal(urls.absoluteAudio("first"), `${MOUNT}/audio/first.mp3`);
			assert.equal(urls.absoluteSignin, `${MOUNT}/signin`);
			assert.equal(urls.absoluteAccount, `${MOUNT}/account`);
			assert.equal(urls.absoluteShop, `${MOUNT}/shop`);
			assert.equal(urls.absoluteOffer("launch"), `${MOUNT}/offer/launch`);
			assert.equal(urls.absoluteGive, `${MOUNT}/give`);
			assert.equal(urls.absolutePerks, `${MOUNT}/perks`);
		}
	});

	test("the links in emails never use the mount", () => {
		const newsletter = { slug: "underwritten", mount: VERIFIED };
		assert.equal(getLinkBaseUrl(newsletter, shared), "https://underwritten.flockstackmail.com");
		assert.equal(getLinkBaseUrl(newsletter, noShared), "https://app.example.net");
		assert.equal(getLinkBaseUrl({ ...newsletter, archiveHost: "news.example.org" }, shared), "https://news.example.org");
	});

	test("the upstream is the shared host, else the archive under APP_URL", () => {
		assert.equal(getMountUpstream({ slug: "underwritten" }, shared), "https://underwritten.flockstackmail.com");
		assert.equal(getMountUpstream({ slug: "underwritten" }, noShared), "https://app.example.net/archive/underwritten");
	});

	test("the app domain's /archive paths still find their place on the shared host", () => {
		assert.equal(getArchiveHostUrl("/archive/underwritten", "", "flockstackmail.com"), "https://underwritten.flockstackmail.com/");
		assert.equal(getArchiveHostUrl("/archive/underwritten/feed", "?a=1", "flockstackmail.com"), "https://underwritten.flockstackmail.com/feed.xml?a=1");
		assert.equal(getArchiveHostUrl("/archive/underwritten/markdown/one", "", "flockstackmail.com"), "https://underwritten.flockstackmail.com/p/one.md");
		assert.equal(getArchiveHostUrl("/archive/underwritten/audio/one", "", "flockstackmail.com"), "https://underwritten.flockstackmail.com/audio/one.mp3");
		assert.equal(getArchiveHostUrl("/archive/underwritten/p/one", "", null), null);
		assert.equal(toHostPath(""), "/");
		assert.equal(toHostPath("/podcast"), "/podcast.xml");
	});
});

describe("the redirect from the upstream", () => {
	test("covers the website's HTML pages only", () => {
		for (const path of ["/", "/p/first", "/p/first/", "/issues", "/tags/news", "/authors/jane", "/shop", "/shop/guide", "/subscribe", "/give", "/offer/launch", "/links", "/signin", "/account", "/perks", "/sponsor"]) {
			assert.ok(isMountPagePath(path), path);
		}
		for (const path of ["/unsubscribe", "/confirm", "/keep", "/o/abc", "/c/abc", "/reader/in", "/reader/signin", "/api/visit", "/api/views", "/embed.js", "/_next/static/a.js", "/feed.xml", "/sitemap.xml", "/robots.txt", "/llms.txt", "/podcast.xml", "/p/first.md", "/audio/first.mp3", "/.well-known/flockstack-mount", "/favicon.ico", "/preferences"]) {
			assert.ok(!isMountPagePath(path), path);
		}
	});

	test("lands on the same page under the mount, query kept", () => {
		assert.equal(getMountPageUrl(MOUNT, "/"), `${MOUNT}/`);
		assert.equal(getMountPageUrl(MOUNT, "/p/first/", "?ref=x"), `${MOUNT}/p/first?ref=x`);
	});
});

describe("URLs in a mounted page", () => {
	const context = { mountPath: "/newsletter/underwritten", slug: "underwritten" };

	test("root-relative ones go under the mount path; absolute, protocol-relative and fragments stay", () => {
		assert.equal(toMountedUrl("/_next/static/chunks/a.js", context), "/newsletter/underwritten/_next/static/chunks/a.js");
		assert.equal(toMountedUrl("/api/visit", context), "/newsletter/underwritten/api/visit");
		assert.equal(toMountedUrl("/unsubscribe?token=a#x", context), "/newsletter/underwritten/unsubscribe?token=a#x");
		assert.equal(toMountedUrl("/", context), "/newsletter/underwritten/");
		assert.equal(toMountedUrl("https://cdn.example.com/a.png", context), "https://cdn.example.com/a.png");
		assert.equal(toMountedUrl("//cdn.example.com/a.png", context), "//cdn.example.com/a.png");
		assert.equal(toMountedUrl("/\\evil.example.com", context), "/\\evil.example.com");
		assert.equal(toMountedUrl("#comments", context), "#comments");
		assert.equal(toMountedUrl("mailto:jane@example.com", context), "mailto:jane@example.com");
	});

	test("a path under /archive/<slug> takes its place on the newsletter's host first", () => {
		assert.equal(toMountedUrl("/archive/underwritten/p/first", context), "/newsletter/underwritten/p/first");
		assert.equal(toMountedUrl("/archive/underwritten", context), "/newsletter/underwritten/");
		assert.equal(toMountedUrl("/archive/underwritten/feed?x=1", context), "/newsletter/underwritten/feed.xml?x=1");
		assert.equal(toMountedUrl("/archive/other/p/first", context), "/newsletter/underwritten/archive/other/p/first");
	});

	test("srcset candidates each get the mount path", () => {
		assert.equal(
			toMountedSrcset("/_next/image?url=%2Fa.png&w=640&q=75 640w, /_next/image?url=%2Fa.png&w=1080&q=75 1080w, https://cdn.example.com/b.png 2x", context),
			"/newsletter/underwritten/_next/image?url=%2Fa.png&w=640&q=75 640w, /newsletter/underwritten/_next/image?url=%2Fa.png&w=1080&q=75 1080w, https://cdn.example.com/b.png 2x"
		);
	});

	test("a redirect's Location moves off the upstream's host and onto the mount", () => {
		const options = { ...context, upstreamOrigin: "https://underwritten.flockstackmail.com" };
		assert.equal(toMountedLocation("/p/first", options), "/newsletter/underwritten/p/first");
		assert.equal(toMountedLocation("https://underwritten.flockstackmail.com/p/first?x=1", options), "/newsletter/underwritten/p/first?x=1");
		assert.equal(toMountedLocation("https://checkout.stripe.com/c/pay", options), "https://checkout.stripe.com/c/pay");
	});

	test("the build's files named in scripts and component data get the mount path, nothing else does", () => {
		const flight = 'self.__next_f.push([1,"2:\\"/_next/static/chunks/a.js\\"\\n:HL[\\"/_next/static/chunks/b.css\\",\\"style\\"]\\n"]); var x = "/api/visit"; url(/_next/static/media/f.woff2)';
		assert.equal(
			toMountedAssetRefs(flight, "/n"),
			'self.__next_f.push([1,"2:\\"/n/_next/static/chunks/a.js\\"\\n:HL[\\"/n/_next/static/chunks/b.css\\",\\"style\\"]\\n"]); var x = "/api/visit"; url(/n/_next/static/media/f.woff2)'
		);
		assert.equal(getChunkBaseScript("/newsletter/underwritten"), '<script>self.TURBOPACK_CHUNK_BASE_PATH="/newsletter/underwritten/_next/"</script>');
	});

	test("the component data stream finds a name cut between two chunks", async () => {
		const text = '0:["$","script",null,{"src":"/_next/static/chunks/a.js"}]\n1:I[1,["/_next/static/chunks/b.js"],"x"]\n';
		for (let cut = 1; cut < text.length; cut += 1) {
			const chunks = [text.slice(0, cut), text.slice(cut)].map((part) => new TextEncoder().encode(part));
			const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }).pipeThrough(createAssetRefStream("/n"));
			assert.equal(await new Response(stream).text(), toMountedAssetRefs(text, "/n"), `cut at ${cut}`);
		}
	});

	test("an asset path under /archive/<slug> is the app's own", () => {
		assert.equal(getMountedAssetPath("/archive/underwritten/_next/static/chunks/a.js"), "/_next/static/chunks/a.js");
		assert.equal(getMountedAssetPath("/archive/underwritten/_next/image"), "/_next/image");
		assert.equal(getMountedAssetPath("/archive/underwritten/p/first"), null);
		assert.equal(getMountedAssetPath("/_next/static/a.js"), null);
	});
});

describe("the mount's token", () => {
	test("is kept as a hash, and only the current one matches without a rotation", () => {
		const token = createMountToken();
		assert.match(token, /^fsm_[A-Za-z0-9_-]{43}$/);
		const mount = { url: MOUNT, tokenHash: hashMountToken(token) };
		assert.notEqual(mount.tokenHash, token);
		assert.equal(matchMountToken(mount, token), "current");
		assert.equal(matchMountToken(mount, ` ${token} `), "current");
		assert.equal(matchMountToken(mount, createMountToken()), null);
		assert.equal(matchMountToken(mount, ""), null);
		assert.equal(matchMountToken(mount, "fsm_short"), null);
		assert.equal(matchMountToken(null, token), null);
	});

	test("a rotation leaves the previous one working for 24 hours, and not a moment more", () => {
		const now = Date.parse("2026-10-28T12:00:00Z");
		const previous = createMountToken();
		const current = createMountToken();
		const mount = { url: MOUNT, tokenHash: hashMountToken(current), previousTokenHash: hashMountToken(previous), previousUntil: new Date(now + MOUNT_TOKEN_OVERLAP_MS) };
		assert.equal(MOUNT_TOKEN_OVERLAP_MS, 24 * 60 * 60 * 1000);
		assert.equal(matchMountToken(mount, current, now), "current");
		assert.equal(matchMountToken(mount, previous, now), "previous");
		assert.equal(matchMountToken(mount, previous, now + MOUNT_TOKEN_OVERLAP_MS - 1), "previous");
		assert.equal(matchMountToken(mount, previous, now + MOUNT_TOKEN_OVERLAP_MS), null);
		assert.equal(matchMountToken(mount, current, now + MOUNT_TOKEN_OVERLAP_MS * 10), "current");
	});
});

describe("a reader page's own requests", () => {
	test("go under data-base when the Worker set one, and to the page's host when it didn't", () => {
		const previous = globalThis.document;
		try {
			globalThis.document = { documentElement: { dataset: {} } };
			assert.equal(withReaderBase("/api/visit"), "/api/visit");
			assert.equal(getReaderPathname("/archive/underwritten"), "/archive/underwritten");
			globalThis.document = { documentElement: { dataset: { base: "/newsletter/underwritten" } } };
			assert.equal(withReaderBase("/api/reader-translation"), "/newsletter/underwritten/api/reader-translation");
			assert.equal(getReaderPathname("/newsletter/underwritten"), "/");
			assert.equal(getReaderPathname("/newsletter/underwritten/p/first"), "/p/first");
			assert.equal(getReaderPathname("/newsletter/underwrittenx/p/first"), "/newsletter/underwrittenx/p/first");
			assert.deepEqual(buildVisit({ slug: "underwritten", pathname: getReaderPathname("/newsletter/underwritten/"), referrer: "" }), { n: "underwritten", kind: "home" });
		} finally {
			globalThis.document = previous;
		}
	});

	test("every fetch and beacon of the reader pages reads the base", () => {
		for (const [file, path] of [["components/TrackVisit.jsx", "/api/visit"], ["components/TrackView.jsx", "/api/views"], ["components/TrackRecommendations.jsx", "/api/recommendations/impression"], ["components/ReaderTranslation.jsx", "/api/reader-translation"]]) {
			const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
			assert.match(source, new RegExp(`withReaderBase\\("${path.replaceAll("/", "\\/")}"\\)`), file);
			assert.doesNotMatch(source, new RegExp(`(fetch|sendBeacon\\?\\.)\\("${path.replaceAll("/", "\\/")}"`), file);
		}
	});
});
