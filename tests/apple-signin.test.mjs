import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decodeProtectedHeader, jwtVerify } from "jose";
import mongoose from "@/lib/docdb";
import { as, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

// Sign in with Apple: the client secret FlockStack signs from the .p8 key, Better Auth's provider, the button, and
// Apple's side of a sign-in played in memory: the authorize redirect, Apple's form post to the callback from its own
// origin, then the code traded at Apple's token endpoint for an ID token. Nothing reaches Apple.
const APP_URL = "http://localhost:3000";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const APPLE_ENV = {
	APPLE_CLIENT_ID: "com.example.flockstack.signin",
	APPLE_TEAM_ID: "TEAM123456",
	APPLE_KEY_ID: "KEY1234567",
	APPLE_PRIVATE_KEY: PEM,
};
const NO_APPLE = { APPLE_CLIENT_ID: "", APPLE_TEAM_ID: "", APPLE_KEY_ID: "", APPLE_PRIVATE_KEY: "" };

let app;
let m;
let nextIp = 0;

const visitor = () => ({ jar: new Map(), ip: `198.51.100.${++nextIp}` });
const cookieOf = (person) => [...person.jar].map(([name, value]) => `${name}=${value}`).join("; ");
const users = () => mongoose.connection.db.collection("users");

function idToken(claims) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const payload = { iss: "https://appleid.apple.com", aud: APPLE_ENV.APPLE_CLIENT_ID, iat: now, exp: now + 600, ...claims };
	return [encode({ alg: "RS256", kid: "apple-test" }), encode(payload), "c2lnbmF0dXJl"].join(".");
}

// A browser through Apple: the button's redirect, Apple's form post (with `user` only the first time), Better Auth's
// redirect of it to its own GET callback, and that callback trading the code. Returns where it ended and what Apple was sent.
async function signInWithApple({ sub, email, verified = true, user = null }) {
	const person = visitor();
	const toApple = new URL(await as(person, () => catchRedirect(m.signin.signinWithApple(form({ next: "/" })))));
	assert.equal(`${toApple.origin}${toApple.pathname}`, "https://appleid.apple.com/auth/authorize");
	const posted = new URLSearchParams({ code: "apple-code", state: toApple.searchParams.get("state"), ...(user && { user: JSON.stringify(user) }) });
	const formPost = new Request(`${APP_URL}/api/auth/callback/apple`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com", cookie: cookieOf(person) },
		body: posted,
	});
	const redirected = await as(person, () => m.authRoute.POST(formPost));
	assert.equal(redirected.status, 302);
	const callback = new URL(redirected.headers.get("location"));
	assert.equal(callback.pathname, "/api/auth/callback/apple");

	const tokenRequests = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		if (String(input?.url ?? input) !== APPLE_TOKEN_URL) return previousFetch(input, init);
		tokenRequests.push(new URLSearchParams(String(init.body)));
		return Response.json({ access_token: "apple-access", token_type: "Bearer", expires_in: 3600, refresh_token: "apple-refresh", id_token: idToken({ sub, email, email_verified: verified }) });
	};
	try {
		const response = await as(person, () => m.authRoute.GET(new Request(callback, { headers: { cookie: cookieOf(person) } })));
		const location = new URL(response.headers.get("location"), APP_URL);
		const sessions = response.headers.getSetCookie().filter((line) => line.startsWith("better-auth.session_token=") && !line.startsWith("better-auth.session_token=;"));
		return { path: location.pathname, error: location.searchParams.get("error"), isSignedIn: sessions.length > 0, tokenRequests, toApple };
	} finally {
		globalThis.fetch = previousFetch;
	}
}

function renderSignin(env) {
	return withEnv(env, () =>
		runWithRequest({ jar: new Map(), headers: {} }, async () => renderToStaticMarkup(await m.signinPage.default({ searchParams: Promise.resolve({ region: "us" }) })))
	);
}

before(async () => {
	app = await startTestApp({ GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret", ...APPLE_ENV });
	m = {
		apple: await import("../lib/apple-signin.js"),
		auth: await import("../lib/auth.js"),
		signin: await import("../app/signin/actions.js"),
		signinPage: await import("../app/signin/page.js"),
		authRoute: await import("../app/api/auth/[...all]/route.js"),
		button: await import("../components/ButtonSigninApple.jsx"),
	};
});

after(() => app?.stop());

describe("Apple's client secret", () => {
	test("is an ES256 JWT signed with the .p8 key, for Apple, from the team, about the Services ID, for a day", async () => {
		const token = await m.apple.renewAppleClientSecret();
		assert.deepEqual(decodeProtectedHeader(token), { alg: "ES256", kid: APPLE_ENV.APPLE_KEY_ID });
		const { payload } = await jwtVerify(token, publicKey, { algorithms: ["ES256"], issuer: APPLE_ENV.APPLE_TEAM_ID, audience: "https://appleid.apple.com", subject: APPLE_ENV.APPLE_CLIENT_ID });
		assert.equal(payload.exp - payload.iat, 24 * 3600);
		assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 5);
		assert.ok(payload.exp - payload.iat <= 180 * 24 * 3600, "Apple refuses secrets that last more than 6 months");
		assert.equal(Buffer.from(token.split(".")[2], "base64url").length, 64, "r and s side by side, not DER");
		assert.equal(m.apple.getAppleClientSecret(), token);
	});

	test("takes the key pasted on one line with literal \\n", async () => {
		await withEnv({ APPLE_PRIVATE_KEY: PEM.trim().replace(/\n/g, "\\n") }, async () => {
			const token = await m.apple.renewAppleClientSecret();
			await jwtVerify(token, publicKey, { algorithms: ["ES256"] });
		});
	});

	test("is kept until an hour before it expires, then signed again; a new key signs a new one at once", async () => {
		const start = Date.now();
		mock.timers.enable({ apis: ["Date"], now: start });
		try {
			const first = await m.apple.renewAppleClientSecret();
			assert.equal(await m.apple.renewAppleClientSecret(), first);
			mock.timers.setTime(start + 22 * 3600 * 1000);
			assert.equal(await m.apple.renewAppleClientSecret(), first, "22 hours in, still fresh");
			mock.timers.setTime(start + 23.5 * 3600 * 1000);
			const renewed = await m.apple.renewAppleClientSecret();
			assert.notEqual(renewed, first);
			assert.equal((await jwtVerify(renewed, publicKey, { currentDate: new Date(start + 23.5 * 3600 * 1000) })).payload.iat, Math.floor((start + 23.5 * 3600 * 1000) / 1000));
			const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
			await withEnv({ APPLE_PRIVATE_KEY: other.privateKey.export({ type: "pkcs8", format: "pem" }) }, async () => {
				assert.equal(m.apple.getAppleClientSecret(), undefined, "never the old key's secret");
				const rotated = await m.apple.renewAppleClientSecret();
				await jwtVerify(rotated, other.publicKey, { currentDate: new Date(start + 23.5 * 3600 * 1000) });
			});
		} finally {
			mock.timers.reset();
		}
	});

	test("isAppleEnabled needs all four variables", async () => {
		assert.equal(m.apple.isAppleEnabled(), true);
		assert.equal(m.auth.isAppleEnabled, m.apple.isAppleEnabled);
		for (const name of Object.keys(APPLE_ENV)) await withEnv({ [name]: "" }, () => assert.equal(m.apple.isAppleEnabled(), false, name));
		await withEnv(NO_APPLE, () => assert.equal(m.apple.isAppleEnabled(), false));
	});

	test("a broken key breaks Apple only: Better Auth still answers", async () => {
		const errors = mock.method(console, "error", () => {});
		try {
			await withEnv({ APPLE_PRIVATE_KEY: "not a key" }, async () => {
				const auth = await m.auth.getAuth();
				assert.ok(auth.handler);
				assert.equal(m.apple.getAppleClientSecret(), undefined);
			});
			assert.match(String(errors.mock.calls[0]?.arguments[0]), /Apple's client secret/);
		} finally {
			errors.mock.restore();
		}
	});
});

describe("Better Auth's Apple provider", () => {
	test("is configured with the Services ID, trusts Apple's form post, and sends people back to /api/auth/callback/apple", async () => {
		const context = await (await m.auth.getAuth()).$context;
		const apple = context.socialProviders.find(({ id }) => id === "apple");
		assert.ok(apple);
		assert.equal(apple.options.clientId, APPLE_ENV.APPLE_CLIENT_ID);
		assert.equal(apple.options.clientSecret, m.apple.getAppleClientSecret());
		assert.ok(context.trustedOrigins.includes("https://appleid.apple.com"));
		assert.deepEqual(context.options.account.accountLinking, undefined, "no trusted providers");

		const { toApple } = await signInWithApple({ sub: "001000.config", email: "config@example.com" });
		assert.equal(toApple.searchParams.get("client_id"), APPLE_ENV.APPLE_CLIENT_ID);
		assert.equal(toApple.searchParams.get("redirect_uri"), `${APP_URL}/api/auth/callback/apple`);
		assert.equal(toApple.searchParams.get("response_mode"), "form_post");
		assert.deepEqual(toApple.searchParams.get("scope").split(" ").sort(), ["email", "name"]);
	});

	test("a first sign-in opens the user with the name Apple sends once, and trades the code with a fresh client secret", async () => {
		const first = await signInWithApple({ sub: "001000.jo", email: "jo.apple@example.com", user: { name: { firstName: "Jo", lastName: "Apple" }, email: "jo.apple@example.com" } });
		assert.deepEqual([first.path, first.error, first.isSignedIn], ["/", null, true]);
		const [sent] = first.tokenRequests;
		assert.equal(sent.get("client_id"), APPLE_ENV.APPLE_CLIENT_ID);
		assert.equal(sent.get("redirect_uri"), `${APP_URL}/api/auth/callback/apple`);
		await jwtVerify(sent.get("client_secret"), publicKey, { algorithms: ["ES256"], audience: "https://appleid.apple.com", issuer: APPLE_ENV.APPLE_TEAM_ID });
		const user = await users().findOne({ email: "jo.apple@example.com" });
		assert.equal(user.name, "Jo Apple");
		assert.equal(user.emailVerified, true);

		const again = await signInWithApple({ sub: "001000.jo", email: "jo.apple@example.com" });
		assert.equal(again.isSignedIn, true);
		assert.equal(await users().countDocuments({ email: "jo.apple@example.com" }), 1);
		assert.equal((await users().findOne({ email: "jo.apple@example.com" })).name, "Jo Apple", "later sign-ins carry no name and keep it");
	});

	test("no name is fine, and a private relay address becomes the account's email", async () => {
		const relay = "x7k2m9p4q1@privaterelay.appleid.com";
		const result = await signInWithApple({ sub: "001000.hidden", email: relay, verified: "true" });
		assert.deepEqual([result.path, result.isSignedIn], ["/", true]);
		const user = await users().findOne({ email: relay });
		assert.equal(user.name, "");
		assert.equal(user.emailVerified, true);
	});

	test("joins the user who owns the email only when Apple verified it", async () => {
		const owner = await signIn("owner.apple@example.com");
		const takeover = await signInWithApple({ sub: "001000.attacker", email: "owner.apple@example.com", verified: false });
		assert.equal(takeover.isSignedIn, false);
		assert.equal(takeover.path, "/signin");
		assert.equal(await mongoose.connection.db.collection("auth_accounts").countDocuments({ providerId: "apple", accountId: "001000.attacker" }), 0);

		const linked = await signInWithApple({ sub: "001000.owner", email: "owner.apple@example.com", verified: "true" });
		assert.equal(linked.isSignedIn, true);
		const account = await mongoose.connection.db.collection("auth_accounts").findOne({ providerId: "apple", accountId: "001000.owner" });
		assert.equal(String(account.userId), String(owner.userId), "same user");

		const unverifiedNew = await signInWithApple({ sub: "001000.school", email: "school@example.com", verified: "false" });
		assert.deepEqual([unverifiedNew.error, unverifiedNew.isSignedIn], ["email_unverified", false]);
		assert.equal(await users().countDocuments({ email: "school@example.com" }), 0);
	});

	// Better Auth skips its origin check under NODE_ENV=test, so this turns it back on.
	test("with the origin check on, Apple's form post passes and one from any other origin is refused", async () => {
		const context = await (await m.auth.getAuth()).$context;
		const skipped = context.skipOriginCheck;
		context.skipOriginCheck = false;
		const post = (origin) =>
			m.authRoute.POST(
				new Request(`${APP_URL}/api/auth/callback/apple`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: "region=us" },
					body: new URLSearchParams({ code: "c", state: "s" }),
				})
			);
		try {
			assert.equal((await post("https://appleid.apple.com")).status, 302);
			assert.equal((await post("https://evil.example")).status, 403);
		} finally {
			context.skipOriginCheck = skipped;
		}
	});

	test("the action sends people back to /signin when Apple isn't set up", async () => {
		await withEnv(NO_APPLE, async () => assert.equal(await as(visitor(), () => catchRedirect(m.signin.signinWithApple(form({ next: "/" })))), "/signin"));
	});
});

describe("the Continue with Apple button", () => {
	test("follows Apple's guidelines: black on light pages, white on dark ones, Apple's logo and wording", () => {
		const markup = renderToStaticMarkup(createElement(m.button.default, { next: "/campaigns", oauthQuery: "client_id=x&sig=y" }));
		assert.match(markup, /aria-label="Continue with Apple"/);
		assert.match(markup, />Continue with Apple<\/button>/);
		const classes = /<button[^>]*class="([^"]*)"/.exec(markup)[1].split(" ");
		for (const name of ["h-11", "w-full", "bg-black", "text-white", "dark:bg-white", "dark:text-black"]) assert.ok(classes.includes(name), name);
		assert.match(markup, /<svg[^>]*aria-hidden="true"[^>]*fill="currentColor"[^>]*><path d="M12\.152 6\.896/);
		assert.match(markup, /name="next" value="\/campaigns"/);
		assert.match(markup, /name="oauth_query" value="client_id=x&amp;sig=y"/);
	});

	test("shows on /signin below Google, the same height, only when Apple is set up", async () => {
		const markup = await renderSignin({});
		const google = markup.indexOf("Continue with Google");
		const apple = markup.indexOf("Continue with Apple</button>");
		assert.ok(google > 0 && apple > google, "Apple comes after Google");
		assert.match(markup, /<button[^>]*class="[^"]*h-11[^"]*"[^>]*>(?:(?!<\/button>).)*Continue with Google/);

		const without = await renderSignin(NO_APPLE);
		assert.doesNotMatch(without, /Continue with Apple/);
		assert.match(without, /Continue with Google/);

		const appleOnly = await renderSignin({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
		assert.match(appleOnly, /Continue with Apple/);
		assert.doesNotMatch(appleOnly, /Continue with Google/);
		assert.match(appleOnly, />or</);
	});
});
