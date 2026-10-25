import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import mongoose from "@/lib/docdb";
import { activate, startTestApp, withEnv } from "./helpers/app.mjs";
import { AGENT, APP_URL, MCP_URL, createOAuthHarness, loadOAuthRoutes } from "./helpers/oauth-flow.mjs";
import { forgetAuth } from "../lib/auth.js";
import { getSecretVersion } from "../lib/auth-secrets.js";

// Rotating BETTER_AUTH_SECRET under MCP clients (Claude Code, Codex, ChatGPT): what keeps working with the old value in
// BETTER_AUTH_SECRET_PREVIOUS, and what happens to an OAuth signing key nobody can decrypt (docs/AUTH-ROTATION.md).
const A = "secret-A-for-rotation-tests-0123456789abcdef";
const B = "secret-B-for-rotation-tests-fedcba9876543210";
const C = "secret-C-for-rotation-tests-a1b2c3d4e5f60789";
const JWKS_URL = `${APP_URL}/api/auth/jwks`;

let app;
let h;
let m;
let visitor = 0;

// The environment of a deployment whose BETTER_AUTH_SECRET is current, and whose BETTER_AUTH_SECRET_PREVIOUS is previous (or unset).
function deploy({ current, previous }) {
	process.env.BETTER_AUTH_SECRET = current;
	if (previous) process.env.BETTER_AUTH_SECRET_PREVIOUS = previous;
	else delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
	forgetAuth();
}

// A signed-in owner with a connected app: the tokens it holds, and the browser's cookies.
async function connected(email) {
	const user = await h.customer(email);
	await activate(user);
	const { client, provider } = await h.connectApp(user);
	await client.close();
	return { user, provider, tokens: provider.saved.tokens };
}

function refresh(tokens) {
	return h.postToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: AGENT.clientId, resource: MCP_URL });
}

async function listJwks() {
	const response = await h.appFetch(JWKS_URL);
	return { status: response.status, keys: (await response.json()).keys };
}

before(async () => {
	app = await startTestApp({ BETTER_AUTH_SECRET: A });
	m = await loadOAuthRoutes();
	h = createOAuthHarness(m);
});

// Each test starts with no signing key, so it makes the one it looks at.
beforeEach(() => mongoose.connection.db.collection("jwks").deleteMany({}));

after(() => {
	delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
	return app?.stop();
});

describe("rotating with the old secret in BETTER_AUTH_SECRET_PREVIOUS", () => {
	test("tokens, refresh, sessions and the signing key all carry on, and the key outlives the old value", async () => {
		deploy({ current: A });
		const { user, tokens } = await connected("rotate-previous@example.com");
		const [row] = await mongoose.connection.db.collection("jwks").find({}).toArray();
		assert.match(JSON.parse(row.privateKey), /^\$ba\$\d+\$/, "the key is written with a secret version");
		assert.equal(JSON.parse(row.privateKey).split("$")[2], String(getSecretVersion(A)));

		deploy({ current: B, previous: A });
		const verified = await h.mcpRequest(tokens.access_token);
		assert.equal(verified.status, 200, "the token the client holds still verifies at /mcp");

		const refreshed = await refresh(tokens);
		assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
		assert.equal((await h.mcpRequest(refreshed.body.access_token)).status, 200, "the token the refresh issued verifies too");
		assert.equal((await mongoose.connection.db.collection("jwks").countDocuments()), 1, "the same signing key: nothing to make again");
		const [rewrapped] = await mongoose.connection.db.collection("jwks").find({}).toArray();
		assert.equal(JSON.parse(rewrapped.privateKey).split("$")[2], String(getSecretVersion(B)), "encrypted with the new secret now");

		// The browser's session was signed with A: it still signs the user in, so a new authorization goes through without the sign-in page.
		const { challenge } = h.pkce();
		const callback = await h.authorizeInBrowser(user, h.authorizationUrl(AGENT, { challenge }));
		assert.equal(callback.origin, new URL(AGENT.redirectUri).origin, "the consent was kept: the request went straight back to the app");
		assert.ok(callback.searchParams.get("code"));

		// Later the old value goes: the key was already encrypted with the new secret, so refresh still works. The session, if it
		// was not used in between, is gone with it.
		deploy({ current: B });
		const again = await refresh({ refresh_token: refreshed.body.refresh_token });
		assert.equal(again.status, 200, JSON.stringify(again.body));
		assert.equal((await mongoose.connection.db.collection("jwks").countDocuments()), 1);
	});

	test("a key written before versions existed is encrypted again with the new secret", async () => {
		deploy({ current: A });
		const { tokens } = await connected("rotate-legacy@example.com");
		const rows = mongoose.connection.db.collection("jwks");
		// How production's key looks: bare hex, no version.
		const [row] = await rows.find({}).sort({ createdAt: -1 }).toArray();
		const { symmetricDecrypt, symmetricEncrypt } = await import("better-auth/crypto");
		const secretConfig = { keys: new Map([[getSecretVersion(A), A]]), currentVersion: getSecretVersion(A) };
		const plain = await symmetricDecrypt({ key: secretConfig, data: JSON.parse(row.privateKey) });
		await rows.updateOne({ _id: row._id }, { $set: { privateKey: JSON.stringify(await symmetricEncrypt({ key: A, data: plain })) } });
		assert.doesNotMatch(JSON.parse((await rows.findOne({ _id: row._id })).privateKey), /^\$ba\$/);

		deploy({ current: B, previous: A });
		const first = await refresh(tokens);
		assert.equal(first.status, 200, JSON.stringify(first.body));
		assert.match(JSON.parse((await rows.findOne({ _id: row._id })).privateKey), /^\$ba\$\d+\$/);
		deploy({ current: B });
		assert.equal((await refresh({ refresh_token: first.body.refresh_token })).status, 200);
		assert.equal(await rows.countDocuments(), 1);
	});
});

describe("rotating without it, or with a key nobody can decrypt", () => {
	test("the key is retired, a new one signs, and tokens already issued still verify", async () => {
		deploy({ current: A });
		const { user, tokens } = await connected("rotate-dead-key@example.com");
		const before = await listJwks();
		assert.equal(before.keys.length, 1);

		deploy({ current: C });
		const errors = [];
		const original = console.error;
		console.error = (...args) => errors.push(args.join(" "));
		let refreshed;
		try {
			refreshed = await refresh(tokens);
			await refresh({ refresh_token: refreshed.body.refresh_token });
		} finally {
			console.error = original;
		}
		assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
		assert.equal(errors.filter((line) => line.includes("can't be decrypted")).length, 1, "one clear line, once");
		assert.match(errors.find((line) => line.includes("can't be decrypted")), /BETTER_AUTH_SECRET_PREVIOUS/);

		const { challenge } = h.pkce();
		const signedOut = await h.authorizeInBrowser(user, h.authorizationUrl(AGENT, { challenge }));
		assert.equal(signedOut.pathname, "/signin", "without the previous secret the browser's session is gone: the user signs in again");

		const after = await listJwks();
		assert.equal(after.keys.length, 2, "the old public key stays listed");
		assert.ok(after.keys.some((key) => key.kid === before.keys[0].kid));
		assert.equal((await h.mcpRequest(tokens.access_token)).status, 200, "a token signed with the retired key verifies");
		assert.equal((await h.mcpRequest(refreshed.body.access_token)).status, 200, "and so does one signed with the new key");
		const newHeader = JSON.parse(Buffer.from(refreshed.body.access_token.split(".")[0], "base64url").toString());
		assert.notEqual(newHeader.kid, before.keys[0].kid);
	});
});

describe("when something fails", () => {
	test("the OAuth and sign-in routes answer JSON, not an exception", async () => {
		await withEnv({ BETTER_AUTH_SECRET: "" }, async () => {
			delete process.env.BETTER_AUTH_SECRET;
			forgetAuth();
			const original = console.error;
			console.error = () => {};
			try {
				for (const [path, init] of [
					["/api/auth/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=x" }],
					["/.well-known/oauth-authorization-server", {}],
					["/api/auth/jwks", {}],
				]) {
					const response = await h.appFetch(`${APP_URL}${path}`, init);
					assert.equal(response.status, 503, path);
					assert.equal(response.headers.get("retry-after"), "5");
					assert.deepEqual((await response.json()).error, "temporarily_unavailable", path);
				}
			} finally {
				console.error = original;
			}
		});
		forgetAuth();
	});

	test("/mcp answers a 503 in the API's error shape when it can't check a token", async () => {
		deploy({ current: A });
		const { tokens } = await connected("rotate-mcp-503@example.com");
		await withEnv({ BETTER_AUTH_SECRET: "" }, async () => {
			delete process.env.BETTER_AUTH_SECRET;
			forgetAuth();
			const original = console.error;
			console.error = () => {};
			try {
				const { status, headers, body } = await h.mcpRequest(tokens.access_token);
				assert.equal(status, 503);
				assert.equal(body.error.code, "unavailable");
				assert.equal(headers.get("retry-after"), "5");
			} finally {
				console.error = original;
			}
		});
		deploy({ current: A });
	});
});
