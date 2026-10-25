import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "@/lib/docdb";
import { as, callRoute, catchRedirect, form, platformEmails } from "./app.mjs";
import { metadataDocuments } from "../stubs/cimd-node.mjs";

// The MCP client's side of OAuth, for tests that run the whole flow against the route handlers: a client metadata
// document instead of registration, the authorization code flow through sign-in and the consent page, then /mcp.
export const APP_URL = "http://localhost:3000";
export const MCP_URL = `${APP_URL}/mcp`;
export const TOKEN_URL = `${APP_URL}/api/auth/oauth2/token`;
export const AGENT = {
	clientId: "https://agent.example.test/oauth/client.json",
	redirectUri: "https://agent.example.test/oauth/callback",
	name: "Agent",
};

let visitor = 100;

export async function loadOAuthRoutes() {
	const modules = {
		mcpRoute: await import("../../app/mcp/route.js"),
		authRoute: await import("../../app/api/auth/[...all]/route.js"),
		wellKnown: {
			"/.well-known/oauth-protected-resource": await import("../../app/.well-known/oauth-protected-resource/route.js"),
			"/.well-known/oauth-protected-resource/mcp": await import("../../app/.well-known/oauth-protected-resource/mcp/route.js"),
			"/.well-known/oauth-authorization-server": await import("../../app/.well-known/oauth-authorization-server/route.js"),
			"/.well-known/openid-configuration": await import("../../app/.well-known/openid-configuration/route.js"),
		},
		signin: await import("../../app/signin/actions.js"),
		consent: await import("../../app/oauth/consent/actions.js"),
		Account: (await import("../../models/Account.js")).default,
	};
	metadataDocuments.set(AGENT.clientId, documentFor(AGENT));
	return modules;
}

export function documentFor({ clientId, redirectUri, name }) {
	return {
		client_id: clientId,
		client_name: name,
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
}

export function createOAuthHarness(m) {
	function findRoute(pathname) {
		if (pathname === "/mcp") return m.mcpRoute;
		if (pathname.startsWith("/api/auth/")) return m.authRoute;
		return m.wellKnown[pathname] ?? null;
	}

	async function appFetch(input, init) {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== APP_URL) throw new Error(`Unexpected request to ${url}`);
		const route = findRoute(url.pathname);
		if (!route?.[request.method]) return new Response("Not found", { status: 404 });
		return callRoute(route, request.method, request);
	}

	const cookieOf = (user) => [...user.jar].map(([name, value]) => `${name}=${value}`).join("; ");

	async function customer(email) {
		const user = { email, jar: new Map(), ip: `198.51.100.${++visitor}` };
		await as(user, () => m.signin.sendSigninCode(null, form({ email })));
		const { subject } = platformEmails.findLast(({ to }) => to.includes(email));
		assert.equal(await as(user, () => catchRedirect(m.signin.verifySigninCode(null, form({ email, code: subject.slice(0, 6), next: "/" })))), "/");
		const stored = await mongoose.connection.db.collection("users").findOne({ email });
		user.userId = stored._id;
		return user;
	}

	async function authorizeInBrowser(user, authorizationUrl, { decision = "allow" } = {}) {
		const response = await as(user, () => m.authRoute.GET(new Request(authorizationUrl, { headers: { cookie: cookieOf(user) } })));
		assert.equal(response.status, 302, await response.clone().text());
		const location = new URL(response.headers.get("location"), APP_URL);
		if (location.pathname !== "/oauth/consent") return location;
		return new URL(await as(user, () => catchRedirect(m.consent.answerConsentRequest(null, form({ oauth_query: location.search.slice(1), decision })))));
	}

	function createProvider({ clientId, redirectUri, name } = AGENT) {
		const saved = {};
		const clientMetadata = documentFor({ clientId, redirectUri, name });
		return {
			saved,
			clientMetadataUrl: clientId,
			get redirectUrl() {
				return redirectUri;
			},
			get clientMetadata() {
				return clientMetadata;
			},
			clientInformation: () => saved.client,
			saveClientInformation: (client) => {
				saved.client = client;
			},
			tokens: () => saved.tokens,
			saveTokens: (tokens) => {
				saved.tokens = tokens;
			},
			redirectToAuthorization: (url) => {
				saved.authorizationUrl = url;
			},
			saveCodeVerifier: (verifier) => {
				saved.codeVerifier = verifier;
			},
			codeVerifier: () => saved.codeVerifier,
			saveDiscoveryState: (discovery) => {
				saved.discovery = discovery;
			},
			discoveryState: () => saved.discovery,
		};
	}

	async function openClient(provider) {
		const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
		const client = new Client({ name: "flockstack-oauth-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch });
		return { client, transport, connect: () => client.connect(transport) };
	}

	async function connectApp(user, provider = createProvider()) {
		const first = await openClient(provider);
		await assert.rejects(first.connect(), (error) => error.name === "UnauthorizedError");
		const callback = await authorizeInBrowser(user, provider.saved.authorizationUrl);
		assert.ok(callback.searchParams.get("code"), callback.href);
		await first.transport.finishAuth(callback.searchParams);
		const second = await openClient(provider);
		await second.connect();
		return { client: second.client, provider };
	}

	async function mcpRequest(token, method = "tools/list", params = {}) {
		const request = new Request(MCP_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
				...(token && { authorization: `Bearer ${token}` }),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		const response = await callRoute(m.mcpRoute, "POST", request);
		const text = await response.text();
		const data = text.split("\n").find((line) => line.startsWith("data: "));
		let body = null;
		try {
			body = data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		return { status: response.status, headers: response.headers, body };
	}

	async function postToken(params) {
		const response = await appFetch(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params),
		});
		const text = await response.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
		return { status: response.status, body };
	}

	function pkce() {
		const verifier = crypto.randomBytes(32).toString("base64url");
		return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
	}

	function authorizationUrl({ clientId, redirectUri }, { challenge, ...extra } = {}) {
		const url = new URL(`${APP_URL}/api/auth/oauth2/authorize`);
		const params = {
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: "flockstack:full offline_access",
			state: "state-123",
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource: MCP_URL,
			...extra,
		};
		for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
		return url;
	}

	return { appFetch, cookieOf, customer, authorizeInBrowser, createProvider, openClient, connectApp, mcpRequest, postToken, pkce, authorizationUrl };
}
