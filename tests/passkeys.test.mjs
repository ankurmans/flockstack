import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, signIn, startTestApp } from "./helpers/app.mjs";

// Passkeys: Better Auth's plugin on the document layer, tied to the app's own host.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = { auth: await import("../lib/auth.js"), authRoute: await import("../app/api/auth/[...all]/route.js") };
});

after(() => app?.stop());

describe("passkeys", () => {
	test("anyone can ask for sign-in options: a challenge for the app's own host", async () => {
		const response = await m.authRoute.GET(new Request("http://localhost:3000/api/auth/passkey/generate-authenticate-options"));
		assert.equal(response.status, 200);
		const options = await response.json();
		assert.equal(options.rpId, "localhost");
		assert.ok(options.challenge && options.challenge.length > 20);
		assert.match(response.headers.get("set-cookie") ?? "", /better-auth-passkey/, "the challenge is tied to the browser");
	});

	test("registering one needs a signed-in user", async () => {
		const anonymous = await m.authRoute.GET(new Request("http://localhost:3000/api/auth/passkey/generate-register-options"));
		assert.equal(anonymous.status, 401);

		const user = await signIn("passkey-owner@example.com");
		const response = await as(user, async () => {
			const { headers } = await import("next/headers");
			return m.authRoute.GET(new Request("http://localhost:3000/api/auth/passkey/generate-register-options", { headers: await headers() }));
		});
		assert.equal(response.status, 200);
		const options = await response.json();
		assert.equal(options.rp.id, "localhost");
		assert.equal(options.user.name, "passkey-owner@example.com");
	});

	test("a signed-in user has none to list yet", async () => {
		const user = await signIn("passkey-list@example.com");
		const response = await as(user, async () => {
			const { headers } = await import("next/headers");
			return m.authRoute.GET(new Request("http://localhost:3000/api/auth/passkey/list-user-passkeys", { headers: await headers() }));
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), []);
	});
});
