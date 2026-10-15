import crypto from "node:crypto";

// An in-memory Google for Postmaster Tools behind a mocked fetch: OAuth's token endpoint (codes with PKCE, refresh tokens)
// and the API v2's domainStats:query, as Google's references describe them. Nothing reaches the network.
export const GOOGLE_ENV = {
	GOOGLE_CLIENT_ID: "123-test.apps.googleusercontent.com",
	GOOGLE_CLIENT_SECRET: "test-google-client-secret",
	POSTMASTER_DOMAIN: "mailcheap.example",
	CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_PATTERN = /^https:\/\/gmailpostmastertools\.googleapis\.com\/v2\/domains\/([^/]+)\/domainStats:query$/;
const SCOPE = "https://www.googleapis.com/auth/postmaster.traffic.readonly";

function reply(status, body) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(code, status, message) {
	return reply(code, { error: { code, status, message } });
}

function toDay({ year, month, day }) {
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toDate(day) {
	const [year, month, date] = day.split("-").map(Number);
	return { year, month, day: date };
}

function daysOf(timeQuery) {
	if (timeQuery?.dateList) return timeQuery.dateList.dates.map(toDay);
	const days = [];
	for (const { start, end } of timeQuery?.dateRanges?.dateRanges ?? []) {
		for (let at = Date.parse(`${toDay(start)}T00:00:00Z`); at <= Date.parse(`${toDay(end)}T00:00:00Z`); at += 86_400_000) {
			days.push(new Date(at).toISOString().slice(0, 10));
		}
	}
	return days;
}

function idToken(email) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: "https://accounts.google.com", email, email_verified: true })}.signature`;
}

export function createFakeGoogle() {
	const state = {
		codes: new Map(),
		refreshTokens: new Map(),
		accessTokens: new Set(),
		// domain -> { hasAccess, days: Map(day -> { spamRate, identifiers: { [id]: rate } }) }; every domain is in the
		// connected account's Postmaster Tools until setAccess says otherwise.
		domains: new Map(),
		queries: [],
		tokenRequests: [],
		failures: [],
		// Rows a page, Google's being 200, so tests can page through a few.
		pageSize: 200,
	};

	function domain(name) {
		if (!state.domains.has(name)) state.domains.set(name, { hasAccess: true, days: new Map() });
		return state.domains.get(name);
	}

	// What Google's consent screen gives back for the URL MailCheap sent the admin to: a code bound to its PKCE challenge.
	function approve(authorizationUrl, { email = "postmaster-owner@example.com", scopes = ["openid", "email", SCOPE] } = {}) {
		const params = new URL(authorizationUrl).searchParams;
		const code = `code-${crypto.randomBytes(8).toString("hex")}`;
		state.codes.set(code, { challenge: params.get("code_challenge"), redirectUri: params.get("redirect_uri"), clientId: params.get("client_id"), email, scope: scopes.join(" ") });
		return { code, state: params.get("state") };
	}

	function issueRefreshToken(scope) {
		const token = `1//refresh-${crypto.randomBytes(12).toString("hex")}`;
		state.refreshTokens.set(token, { scope, revoked: false });
		return token;
	}

	function issueAccessToken() {
		const token = `ya29.access-${crypto.randomBytes(12).toString("hex")}`;
		state.accessTokens.add(token);
		return token;
	}

	function handleToken(body) {
		const form = new URLSearchParams(body);
		state.tokenRequests.push(Object.fromEntries(form));
		if (form.get("client_id") !== process.env.GOOGLE_CLIENT_ID || form.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET) {
			return reply(401, { error: "invalid_client", error_description: "The OAuth client was not found." });
		}
		if (form.get("grant_type") === "authorization_code") {
			const issued = state.codes.get(form.get("code"));
			state.codes.delete(form.get("code"));
			const challenge = crypto.createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
			if (!issued || issued.challenge !== challenge || issued.redirectUri !== form.get("redirect_uri")) {
				return reply(400, { error: "invalid_grant", error_description: "Bad Request" });
			}
			return reply(200, {
				access_token: issueAccessToken(),
				expires_in: 3599,
				refresh_token: issueRefreshToken(issued.scope),
				scope: issued.scope,
				token_type: "Bearer",
				id_token: idToken(issued.email),
			});
		}
		if (form.get("grant_type") === "refresh_token") {
			const known = state.refreshTokens.get(form.get("refresh_token"));
			if (!known || known.revoked) return reply(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
			return reply(200, { access_token: issueAccessToken(), expires_in: 3599, scope: known.scope, token_type: "Bearer" });
		}
		return reply(400, { error: "unsupported_grant_type" });
	}

	function valueOf(definition, entry) {
		const metric = definition.baseMetric?.standardMetric;
		if (metric === "SPAM_RATE") return entry.spamRate === undefined ? null : { doubleValue: entry.spamRate };
		if (definition.filter && !definition.filter.includes('aggregation_key_type = "ALL_DKIM"')) return null;
		const identifiers = entry.identifiers ?? {};
		if (metric === "FEEDBACK_LOOP_ID") return Object.keys(identifiers).length > 0 ? { stringList: { values: Object.keys(identifiers) } } : null;
		if (metric === "FEEDBACK_LOOP_SPAM_RATE") {
			const id = /^feedback_loop_id = "([^"]+)"/.exec(definition.filter ?? "")?.[1];
			return id && Object.hasOwn(identifiers, id) ? { doubleValue: identifiers[id] } : null;
		}
		return null;
	}

	function handleQuery(name, authorization, body) {
		state.queries.push({ domain: name, body });
		if (!state.accessTokens.has(String(authorization).replace(/^Bearer /, ""))) {
			return apiError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
		}
		const known = domain(name);
		if (!known.hasAccess) return apiError(403, "PERMISSION_DENIED", "The caller does not have permission");
		const rows = [];
		for (const day of daysOf(body.timeQuery)) {
			const entry = known.days.get(day);
			if (!entry) continue;
			for (const definition of body.metricDefinitions ?? []) {
				const value = valueOf(definition, entry);
				if (value) rows.push({ name: `domains/${name}/domainStats/${crypto.randomUUID()}`, metric: definition.name, value, date: toDate(day) });
			}
		}
		const start = Number(body.pageToken ?? 0);
		const end = start + Math.min(state.pageSize, body.pageSize ?? 10);
		return reply(200, { domainStats: rows.slice(start, end), ...(end < rows.length && { nextPageToken: String(end) }) });
	}

	function handle(url, init = {}) {
		const failure = state.failures.findIndex(({ pattern }) => pattern.test(url));
		if (failure >= 0) {
			const [{ status, body }] = state.failures.splice(failure, 1);
			return reply(status, body);
		}
		if (url === TOKEN_URL) return handleToken(init.body);
		const query = API_PATTERN.exec(url);
		if (query) {
			const headers = new Headers(init.headers);
			return handleQuery(decodeURIComponent(query[1]), headers.get("authorization"), JSON.parse(init.body));
		}
		return null;
	}

	function install() {
		const previous = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = String(input?.url ?? input);
			return handle(url, init) ?? previous(input, init);
		};
		return () => {
			globalThis.fetch = previous;
		};
	}

	return {
		state,
		install,
		approve,
		// A day of Gmail's data for a domain: its spam rate and the flagged identifiers with their rates.
		setDay(name, day, { spamRate, identifiers = {} } = {}) {
			domain(name).days.set(day, { spamRate, identifiers });
		},
		setAccess(name, hasAccess) {
			domain(name).hasAccess = hasAccess;
		},
		revokeRefreshTokens() {
			for (const token of state.refreshTokens.values()) token.revoked = true;
		},
		fail(pattern, status, body) {
			state.failures.push({ pattern, status, body });
		},
	};
}
