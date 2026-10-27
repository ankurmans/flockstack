// An authenticated, read-only smoke test of a running FlockStack: the REST API (GET only) and the MCP server (initialize, tools/list and
// a few read tools), as one API key. It checks status codes and the shape of answers, never their content, and prints a pass or fail
// with the time of each check. The key comes from FLOCKSTACK_API_KEY in the environment (never an argument) and is only ever sent as
// the Authorization header of a request to the address given: it is not printed, logged or put in a failure's text.
//   FLOCKSTACK_API_KEY=… node scripts/smoke-live.mjs https://flockstack.io
//   FLOCKSTACK_API_KEY=… node scripts/smoke-live.mjs https://eu.flockstack.io [--level full|send_with_approval|drafts|read_only] [--json]
// Exits 1 when a check fails, 2 when it is used wrongly. A key of a lower level than full cannot run the admin reads (billing, keys, team):
// those are skipped, not failed, and the tool count expected is the level's. docs/RELEASE-QA.md has when to run it.
//
// It cannot change anything: assertReadOnlyRest refuses every method but GET and any path that is not a read of the registry, and
// assertReadOnlyTool refuses every MCP tool that is not a read in lib/action-scopes.js and marked readOnlyHint by the server itself.
// tests/smoke-live.test.mjs holds both to that.
import { pathToFileURL } from "node:url";
import { isPresetAllowed, getActionClass, PRESETS } from "../lib/action-scopes.js";
import { ACTION_MANIFEST } from "../lib/actions/manifest.js";

const TIMEOUT_MS = 20_000;
const MCP_VERSION = "2025-06-18";

// The admin-class reads that only look: they are readOnly in the registry but sit in the admin class, because only the owner's key may see them.
export const ADMIN_READS = ["get_billing", "list_api_keys", "list_team_members"];
// Reads that exist but are not part of a smoke test: contact data, links that grant access, and files of everything.
export const NEVER_SMOKE = ["list_contacts", "get_contact", "export_contacts", "list_replies", "get_magic_link", "get_account_export", "list_comments", "list_cancellation_responses", "list_poll_voters", "list_survey_responses", "export_survey_responses"];

export class ReadOnlyViolation extends Error {
	constructor(message) {
		super(message);
		this.name = "ReadOnlyViolation";
	}
}

const ENTRIES = ACTION_MANIFEST.map(([name, file, method, path, permission, dashboardOnly]) => ({ name, file, method, path, permission, dashboardOnly }));
const BY_NAME = new Map(ENTRIES.map((entry) => [entry.name, entry]));

// "/campaigns/{id}/internal-links" as a pattern a request path matches.
const toPattern = (path) => new RegExp(`^${path.split("/").map((part) => (part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`);
const REST_PATTERNS = ENTRIES.filter(({ dashboardOnly }) => !dashboardOnly).map((entry) => ({ entry, pattern: toPattern(entry.path) }));

const isReadClass = (name) => getActionClass(name) === "read" || ADMIN_READS.includes(name);

// An action that may be read in a smoke test: public, a GET, in the read class (or one of the admin reads), and not on the never list.
export function isSmokeRead(name) {
	const entry = BY_NAME.get(name);
	return Boolean(entry && !entry.dashboardOnly && entry.method === "GET" && isReadClass(name) && !NEVER_SMOKE.includes(name));
}

// The registry's entry for a REST path that is a GET (more than one entry can match a shape: the literal path wins).
export function findRestRead(path) {
	const pathname = path.split("?")[0].replace(/^\/api\/v1/, "") || "/";
	const matches = REST_PATTERNS.filter(({ entry, pattern }) => entry.method === "GET" && pattern.test(pathname));
	return matches.sort((a, b) => a.entry.path.split("{").length - b.entry.path.split("{").length)[0]?.entry ?? null;
}

export function assertReadOnlyRest(method, path) {
	if (String(method).toUpperCase() !== "GET") throw new ReadOnlyViolation(`refused ${String(method).toUpperCase()} ${path.split("?")[0]}: the smoke test only sends GET`);
	if (!/^\/api\/v1\//.test(path)) throw new ReadOnlyViolation(`refused ${path.split("?")[0]}: only /api/v1 paths`);
	const entry = findRestRead(path);
	if (!entry) throw new ReadOnlyViolation(`refused GET ${path.split("?")[0]}: not a read in the action registry`);
	if (!isSmokeRead(entry.name)) throw new ReadOnlyViolation(`refused GET ${path.split("?")[0]}: ${entry.name} is not a read the smoke test may call`);
	return entry;
}

// listed: the tools of the server's own tools/list, by name. A tool the server does not list as readOnlyHint is refused even when the registry here calls it a read.
export function assertReadOnlyTool(name, listed = null) {
	if (!isSmokeRead(name)) throw new ReadOnlyViolation(`refused tool ${name}: not a read in the action registry (lib/action-scopes.js)`);
	if (!listed?.has(name)) throw new ReadOnlyViolation(`refused tool ${name}: the server did not list it`);
	if (listed.get(name)?.annotations?.readOnlyHint !== true) throw new ReadOnlyViolation(`refused tool ${name}: the server does not mark it readOnlyHint`);
	return BY_NAME.get(name);
}

// The tools a key of this level should list: every public action its level may run.
export function expectedTools(level = "full") {
	return ENTRIES.filter(({ name, permission, dashboardOnly }) => !dashboardOnly && isPresetAllowed(level, { name, permission })).map(({ name }) => name);
}

// What each check asks for and the shape it must answer with. "name[]" is a list. mcp: also called as a tool. path params ({id}) are the first newsletter's.
export const CHECKS = [
	{ action: "list_newsletters", keys: ["newsletters[]"], mcp: true },
	{ action: "get_overview", keys: ["subscribers", "emails", "usage"], mcp: true },
	{ action: "list_campaigns", keys: ["campaigns[]"], mcp: true },
	{ action: "get_content_plan", keys: ["entries[]", "counts"], query: () => planRange(), mcp: true },
	{ action: "list_editorial_batches", keys: ["batches[]"], mcp: true },
	{ action: "list_content_items", keys: ["items[]"] },
	{ action: "list_domains", keys: ["domains[]"], mcp: true },
	{ action: "get_billing", keys: ["plan", "status", "usage"], mcp: true },
	{ action: "list_api_keys", keys: ["apiKeys[]"], names: "apiKeys" },
	{ action: "list_agent_activity", keys: ["activity[]"], query: () => ({ limit: 5 }), mcp: true },
	{ action: "get_brand_fleet", keys: ["newsletters[]", "limits"] },
	{ action: "list_team_members", keys: ["seats[]"] },
	{ action: "get_reader_settings", keys: ["newsletterId", "language"] },
	{ action: "get_reply_rules", keys: ["enabled", "rules[]"] },
	{ action: "get_ai_usage", keys: ["used", "limit"] },
	{ action: "list_mailing_lists", keys: ["lists[]"] },
	{ action: "list_newsletter_authors", keys: ["authors[]"] },
	{ action: "list_subscriber_perks", keys: ["perks[]"] },
	{ action: "get_creator_match_settings", keys: ["enabled"] },
	{ action: "list_approvals", keys: ["approvals[]"] },
	{ action: "get_reader_retention_settings", keys: ["newsletterId", "pauseEnabled"], needsNewsletter: true },
	{ action: "get_group_settings", keys: ["newsletterId", "enabled"], needsNewsletter: true },
	{ action: "get_sponsorship_settings", keys: ["newsletterId", "enabled"], needsNewsletter: true },
];

function planRange(now = new Date()) {
	const day = (date) => date.toISOString().slice(0, 10);
	return { from: day(now), to: day(new Date(+now + 14 * 86400000)) };
}

const describeBody = (text) => JSON.stringify(String(text).replace(/\s+/g, " ").trim().slice(0, 100));

function readJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		// A server-sent event stream (an MCP answer) carries its JSON in a data: line.
		const data = text.split("\n").find((line) => line.startsWith("data: "));
		try {
			return data ? JSON.parse(data.slice(6)) : null;
		} catch {
			return null;
		}
	}
}

// What is missing from a body of the shape a check expects, or null.
export function shapeProblem(body, keys) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "the answer is not a JSON object";
	for (const key of keys) {
		const isList = key.endsWith("[]");
		const name = isList ? key.slice(0, -2) : key;
		if (!(name in body)) return `no ${name} in the answer`;
		if (isList && !Array.isArray(body[name])) return `${name} is not a list`;
	}
	return null;
}

function errorText(json) {
	const error = json?.error;
	return error && typeof error === "object" ? ` (${String(error.code ?? "").slice(0, 40)}: ${String(error.message ?? "").slice(0, 100)})` : "";
}

export async function runSmoke({ baseUrl, apiKey, level = "full", fetchImpl = fetch, now = () => performance.now() }) {
	const origin = new URL(baseUrl).origin;
	const results = [];
	const authorization = { authorization: `Bearer ${apiKey}` };
	let served = null;

	async function send(url, init, { signal = AbortSignal.timeout(TIMEOUT_MS) } = {}) {
		try {
			const response = await fetchImpl(url, { redirect: "manual", signal, ...init });
			const text = await response.text();
			served = response.headers.get("x-served-by");
			return { response, text, json: readJson(text) };
		} catch (error) {
			return { error: error?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} seconds` : (error?.message ?? String(error)).replaceAll(apiKey ?? "\u0000", "[key]") };
		}
	}

	// One check: run() returns null for a pass, a text for a failure, or { skipped } for a check this key cannot make. Throws from the read-only guard stop the whole run.
	async function check(name, run) {
		const started = now();
		served = null;
		let outcome;
		try {
			outcome = await run();
		} catch (error) {
			if (error instanceof ReadOnlyViolation) throw error;
			outcome = `unexpected: ${String(error?.message ?? error).replaceAll(apiKey ?? "\u0000", "[key]")}`;
		}
		const ms = Math.round(now() - started);
		const skipped = typeof outcome === "object" && outcome?.skipped;
		const detail = skipped ? outcome.skipped : typeof outcome === "object" ? outcome?.note ?? null : outcome;
		const ok = skipped ? null : typeof outcome === "object" ? true : outcome === null;
		results.push({ name, ok, skipped: Boolean(skipped), ms, servedBy: served, detail: ok === false || skipped || detail ? detail : null });
	}

	async function rest(path) {
		const method = "GET";
		assertReadOnlyRest(method, path);
		return send(`${origin}${path}`, { method, headers: { accept: "application/json", ...authorization } });
	}

	// A JSON-RPC call to /mcp. Only initialize, tools/list and tools/call of a read tool the server listed are ever sent.
	let rpcId = 0;
	async function mcp(method, params, listed = null) {
		if (!["initialize", "tools/list", "tools/call"].includes(method)) throw new ReadOnlyViolation(`refused MCP method ${method}`);
		if (method === "tools/call") assertReadOnlyTool(params?.name, listed);
		return send(`${origin}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(method !== "initialize" && { "mcp-protocol-version": MCP_VERSION }), ...authorization },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
		});
	}

	const refused = (answer, status) => (answer.error ? `the request failed: ${answer.error}` : answer.response.status !== status ? `answered ${answer.response.status} instead of ${status}${errorText(answer.json) || ` ${describeBody(answer.text)}`}` : null);
	const canRun = (action) => isPresetAllowed(level, { name: action, permission: BY_NAME.get(action)?.permission });

	await check("REST without a key: GET /api/v1/newsletters is 401 in the API's error shape", async () => {
		const answer = await send(`${origin}/api/v1/newsletters`, { method: "GET", headers: { accept: "application/json" } });
		const problem = refused(answer, 401);
		if (problem) return problem;
		return answer.json?.error?.code === "unauthorized" ? null : `the body is ${describeBody(answer.text)}, not the unauthorized error`;
	});

	let newsletterId = null;
	for (const entry of CHECKS) {
		const base = BY_NAME.get(entry.action);
		if (!base) {
			await check(`REST GET ${entry.action}`, () => "not in the action registry of this checkout");
			continue;
		}
		await check(`REST GET ${base.path.replace("{id}", ":newsletter")}`, async () => {
			if (!canRun(entry.action)) return { skipped: `a ${level} key cannot run ${entry.action}` };
			if (entry.needsNewsletter && !newsletterId) return { skipped: "no newsletter id from list_newsletters" };
			const query = entry.query ? `?${new URLSearchParams(entry.query())}` : "";
			const answer = await rest(`/api/v1${base.path.replace("{id}", encodeURIComponent(newsletterId ?? ""))}${query}`);
			const problem = refused(answer, 200) ?? shapeProblem(answer.json, entry.keys);
			if (problem) return problem;
			if (entry.action === "list_newsletters") newsletterId = answer.json.newsletters[0]?.id ?? answer.json.newsletters[0]?.slug ?? null;
			if (entry.names) return { note: `${answer.json[entry.names].length} keys: ${answer.json[entry.names].map((key) => String(key.name ?? "?").slice(0, 30)).slice(0, 10).join(", ")}` };
			return null;
		});
	}

	// MCP
	let listed = null;
	await check("MCP initialize", async () => {
		const answer = await mcp("initialize", { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "flockstack-smoke", version: "1" } });
		const problem = refused(answer, 200);
		if (problem) return problem;
		return answer.json?.result?.serverInfo ? null : "no serverInfo in the answer";
	});

	await check(`MCP tools/list (${level} key)`, async () => {
		const tools = [];
		let cursor;
		for (let page = 0; page < 20; page++) {
			const answer = await mcp("tools/list", cursor ? { cursor } : {});
			const problem = refused(answer, 200);
			if (problem) return problem;
			const result = answer.json?.result;
			if (!Array.isArray(result?.tools)) return `no tools in the answer: ${describeBody(answer.text)}`;
			tools.push(...result.tools);
			cursor = result.nextCursor;
			if (!cursor) break;
		}
		listed = new Map(tools.map((tool) => [tool.name, tool]));
		const expected = expectedTools(level);
		const missing = expected.filter((name) => !listed.has(name));
		const extra = [...listed.keys()].filter((name) => !expected.includes(name));
		const count = `${tools.length} tools, expected ${expected.length}`;
		if (missing.length || extra.length) return `${count}: ${missing.length ? `missing ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `not in this checkout: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ` and ${extra.length - 8} more` : ""}` : ""}`;
		const writes = tools.filter((tool) => tool.annotations?.readOnlyHint !== true).length;
		return { note: `${count}; ${tools.length - writes} marked readOnlyHint, ${writes} not` };
	});

	for (const entry of CHECKS.filter(({ mcp: asTool }) => asTool)) {
		await check(`MCP tools/call ${entry.action}`, async () => {
			if (!canRun(entry.action)) return { skipped: `a ${level} key cannot run ${entry.action}` };
			if (!listed) return { skipped: "tools/list failed" };
			if (!listed.has(entry.action)) return `${entry.action} is not in tools/list`;
			const answer = await mcp("tools/call", { name: entry.action, arguments: entry.query ? entry.query() : {} }, listed);
			const problem = refused(answer, 200);
			if (problem) return problem;
			const result = answer.json?.result;
			if (!result) return `no result: ${describeBody(answer.text)}`;
			if (result.isError) return `the tool answered an error${errorText(readJson(result.content?.[0]?.text ?? ""))}`;
			return shapeProblem(result.structuredContent ?? readJson(result.content?.[0]?.text ?? ""), entry.keys);
		});
	}
	return results;
}

export function formatResults(results) {
	const line = ({ name, ok, skipped, ms, servedBy, detail }) => {
		const mark = skipped ? "skip " : ok ? "ok   " : "FAIL ";
		return `  ${mark} ${name} ${String(ms).padStart(5)} ms${servedBy ? ` [${servedBy}]` : ""}${detail ? `\n          ${detail}` : ""}`;
	};
	return results.map(line).join("\n");
}

export function summarize(results) {
	const failed = results.filter(({ ok }) => ok === false).length;
	const skipped = results.filter(({ skipped }) => skipped).length;
	const total = results.reduce((sum, { ms }) => sum + ms, 0);
	return { failed, skipped, passed: results.length - failed - skipped, ms: total };
}

async function main(argv, env = process.env) {
	const args = argv.slice();
	const take = (flag) => {
		const index = args.indexOf(flag);
		if (index < 0) return null;
		const [, value] = args.splice(index, 2);
		return value ?? "";
	};
	const level = take("--level") ?? "full";
	const asJson = args.includes("--json");
	const positional = args.filter((argument) => argument !== "--json");
	const usage = "usage: FLOCKSTACK_API_KEY=… node scripts/smoke-live.mjs <base url> [--level full|send_with_approval|drafts|read_only] [--json]";
	if (positional.length !== 1 || positional[0].startsWith("-") || !PRESETS.includes(level) || level === "signups") {
		console.error(usage);
		return 2;
	}
	if (/^(mc_|mc_eu_|fs_)/.test(positional[0])) {
		console.error("The first argument is an address, not a key. The key belongs in FLOCKSTACK_API_KEY.");
		return 2;
	}
	let baseUrl;
	try {
		baseUrl = new URL(positional[0]);
	} catch {
		console.error(`${positional[0]} is not a URL`);
		return 2;
	}
	const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
	if (baseUrl.protocol !== "https:" && !isLocal) {
		console.error("The key is sent to this address, so it must be https.");
		return 2;
	}
	const apiKey = env.FLOCKSTACK_API_KEY;
	if (!apiKey) {
		console.error(`FLOCKSTACK_API_KEY is not set. Read it without echoing it: read -rs FLOCKSTACK_API_KEY && export FLOCKSTACK_API_KEY\n${usage}`);
		return 2;
	}
	if (/\s/.test(apiKey)) {
		console.error("FLOCKSTACK_API_KEY holds whitespace.");
		return 2;
	}
	let results;
	try {
		results = await runSmoke({ baseUrl: baseUrl.origin, apiKey, level });
	} catch (error) {
		if (error instanceof ReadOnlyViolation) {
			console.error(error.message);
			return 2;
		}
		throw error;
	}
	const { failed, skipped, passed, ms } = summarize(results);
	if (asJson) console.log(JSON.stringify({ baseUrl: baseUrl.origin, level, passed, failed, skipped, ms, results }, null, 2));
	else {
		console.log(`${baseUrl.origin}, a ${level} key\n${formatResults(results)}`);
		console.log(`${failed === 0 ? "All checks passed" : `${failed} of ${results.length} checks failed`}: ${passed} passed, ${skipped} skipped, ${ms} ms in all.`);
	}
	if (failed > 0 && results.slice(1).every(({ ok, skipped: wasSkipped }) => ok === false || wasSkipped)) console.log("Every authenticated check failed: the key may be for the other region (EU keys start with mc_eu_) or revoked.");
	return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
