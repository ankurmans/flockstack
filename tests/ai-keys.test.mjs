import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as, callApi, jsonRequest, withEnv } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { readResponseBytes, readZip } from "./helpers/zip.mjs";
import { published } from "./stubs/qstash.mjs";

// Briefings' AI keys (docs/BRIEFINGS-DESIGN.md, Safety): an account's own provider key is encrypted at rest and never comes back
// out, in any answer, error, log, approval or export. Every key here is made up, and nothing reaches the network.

const ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const SECRET = "sk-or-v1-MADEUP-0123456789abcdefSECRET";
const ANTHROPIC_SECRET = "sk-ant-MADEUP-zyxwvutsrqponmlkji9876";

let t;
let m;
let realFetch;
const requests = [];
let answer = () => new Response("{}", { status: 200 });

function hasNoSecret(value, secrets = [SECRET, ANTHROPIC_SECRET]) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	for (const secret of secrets) assert.ok(!text.includes(secret), "the key appears where it must not");
	return true;
}

before(async () => {
	t = await setupAudienceTests({ CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY, EXPORT_STORAGE: "memory" });
	m = {
		...t.m,
		aiKeys: await import("../lib/ai-keys.js"),
		credentials: await import("../lib/credentials.js"),
		actions: await import("../app/(app)/ai-keys/actions.js"),
		page: await import("../app/(app)/ai-keys/page.js"),
		exportJob: await import("../app/api/jobs/export-account/route.js"),
		zipRoute: await import("../app/api/v1/account/export.zip/route.js"),
		AiProviderKey: (await import("../models/AiProviderKey.js")).default,
		AgentActivity: (await import("../models/AgentActivity.js")).default,
		ApprovalRequest: (await import("../models/ApprovalRequest.js")).default,
	};
	realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input?.url ?? input);
		const isProvider = Object.values(m.aiKeys.AI_PROVIDER_ENDPOINTS).some((base) => url.startsWith(base.split("{")[0])) || url.startsWith("https://llm.example.com/");
		if (!isProvider) return realFetch(input, init);
		requests.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
		return answer(url);
	};
});

after(() => {
	globalThis.fetch = realFetch;
	return t?.app.stop();
});

describe("adding a key", () => {
	let user;

	before(async () => {
		user = await t.customer("ai-keys-add@example.com");
	});

	test("is encrypted for its account, answers its last four characters only, and the engine can read it back", async () => {
		const response = await t.api(user.key, "POST", "/ai-keys", { name: "OpenRouter", provider: "openrouter", key: SECRET });
		assert.equal(response.status, 201, JSON.stringify(response.body));
		hasNoSecret(response.body);
		assert.deepEqual([response.body.hint, response.body.status, response.body.usedBy, response.body.baseUrl], ["CRET", "unchecked", 0, null]);

		const stored = await m.AiProviderKey.findOne({ accountId: user.accountId, _id: response.body.id }).select("+secret").lean();
		hasNoSecret(stored);
		assert.match(stored.secret, /^v1\./);
		const context = { context: `ai-key:${user.accountId}:${stored._id}` };
		assert.equal(m.credentials.decryptSecret(stored.secret, context), SECRET);
		assert.throws(() => m.credentials.decryptSecret(stored.secret, { context: `ai-key:${crypto.randomBytes(12).toString("hex")}:${stored._id}` }), /doesn't decrypt/);
		assert.equal((await m.AiProviderKey.findOne({ accountId: user.accountId, _id: stored._id }).lean()).secret, undefined, "hidden from every read that doesn't ask");

		const forRun = await m.aiKeys.getAiKeyForRun({ accountId: user.accountId, keyId: stored._id });
		assert.deepEqual(forRun, { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", accountRef: null, secret: SECRET });
		const other = await t.customer("ai-keys-other@example.com");
		assert.equal(await m.aiKeys.getAiKeyForRun({ accountId: other.accountId, keyId: stored._id }), null, "another account's id finds nothing");

		const at = new Date("2026-10-28T08:00:00Z");
		await m.aiKeys.markAiKeyUsed({ accountId: user.accountId, keyId: stored._id, at });
		const listed = await t.api(user.key, "GET", "/ai-keys");
		hasNoSecret(listed.body);
		assert.deepEqual(listed.body.keys.map(({ name, lastUsedAt }) => [name, lastUsedAt]), [["OpenRouter", at.toISOString()]]);
		assert.deepEqual((await t.api(other.key, "GET", "/ai-keys")).body.keys, []);
	});

	test("checks the fields and never repeats the key in its refusals", async () => {
		const refusals = [
			[{ name: "x", provider: "nope", key: SECRET }, /provider/],
			[{ name: "x", provider: "openai", key: "short" }, /whole key/],
			[{ name: "x", provider: "openai", key: `${SECRET} with spaces` }, /whole key/],
			[{ name: "x", provider: "openai-compatible", key: SECRET }, /server's address/],
			[{ name: "x", provider: "openai-compatible", key: SECRET, baseUrl: "http://llm.example.com/v1" }, /https/],
			[{ name: "x", provider: "openai-compatible", key: SECRET, baseUrl: "https://10.0.0.8/v1" }, /private network/],
			[{ name: "x", provider: "openai-compatible", key: SECRET, baseUrl: "https://localhost/v1" }, /private network|local/i],
			[{ name: "x", provider: "openai-compatible", key: SECRET, baseUrl: "https://llm.example.com:8443/v1" }, /default https port/],
			[{ name: "x", provider: "openai", key: SECRET, baseUrl: "https://llm.example.com/v1" }, /Only another OpenAI-compatible/],
			[{ name: "x", provider: "cloudflare", key: SECRET }, /Cloudflare account ID/],
			[{ name: "x", provider: "openai", key: SECRET, accountRef: "a".repeat(32) }, /Only Cloudflare/],
		];
		for (const [body, pattern] of refusals) {
			const response = await t.api(user.key, "POST", "/ai-keys", body);
			assert.match(t.assertError(response, 400, "validation_failed"), pattern, JSON.stringify(body.provider));
			hasNoSecret(response.body);
		}
		const custom = await t.api(user.key, "POST", "/ai-keys", { name: "Own server", provider: "openai-compatible", key: SECRET, baseUrl: "https://llm.example.com/v1/" });
		assert.equal(custom.body.baseUrl, "https://llm.example.com/v1");
		const cloudflare = await t.api(user.key, "POST", "/ai-keys", { name: "Workers AI", provider: "cloudflare", key: SECRET, accountRef: "ABCDEF0123456789abcdef0123456789" });
		assert.equal(cloudflare.body.accountRef, "abcdef0123456789abcdef0123456789");
		const forRun = await m.aiKeys.getAiKeyForRun({ accountId: user.accountId, keyId: cloudflare.body.id });
		assert.equal(forRun.baseUrl, "https://api.cloudflare.com/client/v4/accounts/abcdef0123456789abcdef0123456789/ai/v1");
	});

	test("answers unavailable without CREDENTIALS_ENCRYPTION_KEY, and an account has 10 keys at most", async () => {
		const other = await t.customer("ai-keys-limit@example.com");
		await withEnv({ CREDENTIALS_ENCRYPTION_KEY: "" }, async () => {
			const response = await t.api(other.key, "POST", "/ai-keys", { name: "x", provider: "openai", key: SECRET });
			assert.match(t.assertError(response, 503, "unavailable"), /CREDENTIALS_ENCRYPTION_KEY/);
			hasNoSecret(response.body);
		});
		await withEnv({ CREDENTIALS_ENCRYPTION_KEY: "not-a-key" }, async () => {
			const response = await t.api(other.key, "POST", "/ai-keys", { name: "x", provider: "openai", key: SECRET });
			t.assertError(response, 503, "unavailable");
			hasNoSecret(response.body);
		});
		assert.equal(await m.AiProviderKey.countDocuments({ accountId: other.accountId }), 0);
		for (let index = 0; index < 10; index++) await m.aiKeys.addAiKey(await m.Account.findById(other.accountId).lean(), { name: `Key ${index}`, provider: "groq", key: `gsk_MADEUP_${index}_abcdefgh` });
		t.assertError(await t.api(other.key, "POST", "/ai-keys", { name: "One more", provider: "openai", key: SECRET }), 409, "conflict");
	});
});

describe("checking a key", () => {
	test("asks the provider once with the key in its own header, and saves ok or rejected; a provider that fails leaves it be", async () => {
		const user = await t.customer("ai-keys-check@example.com");
		const openrouter = (await t.api(user.key, "POST", "/ai-keys", { name: "OpenRouter", provider: "openrouter", key: SECRET })).body;
		const anthropic = (await t.api(user.key, "POST", "/ai-keys", { name: "Anthropic", provider: "anthropic", key: ANTHROPIC_SECRET })).body;

		requests.length = 0;
		answer = () => Response.json({ data: { label: SECRET } });
		const ok = await t.api(user.key, "POST", `/ai-keys/${openrouter.id}/check`);
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		hasNoSecret(ok.body);
		assert.deepEqual([ok.body.key.status, ok.body.problem], ["ok", null]);
		assert.ok(ok.body.key.checkedAt);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, "https://openrouter.ai/api/v1/key");
		assert.equal(requests[0].headers.get("authorization"), `Bearer ${SECRET}`);
		assert.equal(requests[0].redirect, "manual");

		answer = () => Response.json({ error: { message: `invalid x-api-key ${ANTHROPIC_SECRET}` } }, { status: 401 });
		const rejected = await t.api(user.key, "POST", `/ai-keys/${anthropic.id}/check`);
		hasNoSecret(rejected.body);
		assert.equal(rejected.body.key.status, "rejected");
		assert.match(rejected.body.problem, /Anthropic refused the key/);
		assert.equal(requests[1].url, "https://api.anthropic.com/v1/models?limit=1");
		assert.equal(requests[1].headers.get("x-api-key"), ANTHROPIC_SECRET);
		assert.equal(requests[1].headers.get("authorization"), null);

		answer = () => new Response(`upstream error for ${SECRET}`, { status: 502 });
		const failing = await t.api(user.key, "POST", `/ai-keys/${openrouter.id}/check`);
		assert.match(t.assertError(failing, 503, "unavailable"), /answered 502/);
		hasNoSecret(failing.body);
		answer = () => {
			throw new Error(`connect ECONNREFUSED with ${SECRET}`);
		};
		const down = await t.api(user.key, "POST", `/ai-keys/${openrouter.id}/check`);
		assert.match(t.assertError(down, 503, "unavailable"), /didn't answer/);
		hasNoSecret(down.body);
		const [after] = (await t.api(user.key, "GET", "/ai-keys")).body.keys;
		assert.equal(after.status, "ok", "a failed check changes nothing");

		const typesafe = (await t.api(user.key, "POST", "/ai-keys", { name: "Jev", provider: "typesafe", key: "ts_MADEUP_0123456789" })).body;
		answer = () => Response.json({ data: [] });
		await t.api(user.key, "POST", `/ai-keys/${typesafe.id}/check`);
		assert.equal(requests.at(-1).url, "https://api.typesafe.ai/v1/models");
		answer = () => new Response("{}", { status: 200 });
	});
});

describe("where the key must never show", () => {
	test("agents: the activity log, approvals and refusals hold no key, and no level sends add_ai_key for approval", async () => {
		const user = await t.customer("ai-keys-agents@example.com");
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { agentApproval: true } });
		const scopes = await import("../lib/action-scopes.js");
		assert.equal(scopes.getActionClass("add_ai_key", { key: SECRET }), "admin");
		assert.equal(scopes.isGateable("add_ai_key"), false, "admin is never an approval, so the key is never stored in one");

		const added = await t.api(user.key, "POST", "/ai-keys", { name: "Agent added", provider: "openrouter", key: SECRET });
		assert.equal(added.status, 201, "a full access key runs it at once, even where the newsletter asks before sends");
		const careful = await t.createKey(user, "send_with_approval");
		const denied = await callApi("POST", "/api/v1/ai-keys", { key: careful, body: { name: "Careful", provider: "openrouter", key: ANTHROPIC_SECRET } });
		assert.equal(denied.status, 403);
		hasNoSecret(denied.body);
		const readOnly = await t.createKey(user, "read_only");
		assert.equal((await callApi("GET", "/api/v1/ai-keys", { key: readOnly })).status, 200);

		const activity = await m.AgentActivity.find({ accountId: user.accountId }).lean();
		assert.ok(activity.some(({ action, status }) => action === "add_ai_key" && status === "ok"));
		assert.ok(activity.some(({ action, status }) => action === "add_ai_key" && status === "denied"));
		hasNoSecret(activity);
		assert.equal(await m.ApprovalRequest.countDocuments({ accountId: user.accountId }), 0);
		hasNoSecret(await m.ApprovalRequest.find({ accountId: user.accountId }).lean());

		const { summarizeCall } = await import("../lib/agent-activity-rules.js");
		const hexKey = "0123456789abcdef01234567";
		assert.doesNotMatch(summarizeCall({ title: "Add an AI key" }, { key: hexKey, provider: "openai" }), new RegExp(hexKey), "even a key that looks like an id");
	});

	test("the dashboard: the form's answer and the page show the hint, never the key", async () => {
		const user = await t.customer("ai-keys-dashboard@example.com");
		const bad = await as(user, () => m.actions.addAiKey({ name: "x", provider: "openai-compatible", key: SECRET, baseUrl: "http://example.com" }));
		assert.match(bad.error, /https/);
		hasNoSecret(bad);
		const saved = await as(user, () => m.actions.addAiKey({ name: "Dashboard key", provider: "openrouter", key: SECRET }));
		assert.deepEqual(saved, { ok: true, hint: "CRET" });
		const page = renderToStaticMarkup(await as(user, () => m.page.default()));
		assert.match(page, /Dashboard key/);
		assert.match(page, /…CRET/);
		assert.match(page, /type="password"/);
		hasNoSecret(page);
		const [key] = (await t.api(user.key, "GET", "/ai-keys")).body.keys;
		answer = () => Response.json({ data: {} });
		assert.deepEqual(await as(user, () => m.actions.checkAiKey(key.id)), { ok: true, status: "ok", problem: null });
		assert.deepEqual(await as(user, () => m.actions.deleteAiKey(key.id)), { ok: true });
	});

	test("the account export has the key's name and hint, not the key or its ciphertext", async () => {
		const user = await t.customer("ai-keys-export@example.com");
		const added = (await t.api(user.key, "POST", "/ai-keys", { name: "Exported key", provider: "openrouter", key: SECRET })).body;
		const { secret } = await m.AiProviderKey.findOne({ accountId: user.accountId, _id: added.id }).select("+secret").lean();
		const started = await callApi("POST", "/api/v1/account/export", { key: user.key });
		assert.equal(started.status, 202, JSON.stringify(started.body));
		let processed = 0;
		while (processed < published.length) {
			const { url, body } = published[processed++];
			if (url.endsWith("/api/jobs/export-account") && body.accountId === String(user.accountId)) await m.exportJob.POST(jsonRequest(url, { method: "POST", body }));
		}
		const latest = await callApi("GET", "/api/v1/account/export", { key: user.key });
		assert.equal(latest.body.status, "ready", JSON.stringify(latest.body));
		const files = readZip(await readResponseBytes(await m.zipRoute.GET(new Request(new URL(latest.body.downloadUrls[0])))));
		const csv = files.get("briefings/ai-keys.csv").toString();
		assert.match(csv, /Exported key/);
		assert.match(csv, /CRET/);
		for (const [path, bytes] of files) {
			assert.ok(!bytes.toString().includes(SECRET), `${path} has the key`);
			assert.ok(!bytes.toString().includes(secret), `${path} has the ciphertext`);
		}
	});
});

describe("deleting a key", () => {
	test("removes the document and its ciphertext at once", async () => {
		const user = await t.customer("ai-keys-delete@example.com");
		const added = (await t.api(user.key, "POST", "/ai-keys", { name: "Short-lived", provider: "openai", key: SECRET })).body;
		const deleted = await t.api(user.key, "DELETE", `/ai-keys/${added.id}`);
		assert.deepEqual(deleted.body, { id: added.id, deleted: true });
		assert.equal(await m.AiProviderKey.countDocuments({ accountId: user.accountId }), 0);
		assert.equal(await m.aiKeys.getAiKeyForRun({ accountId: user.accountId, keyId: added.id }), null);
		t.assertError(await t.api(user.key, "DELETE", `/ai-keys/${added.id}`), 404, "not_found");
	});
});
