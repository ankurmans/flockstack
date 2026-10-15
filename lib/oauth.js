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
import mongoose from "mongoose";
import { isDeletionPending } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { ensureAccount, findUser, isUserAllowed } from "@/lib/accounts";
import { shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { getAuth, getAuthCallContext } from "@/lib/auth";
import { getAppUrl, isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import {
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

// Better Auth's OAuth collections. A connected app is a consent: one per user and app.
const OAUTH_MODELS = {
	client: "oauthClient",
	consent: "oauthConsent",
	accessToken: "oauthAccessToken",
	refreshToken: "oauthRefreshToken",
};

const ACCESS_TOKEN_TYPE = "at+jwt";
const SIGN_IN_MESSAGE = "Connect with OAuth, or send an API key: Authorization: Bearer <key>";

function collection(name) {
	return mongoose.connection.db.collection(name);
}

function toObjectId(id) {
	return new mongoose.Types.ObjectId(String(id));
}

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
	if (!String(payload.scope ?? "").split(" ").includes(MCP_SCOPE)) throw createInsufficientScopeError([MCP_SCOPE]);
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
	return {
		account,
		user: { id: String(user._id), email: user.email },
		connection: { id: String(consent._id), clientId: consent.clientId },
		scopes: String(payload.scope).split(" "),
		expiresAt: payload.exp,
	};
}

// The WWW-Authenticate challenge (and status) for a failed MCP request, pointing at the protected resource
// metadata, so ChatGPT and Claude find the authorization server and sign the user in. Null for other errors.
export function getOAuthChallenge(error) {
	const challenge = createResourceServerChallenge(error, getMcpResource(getAppUrl()), { challengeScopes: [MCP_SCOPE] });
	if (!challenge) return null;
	return { status: challenge.statusCode, header: new Headers(challenge.headers).get("www-authenticate") };
}

function findClients(clientIds) {
	return collection(OAUTH_MODELS.client)
		.find({ clientId: { $in: clientIds } }, { projection: { clientId: 1, name: 1, redirectUris: 1 } })
		.toArray();
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

// The apps connected to an account with OAuth, newest first.
export async function listConnectedApps(account) {
	await connectDb();
	const consents = await collection(OAUTH_MODELS.consent).find({ userId: toObjectId(account.ownerId) }).sort({ createdAt: -1 }).toArray();
	const clients = new Map((await findClients([...new Set(consents.map(({ clientId }) => clientId))])).map((client) => [client.clientId, client]));
	return consents.map((consent) => ({
		id: String(consent._id),
		clientId: consent.clientId,
		...describeClient(clients.get(consent.clientId)),
		scopes: consent.scopes ?? [],
		createdAt: consent.createdAt,
		lastUsedAt: consent.lastUsedAt ?? null,
	}));
}

export async function hasConnectedApp(account) {
	await connectDb();
	return Boolean(await collection(OAUTH_MODELS.consent).findOne({ userId: toObjectId(account.ownerId) }, { projection: { _id: 1 } }));
}

// Its tokens go first, then the consent: from then on every token the app holds answers 401, and connecting
// again means a new consent.
export async function revokeConnectedApp(account, id) {
	await connectDb();
	const userId = toObjectId(account.ownerId);
	const consent = isObjectIdString(id) ? await collection(OAUTH_MODELS.consent).findOne({ _id: toObjectId(id), userId }) : null;
	if (!consent) throw actionError("not_found", "App not found");
	const tokens = { userId, clientId: consent.clientId };
	await collection(OAUTH_MODELS.accessToken).deleteMany(tokens);
	await collection(OAUTH_MODELS.refreshToken).deleteMany(tokens);
	await collection(OAUTH_MODELS.consent).deleteOne({ _id: consent._id, userId });
	return String(consent._id);
}

// Every app connected to the account, at once: when it's deleted.
export async function disconnectAllApps(account) {
	await connectDb();
	const owner = { userId: toObjectId(account.ownerId) };
	await collection(OAUTH_MODELS.accessToken).deleteMany(owner);
	await collection(OAUTH_MODELS.refreshToken).deleteMany(owner);
	await collection(OAUTH_MODELS.consent).deleteMany(owner);
}
