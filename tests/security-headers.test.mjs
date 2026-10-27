import assert from "node:assert/strict";
import { test } from "node:test";
import nextConfig from "../next.config.mjs";
import { formatActivity } from "../lib/activity.js";

async function getHeaders() {
	const [rule] = await nextConfig.headers();
	assert.equal(rule.source, "/:path*");
	return new Headers(rule.headers.map(({ key, value }) => [key, value]));
}

test("a newsletter's signup form page alone may be framed by other sites", async () => {
	const rules = await nextConfig.headers();
	const rule = rules.find(rule => rule.source === "/embed/:id");
	assert.equal(rule.source, "/embed/:id");
	const headers = new Headers(rule.headers.map(({ key, value }) => [key, value]));
	assert.match(headers.get("content-security-policy"), /^frame-ancestors \*; object-src 'none'; base-uri 'self'/);
	assert.deepEqual(rules.filter(rule => rule.headers.some(header => header.key === "X-Frame-Options" && header.value !== "DENY")).map(rule => rule.source), ["/embed/:id"], "no other path is framed");
});

test("private group capabilities stay out of caches, referrers and search results", async () => {
	const rule = (await nextConfig.headers()).find(rule => rule.source === "/reader/groups/:path*");
	const headers = new Headers(rule.headers.map(({ key, value }) => [key, value]));
	assert.match(headers.get("cache-control"), /private, no-store/);
	assert.equal(headers.get("referrer-policy"), "no-referrer");
	assert.equal(headers.get("x-robots-tag"), "noindex, nofollow");
});

test("every response carries the CSP, HSTS and framing headers", async () => {
	const headers = await getHeaders();
	const policy = Object.fromEntries(
		headers
			.get("content-security-policy")
			.split(";")
			.map((directive) => directive.trim().split(/\s+/))
			.map(([name, ...values]) => [name, values.join(" ")])
	);
	assert.deepEqual(policy, {
		"frame-ancestors": "'none'",
		"object-src": "'none'",
		"base-uri": "'self'",
		"form-action": "'self'",
		"script-src-attr": "'none'",
	});
	assert.equal(headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains");
	assert.equal(headers.get("x-frame-options"), "DENY");
	assert.equal(headers.get("x-content-type-options"), "nosniff");
});

test("activity alerts name the IP, the country and, for logins, the browser", () => {
	assert.equal(
		formatActivity(["New login"], { ip: "203.0.113.5", country: "NL", userAgent: "Mozilla/5.0 Safari" }),
		"New login\nIP 203.0.113.5 (NL)\nMozilla/5.0 Safari"
	);
	assert.equal(
		formatActivity(["API key created: Signup form", "https://app.example.com/api-keys"], { ip: "unknown", country: null }),
		"API key created: Signup form\nhttps://app.example.com/api-keys\nIP unknown"
	);
	assert.equal(formatActivity(["New login"], { ip: "198.51.100.1", userAgent: "" }), "New login\nIP 198.51.100.1\nNo user agent");
	const long = formatActivity(["New login"], { ip: "198.51.100.1", userAgent: "x".repeat(500) });
	assert.equal(long.split("\n")[2].length, 160);
});
