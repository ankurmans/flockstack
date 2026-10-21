import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, form, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, callTool, errorOf, loadAgentModules, makeKey, mcp } from "./helpers/agents.mjs";

// What an API key may do by its level, which newsletter it reaches, its daily cap and its expiry, through the REST API
// and MCP. The levels over the whole registry are tests/agent-scopes.test.mjs's.
let app;
let m;
let owner;

before(async () => {
	app = await startTestApp();
	m = await loadAgentModules();
	owner = await agentOwner(m, "agent-keys@example.com");
});

after(() => app?.stop());

describe("levels", () => {
	test("a read only key reads and is refused everything that changes something, in words that say what to ask for", async () => {
		const key = owner.keys.read_only;
		assert.equal((await api(key, "GET", "/campaigns")).status, 200);
		assert.equal((await api(key, "GET", "/contacts")).status, 200);
		const refused = await api(key, "POST", "/campaigns", { subject: "No" });
		assert.equal(refused.status, 403);
		assert.equal(errorOf(refused).code, "forbidden");
		assert.match(errorOf(refused).message, /read only access.*create_campaign needs a key with drafts only access or more/i);
		assert.equal((await api(key, "POST", "/api-keys", { name: "Sneaky", level: "full" })).status, 403);
		assert.equal((await api(key, "GET", "/api-keys")).status, 403, "the list of keys is for full access");
	});

	test("a drafts key writes drafts and nothing that goes out, is published, imported or deleted", async () => {
		const key = owner.keys.drafts;
		const id = await addDraft(m, key);
		assert.equal((await api(key, "PATCH", `/campaigns/${id}`, { subject: "Better" })).status, 200);
		assert.equal((await api(key, "POST", "/templates", { name: "Layout", subject: "S", format: "markdown", content: "Hi" })).status, 201);
		assert.equal((await api(key, "POST", "/segments", { name: "Everyone", rules: { match: "all", conditions: [] } })).status < 500, true);

		for (const [method, path, body] of [
			["POST", `/campaigns/${id}/send`, {}],
			["POST", `/campaigns/${id}/schedule`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }],
			["DELETE", `/campaigns/${id}`],
			["POST", "/contacts/import", { consent: true, contacts: [{ email: "a@example.org" }] }],
			["POST", "/contacts", { email: "a@example.org" }],
			["PATCH", `/newsletters/${owner.newsletterId}`, { name: "Renamed" }],
			["POST", "/domains", { domain: "example.org" }],
			["POST", "/pages", { title: "About", content: "x", format: "markdown", status: "published" }],
		]) {
			const answer = await api(key, method, path, body);
			assert.equal(answer.status, 403, `${method} ${path}: ${JSON.stringify(answer.body)}`);
		}
		assert.equal((await api(key, "POST", "/pages", { title: "Draft page", content: "x", format: "markdown", status: "draft" })).status, 201, "a draft page is a draft");
		const test = await api(key, "POST", `/campaigns/${id}/test`, { to: ["stranger@example.org"] });
		assert.equal(test.status, 403, "a test email to an address the agent names is an email to a stranger");
		assert.notEqual((await api(key, "POST", `/campaigns/${id}/test`, {})).status, 403, "to the owner it is drafting");
	});

	test("a send with approval key does the rest, but is refused keys, billing, webhooks and money", async () => {
		const key = owner.keys.send_with_approval;
		assert.equal((await api(key, "PATCH", `/newsletters/${owner.newsletterId}`, { description: "Hello" })).status, 200);
		assert.equal((await api(key, "POST", "/contacts", { email: "ask@example.org", newsletter: owner.slug })).status, 201);
		for (const [method, path, body] of [
			["POST", "/api-keys", { name: "Escalate", level: "full" }],
			["GET", "/billing"],
			["POST", "/webhooks", { url: "https://hooks.example.com/x", events: ["subscriber.created"] }],
			["POST", "/billing/change-plan", { plan: "pro", interval: "month" }],
			["POST", "/account/export"],
		]) {
			const answer = await api(key, method, path, body);
			assert.equal(answer.status, 403, `${method} ${path}`);
		}
	});

	test("a full key does everything it did, creating keys included", async () => {
		const made = await api(owner.keys.full, "POST", "/api-keys", { name: "By API", level: "read_only", newsletter: owner.slug, dailyCap: 50, expiresInDays: 30 });
		assert.equal(made.status, 201, JSON.stringify(made.body));
		assert.equal(made.body.apiKey.level, "read_only");
		assert.deepEqual(made.body.apiKey.scopes, ["read"]);
		assert.equal(made.body.apiKey.newsletterId, owner.newsletterId);
		assert.equal(made.body.apiKey.dailyCap, 50);
		assert.ok(Date.parse(made.body.apiKey.expiresAt) > Date.now() + 29 * 86_400_000);
		assert.match(made.body.key, /^mc_/);
		assert.equal((await api(made.body.key, "GET", "/campaigns")).status, 200, "the key it made works");
	});

	test("the key list says what each key can do, its newsletter, cap, expiry and calls today", async () => {
		const { body } = await api(owner.keys.full, "GET", "/api-keys");
		const drafts = body.apiKeys.find(({ level }) => level === "drafts");
		assert.deepEqual([drafts.scopes, drafts.approvalRequired, drafts.newsletterId, drafts.dailyCap], [["read", "write-draft"], [], null, null]);
		const asking = body.apiKeys.find(({ level }) => level === "send_with_approval");
		assert.deepEqual(asking.approvalRequired, ["send", "destructive"]);
		assert.ok(body.apiKeys.find(({ isCurrent }) => isCurrent).callsToday >= 1);
	});

	test("MCP lists only the tools a key can run, and a refused call is an error result", async () => {
		const names = async (key) => (await mcp(m, key, "tools/list")).body.result.tools.map(({ name }) => name);
		const readOnly = await names(owner.keys.read_only);
		assert.ok(readOnly.includes("list_campaigns") && !readOnly.includes("create_campaign") && !readOnly.includes("send_campaign"));
		const drafts = await names(owner.keys.drafts);
		assert.ok(drafts.includes("create_campaign") && !drafts.includes("send_campaign") && !drafts.includes("delete_campaign"));
		const asking = await names(owner.keys.send_with_approval);
		assert.ok(asking.includes("send_campaign") && asking.includes("get_approval_status") && !asking.includes("create_api_key"));
		const full = await names(owner.keys.full);
		assert.ok(full.includes("create_api_key"));
		assert.ok(!full.includes("decide_approval") && !full.includes("set_agent_approval"), "deciding is the dashboard's");
		assert.deepEqual(await names(owner.keys.signups), ["add_contact"]);

		const unlisted = await mcp(m, owner.keys.read_only, "tools/call", { name: "create_campaign", arguments: { subject: "x" } });
		assert.match(unlisted.body.error?.message ?? unlisted.body.result?.content?.[0]?.text, /not found|forbidden/i, "a tool its level can't run isn't there to call");
		const raised = await callTool(m, owner.keys.drafts, "create_page", { title: "Live", content: "x", format: "markdown", status: "published" });
		assert.equal(raised.isError, true, "listed, but publishing is more than a draft");
		assert.equal(JSON.parse(raised.content[0].text).error.code, "forbidden");
	});
});

describe("one newsletter", () => {
	let limited;
	let otherCampaign;

	before(async () => {
		limited = await makeKey(m, owner, "full", { name: "One newsletter", newsletter: owner.newsletterId });
		const created = await api(owner.keys.full, "POST", "/campaigns", { subject: "Elsewhere", content: "x", newsletter: owner.otherSlug });
		otherCampaign = created.body.id;
	});

	test("a call that names no newsletter gets the key's, one that names another is refused", async () => {
		const id = await addDraft(m, limited);
		assert.equal((await api(limited, "GET", `/campaigns/${id}`)).body.newsletterId, owner.newsletterId);
		const elsewhere = await api(limited, "POST", "/campaigns", { subject: "Nope", content: "x", newsletter: owner.otherSlug });
		assert.equal(elsewhere.status, 403);
		assert.match(errorOf(elsewhere).message, /limited to one newsletter/);
		assert.equal((await api(limited, "POST", "/campaigns", { subject: "Yes", content: "x", newsletter: owner.slug })).status, 201, "its own, by slug");
		assert.equal((await api(limited, "POST", "/campaigns", { subject: "Yes", content: "x", newsletter: owner.newsletterId })).status, 201, "its own, by ID");
	});

	test("lists show its newsletter only, and a document of another is out of reach by ID", async () => {
		const { body } = await api(limited, "GET", "/campaigns");
		assert.ok(body.campaigns.length > 0);
		assert.ok(body.campaigns.every(({ newsletterId }) => newsletterId === owner.newsletterId));
		for (const [method, path] of [["GET", `/campaigns/${otherCampaign}`], ["PATCH", `/campaigns/${otherCampaign}`], ["DELETE", `/campaigns/${otherCampaign}`], ["GET", `/newsletters/${owner.otherNewsletterId}`]]) {
			assert.equal((await api(limited, method, path, method === "PATCH" ? { subject: "x" } : undefined)).status, 403, `${method} ${path}`);
		}
		assert.equal((await api(limited, "GET", `/newsletters/${owner.newsletterId}`)).status, 200);
		assert.equal((await api(limited, "GET", "/contacts", undefined)).status, 200);
		assert.equal((await api(limited, "GET", `/contacts?newsletter=${owner.otherSlug}`)).status, 403);
		const newsletters = await api(limited, "GET", "/newsletters");
		assert.deepEqual(newsletters.body.newsletters.map(({ id }) => id), [owner.newsletterId], "it doesn't even see the others");
	});

	test("what reaches the whole account is refused, whatever the key's level", async () => {
		for (const [method, path, body] of [
			["POST", "/newsletters", { name: "Third", slug: `${owner.slug}-three`, postalAddress: "1 Main St" }],
			["GET", "/orders"],
			["POST", "/domains", { domain: "example.net" }],
		]) {
			assert.equal((await api(limited, method, path, body)).status, 403, `${method} ${path}`);
		}
		const child = await api(limited, "POST", "/api-keys", { name: "Child", level: "full" });
		assert.equal(child.status, 201);
		assert.equal(child.body.apiKey.newsletterId, owner.newsletterId, "a limited key can only make keys limited to the same newsletter");
		assert.equal((await api(limited, "POST", "/api-keys", { name: "Wide", level: "full", newsletter: owner.otherSlug })).status, 403);
	});

	test("a bulk call checks every ID in it", async () => {
		const mine = await addDraft(m, limited);
		const answer = await api(limited, "POST", "/campaigns/bulk", { ids: [mine, otherCampaign], operation: "unlist" });
		assert.equal(answer.status, 403);
	});

	test("the same limit holds over MCP", async () => {
		const result = await callTool(m, limited, "get_campaign", { id: otherCampaign });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /limited to one newsletter/);
		const list = await callTool(m, limited, "list_newsletters");
		assert.deepEqual(list.structuredContent.newsletters.map(({ id }) => id), [owner.newsletterId]);
	});
});

describe("the daily cap", () => {
	test("calls past it answer daily_cap_reached, other keys are unaffected, and it starts over the next day", async () => {
		const key = await makeKey(m, owner, "read_only", { name: "Capped", dailyCap: 3 });
		for (let call = 0; call < 3; call++) assert.equal((await api(key, "GET", "/campaigns")).status, 200, `call ${call + 1}`);
		const over = await api(key, "GET", "/campaigns");
		assert.equal(over.status, 429);
		assert.equal(errorOf(over).code, "daily_cap_reached");
		assert.match(errorOf(over).message, /midnight UTC/);
		assert.equal((await api(owner.keys.read_only, "GET", "/campaigns")).status, 200, "another key");
		const keyDoc = await m.ApiKey.findOne({ accountId: owner.accountId, name: "Capped" }).lean();
		const today = await m.AgentDay.findOne({ accountId: owner.accountId, actorId: String(keyDoc._id) }).lean();
		assert.equal(today.calls, 3, "the refused call isn't counted");
		await m.AgentDay.updateOne({ _id: today._id, accountId: owner.accountId }, { $set: { day: "2020-01-01" } });
		assert.equal((await api(key, "GET", "/campaigns")).status, 200, "a new day");
	});

	test("two calls racing for the last one don't both get it", async () => {
		const key = await makeKey(m, owner, "read_only", { name: "Race", dailyCap: 1 });
		const answers = await Promise.all([api(key, "GET", "/campaigns"), api(key, "GET", "/campaigns"), api(key, "GET", "/campaigns")]);
		assert.equal(answers.filter(({ status }) => status === 200).length, 1);
		assert.equal(answers.filter(({ status }) => status === 429).length, 2);
	});

	test("the cap and the day's count are on the keys page's list", async () => {
		const { body } = await api(owner.keys.full, "GET", "/api-keys");
		const capped = body.apiKeys.find(({ name }) => name === "Capped");
		assert.equal(capped.dailyCap, 3);
		assert.equal(capped.callsToday, 1);
	});
});

describe("expiry", () => {
	test("a key past its expiry answers unauthorized, over REST and MCP, like a revoked one", async () => {
		const key = await makeKey(m, owner, "read_only", { name: "Short lived", expiresInDays: 7 });
		assert.equal((await api(key, "GET", "/campaigns")).status, 200);
		await m.ApiKey.updateOne({ accountId: owner.accountId, name: "Short lived" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		const expired = await api(key, "GET", "/campaigns");
		assert.equal(expired.status, 401);
		assert.equal(errorOf(expired).code, "unauthorized");
		assert.equal((await mcp(m, key, "tools/list")).status, 401);
		const { body } = await api(owner.keys.full, "GET", "/api-keys");
		assert.ok(Date.parse(body.apiKeys.find(({ name }) => name === "Short lived").expiresAt) < Date.now());
	});
});

describe("keys from before levels", () => {
	test("a key with no level is signups only, one with full is full, and neither has a cap, a newsletter or an expiry", async () => {
		const { generateApiKey } = await import("../lib/api-key-tokens.js");
		const old = generateApiKey();
		await m.ApiKey.create({ accountId: owner.accountId, name: "Old signups", prefix: old.prefix, hash: old.hash });
		const full = generateApiKey();
		await m.ApiKey.create({ accountId: owner.accountId, name: "Old full", prefix: full.prefix, hash: full.hash, level: "full" });

		assert.equal((await api(old.key, "POST", "/contacts", { email: "legacy@example.org", newsletter: owner.slug })).status, 201);
		const refused = await api(old.key, "GET", "/campaigns");
		assert.equal(refused.status, 403);
		assert.equal(errorOf(refused).message, "This key can only add contacts: list_campaigns needs a full access key", "the message it always had");
		assert.equal((await api(full.key, "GET", "/campaigns")).status, 200);
		assert.equal((await api(full.key, "POST", "/api-keys", { name: "From old full", level: "signups" })).status, 201);
		const listed = (await api(full.key, "GET", "/api-keys")).body.apiKeys;
		assert.deepEqual(listed.filter(({ name }) => name.startsWith("Old")).map(({ name, level }) => [name, level]).sort(), [["Old full", "full"], ["Old signups", "signups"]]);
		assert.ok(listed.filter(({ name }) => name.startsWith("Old")).every(({ newsletterId, dailyCap, expiresAt }) => newsletterId === null && dailyCap === null && expiresAt === null));
	});

	test("the dashboard's key form still makes a full key when it is sent without a level", async () => {
		const { key, level } = await as(owner, () => m.apiKeys.createApiKey(null, form({ name: "Plain" })));
		assert.equal(level, "full");
		assert.equal((await api(key, "GET", "/api-keys")).status, 200);
	});
});
