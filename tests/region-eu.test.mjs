import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

// This process is the EU Worker (FLOCKSTACK_REGION=eu, set before Better Auth is built): the cookies it sets, the session
// the proxy accepts, the API keys it issues, and the host its passkeys belong to.
const APP_URL = "https://eu.flockstack.io";
const COOKIE = /^(__Secure-)?flockstack-eu\.session_token$/;

let app;
let m;

function cookieHeader(jar) {
	return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function visit(path, cookie) {
	const request = new m.NextRequest(new URL(path, APP_URL), { headers: { host: "eu.flockstack.io", ...(cookie && { cookie }) } });
	const response = await m.proxy(request);
	return response.headers.get("x-middleware-next") ? { next: true } : { status: response.status, location: response.headers.get("location") };
}

before(async () => {
	app = await startTestApp({ FLOCKSTACK_REGION: "eu", APP_URL });
	m = {
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		auth: await import("../lib/auth.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		tokens: await import("../lib/api-key-tokens.js"),
		ApiKey: (await import("../models/ApiKey.js")).default,
	};
});

after(() => app?.stop());

describe("sessions", () => {
	test("Better Auth names its cookies with the EU prefix, never better-auth", async () => {
		const context = await (await m.auth.getAuth()).$context;
		assert.match(context.authCookies.sessionToken.name, COOKIE);
		assert.match(context.authCookies.sessionData.name, /^(__Secure-)?flockstack-eu\.session_data$/);
		assert.doesNotMatch(JSON.stringify(Object.values(context.authCookies).map(({ name }) => name)), /better-auth/);
	});

	test("signing in sets the EU session cookie, and the proxy and the pages accept only that one", async () => {
		const user = await signIn("eu-session@example.com");
		const names = [...user.jar.keys()];
		assert.ok(names.some((name) => COOKIE.test(name)), names.join());
		assert.ok(names.every((name) => !name.includes("better-auth")), names.join());

		assert.deepEqual(await visit("/campaigns", cookieHeader(user.jar)), { next: true });
		assert.equal(String((await as(user, () => m.auth.requireAccount())).account._id), String(user.accountId));

		// The US Worker's cookie, which a browser signed in to both regions also holds, opens nothing here.
		const value = [...user.jar].find(([name]) => COOKIE.test(name))[1];
		const usCookie = `better-auth.session_token=${value}`;
		assert.deepEqual(await visit("/campaigns", usCookie), { status: 307, location: `${APP_URL}/signin?next=%2Fcampaigns` });
		const foreign = { ...user, jar: new Map([["better-auth.session_token", value]]) };
		assert.equal(await as(foreign, () => catchRedirect(m.auth.requireAccount())), "/signin");
		assert.equal(await anonymous(() => catchRedirect(m.auth.requireAccount())), "/signin");
	});
});

describe("API keys", () => {
	test("keys made here start with mc_eu_, work here, and a US-format key that is not in this database does not", async () => {
		const user = await signIn("eu-keys@example.com");
		await activate(user);
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "EU key", level: "full" })));
		assert.match(key, /^mc_eu_[A-Za-z0-9_-]{43}$/);
		const stored = await m.ApiKey.findOne({ accountId: user.accountId, name: "EU key" }).lean();
		assert.match(stored.prefix, /^mc_eu_[A-Za-z0-9_-]{7}…$/);
		assert.equal(stored.hash, m.tokens.hashApiKey(key));

		assert.equal((await callApi("GET", "/api/v1/newsletters", { key })).status, 200);
		const other = await callApi("GET", "/api/v1/newsletters", { key: `mc_${"x".repeat(43)}` });
		assert.equal(other.status, 401);
		assert.equal(other.body.error.code, "unauthorized");
	});
});

describe("passkeys", () => {
	test("a passkey belongs to the host of this Worker, so one made in the other region is not offered here", async () => {
		const auth = await m.auth.getAuth();
		const options = await anonymous(() => auth.api.generatePasskeyAuthenticationOptions({ headers: new Headers() }));
		assert.equal(options.rpId, "eu.flockstack.io");
	});
});
