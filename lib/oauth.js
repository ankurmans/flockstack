import "server-only";
import { createResourceServerChallenge, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import {
	createDpopReplayStore,
	createInsufficientScopeError,
	enforceDpopBinding,
	isDpopBindingError,
	parseAccessTokenAuthorization,
	verifyJwsAccessToken,
} from "better-auth/oauth2";
import { errors as joseErrors } from "jose";
import { getPresetOfScopes, getPresetsUpTo } from "@/lib/action-scopes";
import { isDeletionPending } from "@/lib/account-state";
import { ensureAccount, findUser, isUserAllowed } from "@/lib/accounts";
import { shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { getAuth, getAuthCallContext } from "@/lib/auth";
import { getAppUrl, isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { OAUTH_MODELS, collection, findClients, toConnection, toObjectId } from "@/lib/oauth-apps";
import {
	ACCESS_SCOPES,
	CONNECTION_CLAIM,
	MCP_SCOPE,
	describeClient,
	getMcpResource,
	getOAuthIssuer,
	pickSignedOAuthQuery,
	readOAuthQuery,
} from "@/lib/oauth-rules";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";

const ACCESS_TOKEN_TYPE = "at+jwt";
const SIGN_IN_MESSAGE = "Connect with OAuth, or send an API key: Authorization: Bearer <key>";

export function createUnauthorizedError(message, error = "invalid_token") {
	return new APIError("UNAUTHORIZED", { message, error, error_description: message });
}

// The access token's claims, once its signature, issuer, audience (/mcp), expiry, DPoP proof if it's bound to a
// key, and scope check out. The signing keys come from the database through Better Auth, not over HTTP.
async function verifyAccessToken(request) {
	const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
	if (!authorization?.token || authorization.scheme === "Unknown") throw createUnauthorizedError(SIGN_IN_MESSAGE);
	const auth = await getAuth();
	const appUrl = getAppUrl();
	let payload;
	try {
		payload = await verifyJwsAccessToken(authorization.token, {
			jwksFetch: () => auth.api.getJwks(),
			jwksCacheKey: auth,
			verifyOptions: { issuer: getOAuthIssuer(appUrl), audience: getMcpResource(appUrl), typ: ACCESS_TOKEN_TYPE },
		});
	} catch (error) {
		if (error instanceof joseErrors.JOSEError || error instanceof TypeError) throw createUnauthorizedError("The access token is invalid or expired");
		throw error;
	}
	try {
		await enforceDpopBinding({
			payload,
			authorization,
			proofJwt: request.headers.get("dpop"),
			method: request.method,
			url: request.url,
			replayStore: createDpopReplayStore((await auth.$context).internalAdapter),
		});
	} catch (error) {
		if (isDpopBindingError(error)) throw createUnauthorizedError(error.message, error.code);
		throw error;
	}
	if (!String(payload.scope ?? "").split(" ").some((scope) => ACCESS_SCOPES.includes(scope))) throw createInsufficientScopeError([MCP_SCOPE]);
	return payload;
}

// The consent (connected app) the token names, if it's still there for the token's user and app.
async function findConnection(payload) {
	const [id, userId, clientId] = [payload[CONNECTION_CLAIM], payload.sub, payload.azp ?? payload.client_id];
	if (![id, userId].every((value) => isObjectIdString(String(value ?? ""))) || typeof clientId !== "string") return null;
	return collection(OAUTH_MODELS.consent).findOne({ _id: toObjectId(id), userId: toObjectId(userId), clientId });
}

// The account an MCP request with an OAuth token works in: the token's user's, while the app stays connected.
// Fails with Better Auth's errors, which getOAuthChallenge turns into a 401 or 403 that clients act on.
export async function authenticateAccessToken(request) {
	const payload = await verifyAccessToken(request);
	await connectDb();
	const consent = await findConnection(payload);
	if (!consent) throw createUnauthorizedError("This app was disconnected. Connect it again.");
	const user = await findUser(payload.sub);
	// On a self-hosted server, an owner taken off the allowlist takes their connections with them.
	if (!user || (!isCloud() && !isUserAllowed(user))) throw createUnauthorizedError("This account can't sign in anymore");
	const account = (await Account.findOne({ ownerId: user._id }).lean()) ?? (await ensureAccount(user._id));
	if (isDeletionPending(account)) throw createUnauthorizedError("This account is being deleted");

	const now = new Date();
	if (shouldTouchLastUsed(consent.lastUsedAt, now.getTime())) {
		await collection(OAUTH_MODELS.consent)
			.updateOne({ _id: consent._id }, { $set: { lastUsedAt: now } })
			.catch((error) => console.error("[oauth] Could not update lastUsedAt:", error.message));
	}
	const scopes = String(payload.scope).split(" ");
	return {
		account,
		user: { id: String(user._id), email: user.email },
		connection: toConnection(consent, scopes),
		scopes,
		expiresAt: payload.exp,
	};
}

// The consent (connected app) of an account's owner, as the guard and the approval queue see it. Null once it is disconnected.
export async function getConnection(account, id) {
	await connectDb();
	const consent = isObjectIdString(String(id)) ? await collection(OAUTH_MODELS.consent).findOne({ _id: toObjectId(id), userId: toObjectId(account.ownerId) }) : null;
	return consent ? toConnection(consent) : null;
}

// The access the owner chose on the consent page and the app's name, kept on the consent Better Auth just made. access is a
// preset the request's scopes allow, else it is ignored.
export async function saveConsentAccess({ account, query, access }) {
	await connectDb();
	const { clientId, redirectUri, scopes } = readOAuthQuery(query);
	if (!clientId) return;
	const [client] = await findClients([clientId]);
	const consent = await collection(OAUTH_MODELS.consent).findOne({ userId: toObjectId(account.ownerId), clientId });
	if (!consent) return;
	const allowed = getPresetOfScopes(scopes) ?? "full";
	const set = { flockstackClientName: describeClient(client, redirectUri).name, flockstackLevel: getPresetsUpTo(allowed).includes(access) ? access : allowed };
	await collection(OAUTH_MODELS.consent).updateOne({ _id: consent._id }, { $set: set });
}

// The WWW-Authenticate challenge (and status) for a failed MCP request, pointing at the protected resource
// metadata, so ChatGPT and Claude find the authorization server and sign the user in. Null for other errors.
export function getOAuthChallenge(error) {
	const challenge = createResourceServerChallenge(error, getMcpResource(getAppUrl()), { challengeScopes: [MCP_SCOPE] });
	if (!challenge) return null;
	return { status: challenge.statusCode, header: new Headers(challenge.headers).get("www-authenticate") };
}

// The authorization request Better Auth sent to the sign-in or consent page, if its signature holds and it
// hasn't expired (10 minutes), with the app asking.
export async function readOAuthRequest(searchParams) {
	const query = pickSignedOAuthQuery(searchParams);
	if (!query) return null;
	const auth = await getAuth();
	if (!(await verifyOAuthQueryParams(query, (await auth.$context).secret))) return { query, isExpired: true };
	const { clientId, redirectUri, scopes } = readOAuthQuery(query);
	await connectDb();
	const [client] = clientId ? await findClients([clientId]) : [];
	return { query, isExpired: false, redirectUri, scopes, client: describeClient(client, redirectUri) };
}

// Allow or deny, then where the browser goes: back to the app, with a code or with access_denied.
export async function answerConsent({ query, accept }) {
	const auth = await getAuth();
	const result = await auth.api.oauth2Consent({ body: { accept, oauth_query: query }, ...(await getAuthCallContext("/oauth2/consent")) });
	return result?.url ?? null;
}

export { disconnectAllApps, hasConnectedApp, listConnectedApps, revokeConnectedApp } from "@/lib/oauth-apps";
