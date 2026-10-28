import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { Miniflare } from "miniflare";
import { toMountedRequestUrl } from "../lib/mount-rules.js";

// lib/mount-rewrite.js runs HTMLRewriter, which only the Workers runtime has: the page goes through it in a local workerd
// (Miniflare), with the same three files the Worker bundles. Nothing reaches the network.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/_next/static/chunks/site.css">
<link rel="preload" as="image" imagesrcset="/_next/image?url=%2Fa.png&amp;w=640&amp;q=75 640w, /_next/image?url=%2Fa.png&amp;w=1080&amp;q=75 1080w">
<link rel="canonical" href="https://example.com/newsletter/underwritten/p/first">
<script src="/_next/static/chunks/turbopack.js" async></script>
</head><body>
<a href="/archive/underwritten/p/second">Second</a>
<a href="https://example.org/elsewhere">Elsewhere</a>
<a href="#comments">Comments</a>
<img src="//cdn.example.com/logo.png" alt="">
<img srcset="/_next/image?url=%2Fb.png&amp;w=640&amp;q=75 1x, https://cdn.example.com/b.png 2x" src="/_next/image?url=%2Fb.png&amp;w=640&amp;q=75" alt="">
<form action="/reader/signin" method="post"><button formaction="/unsubscribe?token=abc">Leave</button></form>
<video poster="/poster.png"></video>
<style>@font-face{src:url(/_next/static/media/f.woff2)}</style>
<script>self.__next_f.push([1,"2:\\"/_next/static/chunks/a.js\\"\\n:HL[\\"/_next/static/chunks/site.css\\",\\"style\\"]\\n"])</script>
</body></html>`;

const WORKER = `import { rewriteMountedResponse } from "./lib/mount-rewrite.js";
export default {
	async fetch(request) {
		const url = new URL(request.url);
		const context = { mountPath: "/newsletter/underwritten", slug: "underwritten", upstreamOrigin: "https://underwritten.flockstackmail.com" };
		const headers = { "x-flockstack-mounted": "/newsletter/underwritten", "x-flockstack-mounted-slug": "underwritten", "content-length": "1" };
		if (url.pathname === "/page") return rewriteMountedResponse(new Response(await request.text(), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } }), context);
		if (url.pathname === "/rsc") return rewriteMountedResponse(new Response(await request.text(), { headers: { ...headers, "content-type": "text/x-component" } }), context);
		if (url.pathname === "/redirect") return rewriteMountedResponse(new Response(null, { status: 307, headers: { ...headers, location: "https://underwritten.flockstackmail.com/p/first?x=1" } }), context);
		return rewriteMountedResponse(new Response("{}", { headers: { ...headers, "content-type": "application/json" } }), context);
	},
};`;

let mf;
before(async () => {
	mf = new Miniflare({
		workers: [
			{
				config: {
					name: "mount-rewrite",
					compatibilityDate: "2026-09-01",
					manifest: {
						mainModule: "index.mjs",
						modules: {
							"index.mjs": { type: "esm", contents: WORKER },
							"lib/mount-rewrite.js": { type: "esm", contents: read("lib/mount-rewrite.js") },
							"lib/mount-rules.js": { type: "esm", contents: read("lib/mount-rules.js") },
							"lib/webhook-url.js": { type: "esm", contents: read("lib/webhook-url.js") },
						},
					},
				},
			},
		],
	});
	await mf.ready;
});
after(() => mf?.dispose());

describe("a mounted page", () => {
	let html;
	let response;
	before(async () => {
		response = await mf.dispatchFetch("http://localhost/page", { method: "POST", body: PAGE });
		html = await response.text();
	});

	test("has its root-relative assets, links, forms, srcsets and posters under the mount path", () => {
		assert.match(html, /<link rel="stylesheet" href="\/newsletter\/underwritten\/_next\/static\/chunks\/site\.css">/);
		assert.match(html, /<script src="\/newsletter\/underwritten\/_next\/static\/chunks\/turbopack\.js" async>/);
		assert.match(html, /imagesrcset="\/newsletter\/underwritten\/_next\/image\?url=%2Fa\.png&amp;w=640&amp;q=75 640w, \/newsletter\/underwritten\/_next\/image\?url=%2Fa\.png&amp;w=1080&amp;q=75 1080w"/);
		assert.match(html, /srcset="\/newsletter\/underwritten\/_next\/image\?url=%2Fb\.png&amp;w=640&amp;q=75 1x, https:\/\/cdn\.example\.com\/b\.png 2x"/);
		assert.match(html, /<form action="\/newsletter\/underwritten\/reader\/signin" method="post">/);
		assert.match(html, /formaction="\/newsletter\/underwritten\/unsubscribe\?token=abc"/);
		assert.match(html, /poster="\/newsletter\/underwritten\/poster\.png"/);
		assert.match(html, /<a href="\/newsletter\/underwritten\/p\/second">/, "an /archive/<slug> path takes the host's shape first");
	});

	test("leaves absolute, protocol-relative and fragment URLs alone", () => {
		assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/newsletter\/underwritten\/p\/first">/);
		assert.match(html, /<a href="https:\/\/example\.org\/elsewhere">/);
		assert.match(html, /<a href="#comments">/);
		assert.match(html, /<img src="\/\/cdn\.example\.com\/logo\.png" alt="">/);
	});

	test("names the build's files under the mount path in its scripts and styles, and tells Turbopack and the page's own requests where it is", () => {
		assert.match(html, /<html lang="en" data-base="\/newsletter\/underwritten">/);
		assert.match(html, /<head><script>self\.TURBOPACK_CHUNK_BASE_PATH="\/newsletter\/underwritten\/_next\/"<\/script><meta charset="utf-8">/);
		assert.ok(html.includes('2:\\"/newsletter/underwritten/_next/static/chunks/a.js\\"'), html);
		assert.ok(html.includes(':HL[\\"/newsletter/underwritten/_next/static/chunks/site.css\\"'), html);
		assert.ok(html.includes("url(/newsletter/underwritten/_next/static/media/f.woff2)"));
		assert.doesNotMatch(html, /["'(]\/_next\//, "no file is asked of the owner's site");
	});

	test("goes out without the app's markers or a stale length", () => {
		assert.equal(response.headers.get("x-flockstack-mounted"), null);
		assert.equal(response.headers.get("x-flockstack-mounted-slug"), null);
		assert.equal(response.headers.get("content-length"), null);
	});
});

describe("other mounted answers", () => {
	test("component data for a client-side navigation names the build's files under the mount path", async () => {
		const body = '1:"/_next/static/chunks/a.js"\n2:I[1,["$1"],"default"]\n3:{"href":"https://example.com/newsletter/underwritten/p/x"}\n';
		const text = await (await mf.dispatchFetch("http://localhost/rsc", { method: "POST", body })).text();
		assert.equal(text, '1:"/newsletter/underwritten/_next/static/chunks/a.js"\n2:I[1,["$1"],"default"]\n3:{"href":"https://example.com/newsletter/underwritten/p/x"}\n');
	});

	test("a redirect to the upstream's own host lands under the mount instead", async () => {
		const response = await mf.dispatchFetch("http://localhost/redirect", { redirect: "manual" });
		assert.equal(response.status, 307);
		assert.equal(response.headers.get("location"), "/newsletter/underwritten/p/first?x=1");
	});

	test("anything else passes as it is, without the markers", async () => {
		const response = await mf.dispatchFetch("http://localhost/json");
		assert.equal(await response.text(), "{}");
		assert.equal(response.headers.get("x-flockstack-mounted"), null);
	});
});

describe("a request with a mount token, before Next.js", () => {
	test("finds the app's own files under /archive/<slug>, and loses a trailing slash", () => {
		assert.deepEqual(toMountedRequestUrl(new URL("https://app.example.net/archive/underwritten/_next/static/chunks/a.js?v=1")), { url: new URL("https://app.example.net/_next/static/chunks/a.js?v=1"), isStatic: true });
		assert.deepEqual(toMountedRequestUrl(new URL("https://app.example.net/archive/underwritten/_next/image?url=%2Fa.png&w=640")), { url: new URL("https://app.example.net/_next/image?url=%2Fa.png&w=640"), isStatic: false });
		assert.equal(toMountedRequestUrl(new URL("https://app.example.net/archive/underwritten/")).url.pathname, "/archive/underwritten");
		assert.equal(toMountedRequestUrl(new URL("https://underwritten.flockstackmail.com/p/first/?x=1")).url.href, "https://underwritten.flockstackmail.com/p/first?x=1");
		assert.equal(toMountedRequestUrl(new URL("https://underwritten.flockstackmail.com/")), null);
		assert.equal(toMountedRequestUrl(new URL("https://underwritten.flockstackmail.com/p/first")), null);
	});
});
