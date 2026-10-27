import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { cache } from "react";
import { isDeletionPending } from "@/lib/account-state";
import { AUTH_MODELS, createAccount, ensureAccount, findAccountBySessionToken, findAliasUser, findUser, isUserAllowed } from "@/lib/accounts";
import { sendAlert } from "@/lib/alerts";
import { APPLE_AUDIENCE, getAppleClientSecret, isAppleEnabled, renewAppleClientSecret } from "@/lib/apple-signin";
import { createJwksKeyring } from "@/lib/auth-keyring";
import { getVersionedSecrets, resignCookieHeader } from "@/lib/auth-secrets";
import { APP_NAME, getAdminEmails, getAppSecret, getAppUrl, isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { noticeDeletedBefore } from "@/lib/deletion-records";
import { isDisposableDomain } from "@/lib/disposable-domains";
import { CONNECTION_CLAIM, CONSENT_PATH, OAUTH_SCOPES, canRegisterRedirectUris, getMcpResource, getOAuthIssuer } from "@/lib/oauth-rules";
import { sendDeletionCode, sendSigninCode } from "@/lib/platform-email";
import { FREE_GUARDS } from "@/lib/plans";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { getCookiePrefix } from "@/lib/region";
import { siteExtensions } from "@/lib/site-extensions";
import { hasSessionCookie } from "@/lib/website-routing";
import Account from "@/models/Account";

export { isAppleEnabled };

// The error code a refused sign-in carries, also on Google's and Apple's callback redirects to /signin.
export const SIGNIN_NOT_ALLOWED = "email_not_allowed";
export const SIGNIN_NOT_ALLOWED_MESSAGE = "This email can't sign in to this server. Ask its admin to add it to ALLOWED_EMAILS.";

// What /signin and the code form say for each refused sign-up, by its code.
export const SIGNUP_ERRORS = {
	[SIGNIN_NOT_ALLOWED]: SIGNIN_NOT_ALLOWED_MESSAGE,
	email_alias: "An account already uses this inbox under another address. Sign in with that address instead.",
	email_disposable: "Throwaway inboxes can't sign up. Use your own email.",
	email_unverified: "This email isn't verified. Sign in with a code instead.",
	signup_limit: "Too many new accounts from your network today. Try again tomorrow.",
	signup_busy: "FlockStack isn't opening new accounts for the rest of today. Try again tomorrow.",
};

// FlockStack Cloud: new accounts per IP address, whatever the email, and in all, a day (FREE_GUARDS in lib/plans.js: every
// new account starts on the Free plan, which draws spammers).
const SIGNUPS_PER_IP = { name: "signup-ip", limit: FREE_GUARDS.signupsPerIpPerDay, window: "1 d" };
const SIGNUPS_PER_DAY = { name: "signup-day", limit: FREE_GUARDS.signupsPerDay, window: "1 d", key: "all" };

export function getSignupError(code) {
	return Object.hasOwn(SIGNUP_ERRORS, code ?? "") ? SIGNUP_ERRORS[code] : null;
}

// Codes are sent and checked by server actions with the app's own rate limits (app/signin/actions.js,
// app/(account)/account/actions.js), so the plugin's HTTP routes stay closed, and so do the password routes it
// adds. The account page changes the name and photo, checked there.
const DISABLED_PATHS = [
	"/email-otp/send-verification-otp",
	"/email-otp/check-verification-otp",
	"/email-otp/verify-email",
	"/sign-in/email-otp",
	"/email-otp/request-password-reset",
	"/forget-password/email-otp",
	"/email-otp/reset-password",
	"/email-otp/request-email-change",
	"/email-otp/change-email",
	"/update-user",
];

// Deleting an account takes a code of its own: Better Auth's email-verification kind, which nothing else here sends,
// so a sign-in code can't delete an account and a deletion code can't sign in.
const DELETION_CODE = "email-verification";
const CODE_EMAILS = { "sign-in": sendSigninCode, [DELETION_CODE]: sendDeletionCode };

// Client and consent management that only the consent page and the API keys page do, on the server. The JWT
// plugin's session token (/token) would be signed with the same key as access tokens. Discovery lists the rest.
const OAUTH_DISABLED_PATHS = [
	"/token",
	"/oauth2/consent",
	"/oauth2/continue",
	"/oauth2/create-client",
	"/oauth2/get-client",
	"/oauth2/get-clients",
	"/oauth2/update-client",
	"/oauth2/client/rotate-secret",
	"/oauth2/delete-client",
	"/oauth2/public-client",
	"/oauth2/public-client-prelogin",
	"/oauth2/get-consent",
	"/oauth2/get-consents",
	"/oauth2/update-consent",
	"/oauth2/delete-consent",
];

// An idle connection signs out after this; every refresh starts it again.
const REFRESH_TOKEN_SECONDS = 90 * 24 * 3600;

const REGISTRATIONS_PER_IP = { name: "oauth-registrations", limit: 10, window: "1 h" };

// Better Auth checks a registered app's redirect URIs as a web app's, https only. So it registers the https ones,
// and the app's own scheme from the allowlist (cursor://) is added to the client once it exists, by the after
// hook, which runs on the same request.
const appSchemeRedirects = new WeakMap();

// Better Auth's own packages (it, its plugins, the OAuth provider with its signing and certificate code) are the largest part of
// what this module pulls in, and a request without a session never needs them: they load when the first one does (getAuth), and
// the hooks below, which only run inside Better Auth, read APIError from here.
let APIError;
// The prefix of the session cookie Better Auth was built with, which getSession looks for before it asks anything.
let sessionCookiePrefix;

// Better Auth logs a failed send and carries on, so the sign-in form would say a code is on its way.
// The failure travels back to sendSigninCodeEmail through this.
const codeDelivery = new AsyncLocalStorage();

export function isGoogleEnabled() {
	return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function refuseSignup(code) {
	throw new APIError("FORBIDDEN", { code, message: SIGNUP_ERRORS[code] });
}

// A self-hosted server lets only its allowlist in (lib/config.js), however they sign in: every new user and
// every new session are checked here, so no Better Auth route can get around it. A hook that returns false
// cancels the write, so these return nothing.
function refuseUnlessAllowed(user) {
	if (isCloud() || isUserAllowed(user)) return;
	refuseSignup(SIGNIN_NOT_ALLOWED);
}

// FlockStack Cloud: one account per inbox, none on a throwaway inbox, and a few new ones a day per network, with a
// code, Google or Apple. It runs once one of them proved the address, so it tells nobody else about an account.
// Accounts that exist already are left as they are.
async function refuseFarmedSignup(user, ctx) {
	if (!isCloud()) return;
	if (isDisposableDomain(user.email.split("@")[1])) refuseSignup("email_disposable");
	if (await findAliasUser(user.email)) refuseSignup("email_alias");
	const ip = ctx?.headers ? getClientIp(ctx.headers) : "unknown";
	if (ip !== "unknown" && (await isRateLimited({ ...SIGNUPS_PER_IP, key: ip }))) refuseSignup("signup_limit");
	if (await isRateLimited(SIGNUPS_PER_DAY)) refuseSignup("signup_busy");
}

// An address Google or Apple hasn't verified may be someone else's, who would later sign in with a code to the account
// it opened, and find the apps it connected still there. Apple's private relay addresses count as verified.
async function checkNewUser(user, ctx) {
	if (!user.emailVerified) refuseSignup("email_unverified");
	refuseUnlessAllowed(user);
	await refuseFarmedSignup(user, ctx);
}

async function refuseSessionUnlessAllowed(session) {
	if (!isCloud()) refuseUnlessAllowed(await findUser(session.userId));
}

// Runs in the sign-in's server action or Google's or Apple's callback, once per new user: a returning one creates none.
async function openAccount(user) {
	if (!(await createAccount(user.id))) return;
	await siteExtensions.sendGoalOnNextPage("signup_completed");
	await noticeDeletedBefore(user.email);
}

async function deliverCode({ email, otp, type }) {
	const send = CODE_EMAILS[type];
	if (!send) return;
	try {
		await send({ email, code: otp });
	} catch (error) {
		const delivery = codeDelivery.getStore();
		if (delivery) delivery.error = error;
		throw error;
	}
}

// The consent an access token comes from, named in the token (lib/oauth.js checks it on every MCP request).
async function bindToConsent({ ctx, user, client }) {
	if (!user) return {};
	const consent = await ctx.context.adapter.findOne({
		model: "oauthConsent",
		where: [
			{ field: "clientId", value: client.clientId },
			{ field: "userId", value: user.id },
		],
	});
	return consent ? { [CONNECTION_CLAIM]: consent.id } : {};
}

// Dynamic registration (RFC 7591) is for Grok Bot: every redirect URI on the allowlist (lib/oauth-rules.js), and a
// public client, which PKCE then protects. A backchannel_logout_uri would have this server post to it at sign-out.
async function checkRegistration(ctx) {
	if (await isRateLimited({ ...REGISTRATIONS_PER_IP, key: getClientIp(ctx.headers) })) {
		throw new APIError("TOO_MANY_REQUESTS", { error: "rate_limited", error_description: "Too many registrations from this address. Try again in an hour." });
	}
	const { redirect_uris: redirectUris, token_endpoint_auth_method: authMethod, backchannel_logout_uri: logoutUri } = ctx.body ?? {};
	if (!canRegisterRedirectUris(redirectUris)) {
		throw new APIError("BAD_REQUEST", {
			error: "invalid_redirect_uri",
			error_description: "These redirect URIs can't register here. Identify the app with a client metadata document.",
		});
	}
	if (authMethod !== "none" || logoutUri !== undefined) {
		throw new APIError("BAD_REQUEST", {
			error: "invalid_client_metadata",
			error_description: "Register a public client: token_endpoint_auth_method none, with PKCE, and no backchannel_logout_uri.",
		});
	}
	const webRedirects = redirectUris.filter((uri) => uri.startsWith("https://"));
	if (webRedirects.length === 0 || webRedirects.length === redirectUris.length || !ctx.request) return;
	appSchemeRedirects.set(ctx.request, redirectUris);
	return { context: { body: { ...ctx.body, redirect_uris: webRedirects } } };
}

async function addAppSchemeRedirects(ctx) {
	const redirectUris = ctx.request && appSchemeRedirects.get(ctx.request);
	const client = ctx.context.returned;
	if (!redirectUris || !client?.client_id) return;
	await ctx.context.adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: client.client_id }], update: { redirectUris } });
	return ctx.json({ ...client, redirect_uris: redirectUris });
}

// Better Auth registers an OAuth client and links it to /mcp in one transaction, and creates a collection's
// indexes on its first write. Created inside that transaction, MongoDB refuses the write (SnapshotUnavailable),
// so the first app to connect to a new database would fail. A write that matches nothing creates them first.
async function createRegistrationIndexes(auth) {
	const { adapter } = await auth.$context;
	await Promise.all(
		["oauthClient", "oauthClientResource"].map((model) =>
			adapter.updateMany({ model, where: [{ field: "clientId", value: "" }], update: { createdAt: new Date() } })
		)
	);
}

function getSocialProviders() {
	const providers = {};
	if (isGoogleEnabled()) {
		providers.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, prompt: "select_account" };
	}
	if (isAppleEnabled()) {
		providers.apple = {
			clientId: process.env.APPLE_CLIENT_ID,
			// Apple's secret is a JWT that expires (lib/apple-signin.js), and this instance lives as long as the isolate.
			// Better Auth reads clientSecret from this object, synchronously, each time it builds Apple's URL or trades a
			// code, so a getter hands it the one getAuth() renewed.
			get clientSecret() {
				return getAppleClientSecret();
			},
		};
	}
	return providers;
}

async function createAuth() {
	const [{ betterAuth }, api, { nextCookies }, { emailOTP }, { jwt }, { cimd }, fetchClientMetadataResource, { mcp }, { passkey }, { docdbAdapter }] = await Promise.all([
		import("better-auth"),
		import("better-auth/api"),
		import("better-auth/next-js"),
		import("better-auth/plugins/email-otp"),
		import("better-auth/plugins/jwt"),
		import("@better-auth/cimd"),
		import("@/lib/cimd-fetch").then(({ getClientMetadataFetcher }) => getClientMetadataFetcher()),
		import("@better-auth/mcp"),
		import("@better-auth/passkey"),
		import("@/lib/docdb/better-auth-adapter"),
		connectDb(),
	]);
	const { createAuthMiddleware } = api;
	APIError = api.APIError;
	sessionCookiePrefix = getCookiePrefix();
	const appUrl = getAppUrl();
	const auth = betterAuth({
		appName: APP_NAME,
		baseURL: appUrl,
		// The current secret signs and encrypts; the ones in BETTER_AUTH_SECRET_PREVIOUS only read what an earlier rotation's
		// secret made (docs/AUTH-ROTATION.md). `secret` stays the current one, which Better Auth reads data written before
		// versions existed with.
		secret: getAppSecret(),
		secrets: getVersionedSecrets(),
		// A browser signed in to both regions keeps each one's cookies apart (lib/region.js).
		advanced: { cookiePrefix: getCookiePrefix() },
		database: docdbAdapter(),
		user: { modelName: AUTH_MODELS.user },
		session: { modelName: AUTH_MODELS.session },
		// No trusted providers: a Google or Apple sign-in joins an existing user only when it verified that email. Unlinking
		// the only Google or Apple account is allowed: a code by email always signs the user in (the account page refuses it
		// on a server that can't send one).
		account: { modelName: AUTH_MODELS.account, accountLinking: { allowUnlinkingAll: true } },
		verification: { modelName: AUTH_MODELS.verification },
		socialProviders: getSocialProviders(),
		// Apple posts its answer to the callback from its own origin (response_mode=form_post).
		...(isAppleEnabled() && { trustedOrigins: [APPLE_AUDIENCE] }),
		disabledPaths: [...DISABLED_PATHS, ...OAUTH_DISABLED_PATHS],
		databaseHooks: {
			user: { create: { before: checkNewUser, after: openAccount } },
			session: { create: { before: refuseSessionUnlessAllowed } },
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/oauth2/register") return checkRegistration(ctx);
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/oauth2/register") return addAppSchemeRedirects(ctx);
			}),
		},
		plugins: [
			emailOTP({ storeOTP: "hashed", sendVerificationOTP: deliverCode }),
			// Passkeys are tied to the app's own host (rpID), so a user adds one from the account page on that address.
			passkey({ rpID: new URL(appUrl).hostname, rpName: APP_NAME, origin: appUrl }),
			// Signs access and ID tokens with a key it creates and keeps in the jwks collection, encrypted with
			// BETTER_AUTH_SECRET. RS256 is the one algorithm every OpenID client verifies. The keyring re-encrypts a key
			// after a rotation, and retires one nobody can decrypt, so a new one is made instead of every token request failing.
			jwt({
				jwt: { issuer: getOAuthIssuer(appUrl) },
				jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
				adapter: { getJwks: createJwksKeyring() },
				disableSettingJwtHeader: true,
			}),
			// ChatGPT and Claude connect to /mcp with OAuth: they find this server through /.well-known, identify
			// themselves with a client metadata document (cimd below) and get tokens bound to /mcp. Grok Bot registers
			// instead (checkRegistration), and mcp() binds registered clients to /mcp too.
			mcp({
				resource: getMcpResource(appUrl),
				loginPage: "/signin",
				consentPage: CONSENT_PATH,
				// prompt=select_account lands on the consent page, which shows the account and lets people switch.
				selectAccount: { page: CONSENT_PATH, shouldRedirect: async () => false },
				scopes: OAUTH_SCOPES,
				grantTypes: ["authorization_code", "refresh_token"],
				refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				// Token requests from ChatGPT and Claude come from a few addresses for all their users. Registrations
				// have their own limit, shared by every server instance (REGISTRATIONS_PER_IP).
				rateLimit: { token: false, register: false },
				extensions: [{ claims: { accessToken: bindToConsent } }],
			}),
			cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
			nextCookies(),
		],
	});
	await createRegistrationIndexes(auth);
	return auth;
}

let authPromise;

// Built on first use, once Mongoose is connected: Better Auth shares its client. A broken Apple key only breaks
// Apple's button, never the other ways in.
export async function getAuth() {
	authPromise ??= createAuth().catch((error) => {
		authPromise = undefined;
		throw error;
	});
	if (isAppleEnabled()) {
		await renewAppleClientSecret().catch((error) => console.error("[auth] Could not sign Apple's client secret:", error.message));
	}
	return authPromise;
}

// The next getAuth() builds Better Auth again, with the secrets the environment has by then. Tests use it to rotate.
export function forgetAuth() {
	authPromise = undefined;
}

// A request's headers with the cookies Better Auth set under a previous secret signed again with the current one
// (lib/auth-secrets.js): a session survives a rotation while BETTER_AUTH_SECRET_PREVIOUS holds the old value.
function withCurrentCookies(source) {
	const cookie = source.get("cookie");
	const current = cookie ? resignCookieHeader(cookie, { prefix: sessionCookiePrefix ?? getCookiePrefix() }) : cookie;
	if (current === cookie) return source;
	const copy = new Headers(source);
	copy.set("cookie", current);
	return copy;
}

// What an OAuth or sign-in client gets when we can't answer: JSON in the OAuth error shape, and temporarily_unavailable (503), which
// clients take for "try again" and keep their tokens, where a bare 500 or an exception makes them start over with the user signing in.
function unavailable() {
	return Response.json(
		{ error: "temporarily_unavailable", error_description: "FlockStack could not answer this request. Try again in a moment." },
		{ status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } }
	);
}

// Better Auth's own routes: sessions, Google, Apple, OAuth and the discovery documents under /.well-known. Whatever goes wrong
// (the database, a key nobody can decrypt, an error Better Auth did not catch) is logged and answered with JSON, never thrown: a
// Worker that throws is a 502 from the router.
export async function handleAuthRequest(request) {
	try {
		const auth = await getAuth();
		const cookies = withCurrentCookies(request.headers);
		const response = await auth.handler(cookies === request.headers ? request : new Request(request, { headers: cookies }));
		if (response.status < 500) return response;
		console.error(`[auth] ${request.method} ${new URL(request.url).pathname} answered ${response.status}`);
		await response.body?.cancel();
		return unavailable();
	} catch (error) {
		console.error(`[auth] ${request.method} ${new URL(request.url).pathname} failed:`, error?.message ?? error);
		return unavailable();
	}
}

// For server actions that may finish an authorization request (a sign-in while ChatGPT connects, a consent):
// Better Auth resumes it from the request it runs in, and adds headers to it, so it gets a request of its own.
export async function getAuthCallContext(path) {
	const requestHeaders = new Headers(withCurrentCookies(await headers()));
	const request = new Request(new URL(`/api/auth${path}`, getAppUrl()), { method: "POST", headers: requestHeaders });
	return { headers: requestHeaders, request, asResponse: false };
}

// FlockStack's own emails failing: until it's fixed, nobody can sign in with a code. The alert waits for the response,
// so the form answers at once.
function alertCodeFailure(error) {
	const isResend = Boolean(process.env.RESEND_API_KEY);
	after(() =>
		sendAlert({
			accountId: null,
			key: "platform-email-failed",
			title: "Sign-in codes not sending",
			detail: `${String(error?.message ?? error).slice(0, 300)}.`,
			action: `Nobody can sign in with a code until it's fixed: check ${isResend ? "Resend's key, domain and quota" : "EMAIL_FROM and the email provider"}.`,
			...(isResend && { link: "https://resend.com/emails" }),
		})
	);
}

async function sendCodeEmail(email, type) {
	const auth = await getAuth();
	const delivery = {};
	await codeDelivery.run(delivery, () => auth.api.sendVerificationOTP({ body: { email, type } }));
	if (!delivery.error) return;
	alertCodeFailure(delivery.error);
	throw delivery.error;
}

export function sendSigninCodeEmail(email) {
	return sendCodeEmail(email, "sign-in");
}

export function sendDeletionCodeEmail(email) {
	return sendCodeEmail(email, DELETION_CODE);
}

// Each code works once, for 5 minutes, and dies after 3 wrong tries (Better Auth's emailOTP).
export async function checkDeletionCode(email, code) {
	const { APIError: BetterAuthError } = await import("better-auth/api");
	try {
		await (await getAuth()).api.verifyEmailOTP({ body: { email, otp: code } });
		return true;
	} catch (error) {
		if (error instanceof BetterAuthError) return false;
		throw error;
	}
}

// The current session and its cookie, then every other session of the user, on every device.
export async function signOutEverywhere(userId) {
	const auth = await getAuth();
	await auth.api.signOut({ headers: withCurrentCookies(await headers()) });
	await (await auth.$context).internalAdapter.deleteUserSessions(String(userId));
}

// An account's purge: the user with its sessions, its sign-in methods (Google, Apple) and its codes waiting to be used.
export async function deleteUser({ id, email }) {
	const { internalAdapter } = await (await getAuth()).$context;
	for (const type of Object.keys(CODE_EMAILS)) await internalAdapter.deleteVerificationByIdentifier(`${type}-otp-${email}`);
	await internalAdapter.deleteUser(String(id));
}

// Headers first: reading them makes the page dynamic, so builds never prerender it or reach the database.
// Someone taken off a self-hosted server's allowlist is signed out from then on.
export const getSession = cache(async () => {
	const requestHeaders = withCurrentCookies(await headers());
	// No session cookie, no session: a signed-out visit (the sign-in page, a shared link) has nothing to ask Better Auth, which
	// would be started, with its plugins and a query, for that answer.
	if (!hasSessionCookie(requestHeaders.get("cookie"), sessionCookiePrefix ?? getCookiePrefix())) return null;
	const auth = await getAuth();
	const session = await auth.api.getSession({ headers: requestHeaders });
	return session && (isCloud() || isUserAllowed(session.user)) ? session : null;
});

export function isAdmin(user) {
	return Boolean(user?.emailVerified && getAdminEmails().includes(String(user.email).toLowerCase()));
}

async function guessAccount() {
	const cookie = (await headers()).get("cookie") ?? "";
	const name = `${sessionCookiePrefix ?? getCookiePrefix()}.session_token`;
	for (const part of cookie.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key !== name && key !== `__Secure-${name}`) continue;
		let value = rest.join("=");
		try {
			value = decodeURIComponent(value);
		} catch {
			return null;
		}
		return findAccountBySessionToken(value.split(".")[0]);
	}
	return null;
}

// The signed-in user and their account. The account is created here if the sign-up hook didn't run.
export const getCurrentAccount = cache(async () => {
	// The account is looked for from the session cookie while Better Auth validates the session, and used only if that session is the
	// same owner's (below): one round trip fewer in the chain every dashboard request starts with.
	const guess = guessAccount().catch(() => null);
	const session = await getSession();
	if (!session?.user) {
		return null;
	}
	const guessed = await guess;
	const account = (guessed && String(guessed.ownerId) === String(session.user.id) ? guessed : null) ?? (await Account.findOne({ ownerId: session.user.id }).lean()) ?? (await ensureAccount(session.user.id));
	const cookie = (await headers()).get("cookie") ?? "";
	const selected = /(?:^|;\s*)flockstack\.workspace=([a-f0-9]{24})(?:;|$)/.exec(cookie)?.[1];
	const team = selected && selected !== String(account._id) ? await (await import("@/lib/team")).resolveTeamAccount(session.user, selected) : null;
	return { user: session.user, account: team || account };
});

// Server actions run outside proxy.js matching rules, so each one checks the session itself. The dashboard
// opens without a plan; the actions that need one check it (lib/actions/run-action.js). An account waiting to be
// deleted only opens the page that restores it.
export async function requireAccount() {
	const current = await getCurrentAccount();
	if (!current) redirect("/signin");
	if (isDeletionPending(current.account)) redirect("/restore");
	return current;
}

export async function requirePersonalAccount() {
	const current = await getCurrentAccount();
	if (!current) redirect("/signin");
	const account = String(current.account.ownerId) === String(current.user.id) ? current.account : await Account.findOne({ ownerId: current.user.id }).lean() ?? await ensureAccount(current.user.id);
	if (isDeletionPending(account)) redirect("/restore");
	return { user: current.user, account };
}

export async function requireAdmin() {
	const session = await getSession();
	if (!isAdmin(session?.user)) notFound();
	return session.user;
}
