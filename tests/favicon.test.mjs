import assert from "node:assert/strict";
import { test } from "node:test";
import { faviconUrl } from "../lib/favicon.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LinksSocial from "../components/LinksSocial.jsx";

test("favicon URLs are encoded and sized", () => {
	assert.equal(faviconUrl("example.com", 32), "https://www.google.com/s2/favicons?domain=example.com&sz=32");
	assert.ok(faviconUrl("a b").includes("domain=a%20b"));
});

test("a publication's website link loads its current icon without waiting for Google's cache", () => {
	const html = renderToStaticMarkup(createElement(LinksSocial, { links: ["https://example.com/work", "https://github.com/example"] }));
	assert.match(html, /src="https:\/\/example\.com\/favicon\.ico"/);
	assert.match(html, /referrerPolicy="no-referrer"/i);
	assert.doesNotMatch(html, /google\.com\/s2\/favicons/);
	assert.match(html, /aria-label="example\.com"/);
	assert.match(html, /aria-label="GitHub"/);
	assert.match(html, /<svg/);
});
