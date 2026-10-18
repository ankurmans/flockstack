import assert from "node:assert/strict";
import { test } from "node:test";
import { getAdminEmails, getConfigProblems, isEmailAllowed } from "../lib/config.js";
import { register } from "../instrumentation.js";

const STRONG = { BETTER_AUTH_SECRET: "s".repeat(32), SUPPRESSION_HASH_KEY: "k".repeat(32) };
const CLOUD = { ...STRONG, FLOCKSTACK_CLOUD: "true", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", RESEND_API_KEY: "re_x" };

async function withEnv(values, run) {
	const previous = { ...process.env };
	try {
		for (const name of ["FLOCKSTACK_CLOUD", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY"]) delete process.env[name];
		Object.assign(process.env, values);
		return await run();
	} finally {
		process.env = previous;
	}
}

test("BETTER_AUTH_SECRET and SUPPRESSION_HASH_KEY need 32 characters each", () => {
	assert.deepEqual(getConfigProblems(STRONG), []);
	assert.deepEqual(getConfigProblems({ ...STRONG, BETTER_AUTH_SECRET: "s".repeat(31) }), [
		"BETTER_AUTH_SECRET must be at least 32 characters (generate one with: openssl rand -base64 48).",
	]);
	assert.deepEqual(getConfigProblems({ ...STRONG, SUPPRESSION_HASH_KEY: "k".repeat(31) }), [
		"SUPPRESSION_HASH_KEY must be at least 32 characters (generate one with: openssl rand -base64 48).",
	]);
	assert.equal(getConfigProblems({}).length, 2, "missing counts as too short");
});

test("the server doesn't start with a short secret or hash key", () =>
	withEnv(STRONG, () => {
		assert.doesNotThrow(register);
		process.env.SUPPRESSION_HASH_KEY = "short";
		assert.throws(register, /FlockStack can't start\. SUPPRESSION_HASH_KEY must be at least 32 characters/);
		process.env.SUPPRESSION_HASH_KEY = STRONG.SUPPRESSION_HASH_KEY;
		process.env.BETTER_AUTH_SECRET = "short";
		assert.throws(register, /FlockStack can't start\. BETTER_AUTH_SECRET must be at least 32 characters/);
	}));

test("FlockStack Cloud needs a way to send its own emails, and Stripe is optional; a self-hosted server needs none of it", () => {
	assert.deepEqual(getConfigProblems(CLOUD), []);
	assert.deepEqual(getConfigProblems({ ...CLOUD, STRIPE_SECRET_KEY: " ", STRIPE_WEBHOOK_SECRET: " " }), [], "billing waits for a payment provider");
	assert.deepEqual(getConfigProblems({ ...CLOUD, RESEND_API_KEY: " ", SES_ACCESS_KEY_ID: "AKIAEXAMPLE" }), [], "SES is enough");
	assert.match(
		getConfigProblems({ ...CLOUD, RESEND_API_KEY: " " })[0],
		/FLOCKSTACK_CLOUD is true, so its own emails need RESEND_API_KEY, SES_ACCESS_KEY_ID or POSTSHIBA_API_KEY/
	);
	assert.match(getConfigProblems({ ...STRONG, FLOCKSTACK_CLOUD: "true" })[0], /its own emails need RESEND_API_KEY, SES_ACCESS_KEY_ID or POSTSHIBA_API_KEY/);
	assert.deepEqual(getConfigProblems(STRONG), [], "self-hosted: no Stripe, no Resend");
	assert.deepEqual(getConfigProblems({ ...STRONG, FLOCKSTACK_CLOUD: "yes" }), [], "only exactly true is the cloud");
});

test("the cloud refuses to start without a way to send its own emails, and its health check fails with the reason", async () => {
	const { GET } = await import("../app/api/health/route.js");
	await withEnv(CLOUD, async () => {
		assert.doesNotThrow(register);
		const healthy = await GET();
		assert.equal(healthy.status, 200);
		assert.deepEqual(await healthy.json(), { ok: true });
		assert.equal(healthy.headers.get("cache-control"), "no-store");

		delete process.env.RESEND_API_KEY;
		assert.throws(register, /FlockStack can't start\. FLOCKSTACK_CLOUD is true, so its own emails need RESEND_API_KEY/);
		const failing = await GET();
		assert.equal(failing.status, 503);
		const body = await failing.json();
		assert.equal(body.ok, false);
		assert.match(body.problems[0], /its own emails need RESEND_API_KEY/);
		assert.equal(JSON.stringify(body).includes("whsec_x") || JSON.stringify(body).includes("re_x"), false, "never a value");
	});
});

test("a self-hosted server signs in ALLOWED_EMAILS, its @domains and ADMIN_EMAILS, and nobody when both are empty", () => {
	const env = { ALLOWED_EMAILS: " Jane@Example.com, @Team.example.org ,", ADMIN_EMAILS: "ops@example.net" };
	for (const email of ["jane@example.com", "JANE@example.com ", "anyone@team.example.org", "ops@example.net"]) {
		assert.equal(isEmailAllowed(email, env), true, email);
	}
	for (const email of ["john@example.com", "x@sub.team.example.org", "team.example.org@evil.dev", "@team.example.org", "jane@example.com.evil.dev", "jane@", "", null]) {
		assert.equal(isEmailAllowed(email, env), false, String(email));
	}
	assert.equal(isEmailAllowed("jane@example.com", {}), false, "never open by default");
	assert.equal(isEmailAllowed("anyone@anywhere.dev", { FLOCKSTACK_CLOUD: "true" }), true, "FlockStack Cloud takes anyone");
});

test("ADMIN_EMAILS is a comma-separated list, trimmed and lowercased", () => {
	const previous = process.env.ADMIN_EMAILS;
	try {
		process.env.ADMIN_EMAILS = " Owner@Example.com, ops@example.org ,,";
		assert.deepEqual(getAdminEmails(), ["owner@example.com", "ops@example.org"]);
		delete process.env.ADMIN_EMAILS;
		assert.deepEqual(getAdminEmails(), []);
	} finally {
		if (previous === undefined) delete process.env.ADMIN_EMAILS;
		else process.env.ADMIN_EMAILS = previous;
	}
});
