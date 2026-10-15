import "server-only";

// Every call to Google for Postmaster Tools lives in this file: OAuth's consent screen and token endpoint, and the
// Postmaster Tools API v2, which replaced v1's trafficStats. Tests answer them with a mocked fetch. Errors carry Google's
// status and error code, never a token.
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://gmailpostmastertools.googleapis.com/v2";
export const POSTMASTER_SCOPE = "https://www.googleapis.com/auth/postmaster.traffic.readonly";
const TIMEOUT_MS = 15_000;
// A query answers 200 rows a page at most; a week of a few metrics fits in one.
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

// The OAuth client Google sign-in uses (lib/auth.js), with Postmaster Tools' redirect URI added to it.
function getClient() {
	const clientId = String(process.env.GOOGLE_CLIENT_ID ?? "").trim();
	const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
	if (!clientId || !clientSecret) throw new Error("Google's OAuth client is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)");
	return { clientId, clientSecret };
}

// Offline access and the consent screen every time, or Google sends no refresh token after the first connection.
export function getAuthorizationUrl({ redirectUri, state, codeChallenge }) {
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		client_id: getClient().clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: `openid email ${POSTMASTER_SCOPE}`,
		access_type: "offline",
		prompt: "consent",
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}

// OAuth answers { error: "invalid_grant", error_description }; the API { error: { code, status, message } }.
function googleError({ label, status = null, body = null, cause }) {
	const code = typeof body?.error === "string" ? body.error : typeof body?.error?.status === "string" ? body.error.status : null;
	const detail = String((typeof body?.error === "string" ? body.error_description : body?.error?.message) ?? "").slice(0, 200);
	const answer = status ? `${status}${code ? ` ${code}` : ""}` : cause?.name === "TimeoutError" ? "timed out" : "no answer";
	return Object.assign(new Error(`Google ${label}: ${answer}${detail ? ` (${detail})` : ""}`), { name: "GoogleError", status, code, cause });
}

async function call(url, { label, headers = {}, form, json }) {
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
				...headers,
			},
			body: form ? new URLSearchParams(form).toString() : JSON.stringify(json),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (cause) {
		throw googleError({ label, cause });
	}
	const text = await response.text().catch(() => "");
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	if (!response.ok) throw googleError({ label, status: response.status, body });
	return body;
}

// The consent screen's code for the tokens: the refresh token is in this answer only.
export function exchangeCode({ code, codeVerifier, redirectUri }) {
	const { clientId, clientSecret } = getClient();
	return call(TOKEN_URL, {
		label: "token",
		form: { code, code_verifier: codeVerifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" },
	});
}

export async function refreshAccessToken(refreshToken) {
	const { clientId, clientSecret } = getClient();
	const token = await call(TOKEN_URL, {
		label: "token refresh",
		form: { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" },
	});
	if (!token?.access_token) throw googleError({ label: "token refresh", status: 502, body: { error: "no_access_token" } });
	return token.access_token;
}

// domains.domainStats.query, every page. Only days with data come back.
export async function queryDomainStats({ accessToken, domain, query }) {
	const rows = [];
	let pageToken;
	for (let page = 0; page < MAX_PAGES; page++) {
		const answer = await call(`${API_URL}/domains/${encodeURIComponent(domain)}/domainStats:query`, {
			label: "Postmaster Tools",
			headers: { Authorization: `Bearer ${accessToken}` },
			json: { ...query, pageSize: PAGE_SIZE, ...(pageToken && { pageToken }) },
		});
		rows.push(...(Array.isArray(answer?.domainStats) ? answer.domainStats : []));
		pageToken = answer?.nextPageToken;
		if (!pageToken) break;
	}
	return rows;
}
