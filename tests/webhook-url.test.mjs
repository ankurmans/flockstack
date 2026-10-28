import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getPrivateHostProblem, getWebhookUrlProblem } from "../lib/webhook-url.js";

// The public-host guard every fetch for a customer shares (webhooks, feeds, briefings, AI keys' own servers): IPv6 forms that carry
// an IPv4 address inside are judged by it, or refused when they can never be a public address.
describe("IPv6 forms with an IPv4 address inside", () => {
	test("IPv4-compatible addresses (::a.b.c.d, ::7f00:1) are refused: deprecated, never routed, and a way to name 127.0.0.1", () => {
		for (const url of ["https://[::127.0.0.1]/x", "https://[::7f00:1]/x", "https://[::a]/x", "https://[::10.0.0.1]/x", "https://[::1.2.3.4]/x", "https://[0:0:0:0:0:0:a9fe:a9fe]/x"]) {
			assert.ok(getWebhookUrlProblem(url), url);
			assert.ok(getPrivateHostProblem(new URL(url)), url);
		}
	});

	test("6to4 (2002::/16) is judged by the IPv4 address it carries", () => {
		for (const url of ["https://[2002:7f00:1::]/x", "https://[2002:a00:1::1]/x", "https://[2002:c0a8:101::]/x", "https://[2002:a9fe:a9fe::1]/x", "https://[2002::1]/x"]) {
			assert.ok(getWebhookUrlProblem(url), url);
		}
		assert.equal(getWebhookUrlProblem("https://[2002:808:808::1]/x"), null, "8.8.8.8 inside is public");
	});

	test("what was allowed stays allowed, and what was refused stays refused", () => {
		for (const url of ["https://[2606:4700::1111]/x", "https://[::ffff:808:808]/x", "https://hooks.example.com/x", "https://8.8.8.8/x"]) assert.equal(getWebhookUrlProblem(url), null, url);
		for (const url of ["https://[::1]/x", "https://[::]/x", "https://[::ffff:127.0.0.1]/x", "https://[fd00::1]/x", "https://[fe80::1]/x", "https://[64:ff9b::1]/x"]) assert.ok(getWebhookUrlProblem(url), url);
	});
});
