import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import mongoose from "@/lib/docdb";
import { as, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// The account page's sign-in methods: the Google and Apple accounts linked to the user (Better Auth's account records),
// connected with Better Auth's linkSocial and unlinked with its unlink. Apple's side is played in memory, as in
// apple-signin.test.mjs; nothing reaches Apple or Google.
const APP_URL = "http://localhost:3000";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_ENV = {
	APPLE_CLIENT_ID: "com.example.flockstack.signin",
	APPLE_TEAM_ID: "TEAM123456",
	APPLE_KEY_ID: "KEY1234567",
	APPLE_PRIVATE_KEY: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }),
};

let app;
let m;
const cookieOf = (person) => [...person.jar].map(([name, value]) => `${name}=${value}`).join("; ");
const linkedTo = (user) => mongoose.connection.db.collection("auth_accounts").find({ userId: user.userId }).toArray();

function idToken(claims) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const payload = { iss: "https://appleid.apple.com", aud: APPLE_ENV.APPLE_CLIENT_ID, iat: now, exp: now + 600, ...claims };
	return [encode({ alg: "RS256", kid: "apple-test" }), encode(payload), "c2lnbmF0dXJl"].join(".");
}

// Connect Apple from the account page: the action's redirect to Apple, Apple's form post back, Better Auth's redirect to its
// GET callback and the code traded for an ID token with this sub and email. Returns where the user lands.
async function connectApple(user, { sub, email = user.email, verified = true }) {
	const toApple = new URL(await as(user, () => catchRedirect(m.account.connectSignin(form({ provider: "apple" })))));
	assert.equal(`${toApple.origin}${toApple.pathname}`, "https://appleid.apple.com/auth/authorize");
	const formPost = new Request(`${APP_URL}/api/auth/callback/apple`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com", cookie: cookieOf(user) },
		body: new URLSearchParams({ code: "apple-code", state: toApple.searchParams.get("state") }),
	});
	const callback = new URL((await as(user, () => m.authRoute.POST(formPost))).headers.get("location"));
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		if (String(input?.url ?? input) !== APPLE_TOKEN_URL) return previousFetch(input, init);
		return Response.json({ access_token: "apple-access", token_type: "Bearer", expires_in: 3600, id_token: idToken({ sub, email, email_verified: verified }) });
	};
	try {
		const response = await as(user, () => m.authRoute.GET(new Request(callback, { headers: { cookie: cookieOf(user) } })));
		return new URL(response.headers.get("location"), APP_URL);
	} finally {
		globalThis.fetch = previousFetch;
	}
}

function renderPage(user, searchParams = {}) {
	return as(user, async () =>
		renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.accountPage.default({ searchParams: Promise.resolve(searchParams) })))
	);
}

before(async () => {
	app = await startTestApp({ GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret", ...APPLE_ENV });
	m = {
		account: await import("../app/(account)/account/actions.js"),
		accountPage: await import("../app/(account)/account/page.js"),
		authRoute: await import("../app/api/auth/[...all]/route.js"),
		rules: await import("../lib/signin-methods.js"),
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
	};
});

after(() => app?.stop());

describe("sign-in methods", () => {
	test("a code-only user sees Connect Google and Connect Apple, and that a code always works", async () => {
		const user = await signIn("methods@example.com");
		const html = await renderPage(user);
		assert.match(html, /Sign-in methods/);
		assert.match(html, /Connect Google/);
		assert.match(html, /Connect Apple/);
		assert.match(html, /A code sent to <span[^>]*>methods@example\.com<\/span> always signs you in too/);
		assert.doesNotMatch(html, /Unlink/);

		const toGoogle = new URL(await as(user, () => catchRedirect(m.account.connectSignin(form({ provider: "google" })))));
		assert.equal(`${toGoogle.origin}${toGoogle.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
		assert.equal(toGoogle.searchParams.get("redirect_uri"), `${APP_URL}/api/auth/callback/google`);
		assert.ok(toGoogle.searchParams.get("state"));
		assert.equal(await as(user, () => catchRedirect(m.account.connectSignin(form({ provider: "github" })))), "/account");
	});

	test("connecting Apple with the same email links it, and the page lists it with Unlink", async () => {
		const user = await signIn("link-apple@example.com");
		const landed = await connectApple(user, { sub: "001000.link" });
		assert.equal(`${landed.pathname}${landed.search}`, "/account?connected=apple");
		const [linked] = await linkedTo(user);
		assert.deepEqual([linked.providerId, linked.accountId], ["apple", "001000.link"]);

		const html = await renderPage(user, { connected: "apple" });
		assert.match(html, /Apple is connected\. You can sign in with it now\./);
		assert.match(html, />Unlink</);
		assert.match(html, /Connect Google/, "Google is still there to connect");
		assert.doesNotMatch(html, /Connect Apple/);
	});

	test("an Apple ID with another email, or that signs in someone else, isn't linked, and the page says why", async () => {
		const owner = await signIn("apple-owner@example.com");
		await connectApple(owner, { sub: "001000.owned" });
		const user = await signIn("link-other@example.com");

		const other = await connectApple(user, { sub: "001000.other", email: "x7k2@privaterelay.appleid.com" });
		assert.deepEqual([other.pathname, other.searchParams.get("connect"), other.searchParams.get("error")], ["/account", "apple", "email_does_not_match"]);
		const html = await renderPage(user, Object.fromEntries(other.searchParams));
		assert.match(html, /That Apple account uses another email\. Connect one that uses link-other@example\.com\. If Apple asks, share your email rather than hide it\./);

		const taken = await connectApple(user, { sub: "001000.owned" });
		assert.equal(taken.searchParams.get("error"), "account_already_linked_to_different_user");
		assert.deepEqual(m.rules.describeConnectResult({ connect: "apple", error: "account_already_linked_to_different_user", email: user.email }), {
			isError: true,
			text: "That Apple account already signs in to another FlockStack account.",
		});
		assert.equal((await linkedTo(user)).length, 0);
		assert.equal((await linkedTo(owner)).length, 1, "the owner keeps theirs");
	});

	test("unlinking the only one works, and a code still signs the same user in", async () => {
		const user = await signIn("unlink@example.com");
		await connectApple(user, { sub: "001000.unlink" });
		const [linked] = await linkedTo(user);

		const someone = await signIn("unlink-someone@example.com");
		assert.deepEqual(await as(someone, () => m.account.unlinkSignin(null, form({ id: String(linked._id) }))), {
			error: "This sign-in method isn't connected any more. Reload the page.",
		});
		assert.deepEqual(await as(user, () => m.account.unlinkSignin(null, form({ id: String(linked._id) }))), { ok: true, name: "Apple" });
		assert.equal((await linkedTo(user)).length, 0);

		const again = await signIn("unlink@example.com");
		assert.equal(String(again.userId), String(user.userId), "the same user, by code");
		assert.match(await renderPage(again), /Connect Apple/);
	});

	test("a session over a day old signs in again first", async () => {
		const user = await signIn("stale@example.com");
		await connectApple(user, { sub: "001000.stale" });
		const [linked] = await linkedTo(user);
		await mongoose.connection.db.collection("sessions").updateMany({ userId: user.userId }, { $set: { createdAt: new Date(Date.now() - 2 * 864e5) } });
		assert.deepEqual(await as(user, () => m.account.unlinkSignin(null, form({ id: String(linked._id) }))), {
			error: "To unlink Apple, sign out and sign in again first. It takes a sign-in from the last day.",
		});
		assert.equal((await linkedTo(user)).length, 1);
	});

	test("on a server that can't send codes, the last one stays", async () => {
		const user = await signIn("no-codes@example.com");
		await connectApple(user, { sub: "001000.nocodes" });
		const [linked] = await linkedTo(user);
		const noEmail = { RESEND_API_KEY: "", SES_ACCESS_KEY_ID: "", SES_SECRET_ACCESS_KEY: "", POSTSHIBA_API_KEY: "" };
		const refused = await withEnv(noEmail, () => as(user, () => m.account.unlinkSignin(null, form({ id: String(linked._id) }))));
		assert.deepEqual(refused, { error: "This server can't send sign-in codes, so Apple is your only way in. Keep it connected." });
		assert.equal((await linkedTo(user)).length, 1);
	});

	test("without Google or Apple set up and nothing linked, the card isn't there", async () => {
		const user = await signIn("plain@example.com");
		const off = { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", APPLE_CLIENT_ID: "", APPLE_TEAM_ID: "", APPLE_KEY_ID: "", APPLE_PRIVATE_KEY: "" };
		assert.doesNotMatch(await withEnv(off, () => renderPage(user)), /Sign-in methods/);
	});
});
