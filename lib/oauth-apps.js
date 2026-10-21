import "server-only";
import { getPresetOfScopes, lowerPreset } from "@/lib/action-scopes";
import mongoose from "@/lib/docdb";
import { actionError } from "@/lib/actions/errors";
import { connectDb } from "@/lib/db";
import { describeClient } from "@/lib/oauth-rules";
import { isObjectIdString } from "@/lib/validation";

// The apps connected to an account with OAuth (a consent each), read and removed straight from the database. lib/oauth.js is the
// rest of OAuth: Better Auth, the access token checks and the consent page's steps. This is split out so the actions, the
// dashboard's checklist and an account's deletion do not load Better Auth, its signing and its plugins to list or drop a consent.

// Better Auth's OAuth collections. A connected app is a consent: one per user and app.
export const OAUTH_MODELS = {
	client: "oauthClient",
	consent: "oauthConsent",
	accessToken: "oauthAccessToken",
	refreshToken: "oauthRefreshToken",
};

export function collection(name) {
	return mongoose.connection.db.collection(name);
}

export function toObjectId(id) {
	return new mongoose.Types.ObjectId(String(id));
}

export function findClients(clientIds) {
	return collection(OAUTH_MODELS.client)
		.find({ clientId: { $in: clientIds } }, { projection: { clientId: 1, name: 1, redirectUris: 1 } })
		.toArray();
}

// What an app may do: the most its token's scopes say, and no more than the owner chose on the consent page. A consent from before
// access levels has no choice stored and keeps what its scopes gave: flockstack:full, so full access.
export function toConnection(consent, scopes = consent.scopes) {
	return {
		id: String(consent._id),
		clientId: consent.clientId,
		name: consent.flockstackClientName ?? getHostOrNull(consent.clientId) ?? "An app",
		level: lowerPreset(getPresetOfScopes(scopes) ?? "full", consent.flockstackLevel),
	};
}

function getHostOrNull(value) {
	try {
		return new URL(value).host;
	} catch {
		return null;
	}
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
		level: toConnection(consent).level,
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
