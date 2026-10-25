// A synthetic check that MCP clients can still connect to a FlockStack address, run after a deploy or a rotation of BETTER_AUTH_SECRET
// (docs/AUTH-ROTATION.md). Everything it asks needs no credentials: the OAuth discovery documents, the signing keys they point to, and
// /mcp refusing a request without a token the way a client needs it to (a 401 whose WWW-Authenticate names the protected resource
// metadata). With FLOCKSTACK_API_KEY in the environment (never an argument) it also lists the tools as that key. It signs in as no one and
// changes nothing.
//   node scripts/check-mcp-auth.mjs https://flockstack.io
//   FLOCKSTACK_API_KEY=mc_… node scripts/check-mcp-auth.mjs https://flockstack.io
// Exits 1 when a check fails, 2 when it is used wrongly.
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 15_000;
// Parts of a signing key that are never published.
const PRIVATE_KEY_PARTS = ["d", "p", "q", "dp", "dq", "qi", "k"];

function describeBody(text) {
	return JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, 120));
}

async function ask(fetchImpl, url, init = {}) {
	try {
		const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
		const text = await response.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			// A server-sent event stream (an MCP answer) carries its JSON in a data: line.
			const data = text.split("\n").find((line) => line.startsWith("data: "));
			try {
				json = data ? JSON.parse(data.slice(6)) : null;
			} catch {
				json = null;
			}
		}
		return { response, text, json };
	} catch (error) {
		return { error: error?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} seconds` : (error?.message ?? String(error)) };
	}
}

// What is wrong with the answer, or null: a refused request is reported by its status and the start of its body, which is where the
// router says "The app is not answering".
function problemWith(answer, status = 200) {
	if (answer.error) return `the request failed: ${answer.error}`;
	if (answer.response.status !== status) return `answered ${answer.response.status} instead of ${status}: ${describeBody(answer.text)}`;
	return null;
}

const isUrlOn = (value, origin) => {
	try {
		return new URL(value).origin === origin;
	} catch {
		return false;
	}
};

export async function runChecks({ baseUrl, apiKey, fetchImpl = fetch }) {
	const origin = new URL(baseUrl).origin;
	const results = [];
	const record = (name, problem) => results.push({ name, ok: !problem, detail: problem ?? null });
	const get = (path) => ask(fetchImpl, `${origin}${path}`, { headers: { accept: "application/json" } });

	const server = await get("/.well-known/oauth-authorization-server");
	let problem = problemWith(server);
	if (!problem) {
		const metadata = server.json ?? {};
		if (!isUrlOn(metadata.issuer, origin)) problem = `issuer is ${JSON.stringify(metadata.issuer)}, not ${origin}`;
		else if (!["authorization_endpoint", "token_endpoint", "jwks_uri"].every((name) => isUrlOn(metadata[name], origin))) problem = "authorization_endpoint, token_endpoint or jwks_uri is missing or on another host";
		else if (!metadata.code_challenge_methods_supported?.includes("S256")) problem = "S256 is not among code_challenge_methods_supported";
		else if (!["authorization_code", "refresh_token"].every((grant) => metadata.grant_types_supported?.includes(grant))) problem = "authorization_code and refresh_token are not both in grant_types_supported";
	}
	record("OAuth authorization server metadata", problem);

	for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
		const resource = await get(path);
		problem = problemWith(resource);
		if (!problem) {
			const metadata = resource.json ?? {};
			if (metadata.resource !== `${origin}/mcp`) problem = `resource is ${JSON.stringify(metadata.resource)}, not ${origin}/mcp`;
			else if (!metadata.authorization_servers?.some((entry) => isUrlOn(entry, origin))) problem = `authorization_servers does not name ${origin}`;
		}
		record(`OAuth protected resource metadata (${path})`, problem);
	}

	// The keys tokens are checked with: this is where an undecryptable or missing signing key shows first.
	const jwksUri = isUrlOn(server.json?.jwks_uri, origin) ? new URL(server.json.jwks_uri).pathname : "/api/auth/jwks";
	const jwks = await get(jwksUri);
	problem = problemWith(jwks);
	if (!problem) {
		const keys = jwks.json?.keys;
		if (!Array.isArray(keys) || keys.length === 0) problem = "no keys listed";
		else if (!keys.every((key) => key.kid && key.kty === "RSA" && key.alg === "RS256" && key.n && key.e)) problem = "a key lacks kid, kty RSA, alg RS256, n or e";
		else if (keys.some((key) => PRIVATE_KEY_PARTS.some((part) => part in key))) problem = "a key carries a private part";
	}
	record(`signing keys (${jwksUri})`, problem);

	const rpc = (method) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });
	const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
	const refused = await ask(fetchImpl, `${origin}/mcp`, { method: "POST", headers: mcpHeaders, body: rpc("tools/list") });
	problem = problemWith(refused, 401);
	if (!problem) {
		const challenge = refused.response.headers.get("www-authenticate") ?? "";
		if (!/^Bearer\b/i.test(challenge)) problem = `WWW-Authenticate is ${JSON.stringify(challenge)}, not a Bearer challenge`;
		else if (!challenge.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`)) problem = `WWW-Authenticate does not name ${origin}/.well-known/oauth-protected-resource/mcp: ${JSON.stringify(challenge)}`;
		else if (refused.json?.error?.code !== "unauthorized") problem = `the body is ${describeBody(refused.text)}, not the API's unauthorized error`;
	}
	record("/mcp without a token: 401 with a WWW-Authenticate challenge", problem);

	if (apiKey) {
		const listed = await ask(fetchImpl, `${origin}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${apiKey}` }, body: rpc("tools/list") });
		problem = problemWith(listed);
		if (!problem && !(listed.json?.result?.tools?.length > 0)) problem = `no tools listed: ${describeBody(listed.text)}`;
		record("/mcp with FLOCKSTACK_API_KEY: tools/list", problem);
	}
	return results;
}

export function formatResults(results) {
	return results.map(({ name, ok, detail }) => (ok ? `  ok    ${name}` : `  FAIL  ${name}\n          ${detail}`)).join("\n");
}

async function main(argv) {
	const [target] = argv.filter((argument) => !argument.startsWith("-"));
	if (!target || argv.some((argument) => argument.startsWith("-"))) {
		console.error("usage: node scripts/check-mcp-auth.mjs <base url>   (FLOCKSTACK_API_KEY in the environment adds an authenticated tools/list)");
		return 2;
	}
	let baseUrl;
	try {
		baseUrl = new URL(target).origin;
	} catch {
		console.error(`${target} is not a URL`);
		return 2;
	}
	const results = await runChecks({ baseUrl, apiKey: process.env.FLOCKSTACK_API_KEY });
	console.log(`${baseUrl}${process.env.FLOCKSTACK_API_KEY ? "" : " (no FLOCKSTACK_API_KEY: nothing checked with a key)"}\n${formatResults(results)}`);
	const failed = results.filter(({ ok }) => !ok).length;
	console.log(failed === 0 ? "All checks passed." : `${failed} of ${results.length} checks failed.`);
	return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
