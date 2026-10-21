import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, platformEmails, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, callTool, errorOf, loadAgentModules, makeKey, mcp } from "./helpers/agents.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";

// The approval queue: what a send with approval key (or a newsletter that asks) gets in place of a result, what the owner sees,
// and that approving runs the stored action once, as the key that asked.
let app;
let m;
let owner;
let processedJobs = 0;

const RECEIVER = "https://hooks.example.com/agents";

async function decide(user, id, decision, note = "", acknowledge = false) {
	return as(user, () => m.approvals.decideApproval(id, decision, note, acknowledge));
}

async function propose(key, id) {
	const answer = await api(key, "DELETE", `/campaigns/${id}`);
	assert.equal(answer.status, 202, JSON.stringify(answer.body));
	return answer.body;
}

async function status(key, id) {
	const answer = await api(key, "GET", `/approvals/${id}`);
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	return answer.body;
}

const stored = (id) => m.ApprovalRequest.findOne({ _id: id, accountId: owner.accountId }).lean();
const campaign = (id) => m.Campaign.findOne({ _id: id, accountId: owner.accountId }).lean();

function newDeliveries() {
	const jobs = published.slice(processedJobs).filter(({ url }) => url.endsWith("/api/jobs/deliver-webhook"));
	processedJobs = published.length;
	return jobs;
}

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = await loadAgentModules();
	m.webhooks = await import("../lib/webhooks.js");
	owner = await agentOwner(m, "agent-approvals@example.com");
	await m.Contact.insertMany(
		Array.from({ length: 5 }, (_, index) => ({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: `reader${index}@approvals.example.org`, status: "active", lastSentAt: new Date(Date.now() - 86_400_000) }))
	);
});

after(() => app?.stop());

describe("asking", () => {
	test("a send with approval key's send is stored, not done, and answers 202 with what the agent needs to wait", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval, { subject: "Issue 12: the long weekend" });
		const before = platformEmails.length;
		const answer = await api(owner.keys.send_with_approval, "POST", `/campaigns/${id}/send`, {});
		assert.equal(answer.status, 202);
		assert.equal(answer.headers.get("retry-after"), "30");
		assert.match(answer.headers.get("x-request-id"), /^req_/);
		assert.deepEqual(Object.keys(answer.body).sort(), ["action", "approvalId", "expiresAt", "message", "retryAfter", "status", "statusUrl", "summary"]);
		assert.equal(answer.body.status, "approval_required");
		assert.equal(answer.body.action, "send_campaign");
		assert.equal(answer.body.retryAfter, 30);
		assert.equal(answer.body.statusUrl, `http://localhost:3000/api/v1/approvals/${answer.body.approvalId}`);
		assert.match(answer.body.message, /Do not send it again/);
		assert.ok(Date.parse(answer.body.expiresAt) - Date.now() > 23.9 * 3_600_000, "it expires in 24 hours");

		assert.equal((await campaign(id)).status, "draft", "nothing was sent");
		const row = await stored(answer.body.approvalId);
		assert.deepEqual([row.status, row.actorType, row.actorName, row.via, row.action, row.className, row.reason], ["pending", "key", "send_with_approval key", "api", "send_campaign", "send", "key"]);
		assert.deepEqual(row.input, { id });
		assert.match(row.inputHash, /^[a-f0-9]{64}$/);
		assert.equal(String(row.newsletterId), owner.newsletterId);
		const lines = Object.fromEntries(row.preview.lines);
		assert.equal(lines.Subject, "Issue 12: the long weekend");
		assert.equal(lines["Goes to"], "5 contacts");
		assert.equal(lines.When, "Now");
		assert.equal(row.preview.links[0].href, `http://localhost:3000/campaigns/${id}`);
		assert.ok(platformEmails.length > before, "the owner is emailed");
		assert.match(platformEmails.at(-1).subject, /send_with_approval key is waiting for your approval/);
		assert.match(platformEmails.at(-1).text, /\/approvals/);
	});

	test("the same ask from the same key is that request, not a second one", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const first = await propose(owner.keys.send_with_approval, id);
		const again = await propose(owner.keys.send_with_approval, id);
		assert.equal(again.approvalId, first.approvalId);
		assert.equal(await m.ApprovalRequest.countDocuments({ accountId: owner.accountId, action: "delete_campaign", "input.id": id }), 1);
		const other = await propose(owner.keys.send_with_approval, await addDraft(m, owner.keys.send_with_approval));
		assert.notEqual(other.approvalId, first.approvalId, "another campaign is another request");
	});

	test("over MCP it is a result, not an error, with the same fields and the same stored shape", async () => {
		const restId = await addDraft(m, owner.keys.send_with_approval);
		const mcpId = await addDraft(m, owner.keys.send_with_approval);
		const rest = (await api(owner.keys.send_with_approval, "POST", `/campaigns/${restId}/send`, {})).body;
		const result = await callTool(m, owner.keys.send_with_approval, "send_campaign", { id: mcpId });
		assert.notEqual(result.isError, true);
		assert.deepEqual(Object.keys(result.structuredContent).sort(), Object.keys(rest).sort());
		assert.equal(result.structuredContent.status, "approval_required");
		assert.equal(JSON.parse(result.content[0].text).approvalId, result.structuredContent.approvalId);

		const [a, b] = await Promise.all([stored(rest.approvalId), stored(result.structuredContent.approvalId)]);
		assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), "the same fields");
		for (const field of ["status", "actorType", "actorName", "action", "className", "reason", "preview"]) {
			assert.deepEqual(a[field].lines ? a[field].lines.map(([label]) => label) : a[field], b[field].lines ? b[field].lines.map(([label]) => label) : b[field], field);
		}
		assert.deepEqual([a.via, b.via], ["api", "mcp"]);
		assert.deepEqual(b.input, { id: mcpId });
	});

	test("an agent reads its request by ID and in a list, and no other key can", async () => {
		const first = await propose(owner.keys.send_with_approval, await addDraft(m, owner.keys.send_with_approval));
		const read = await status(owner.keys.send_with_approval, first.approvalId);
		assert.deepEqual([read.status, read.executed, read.note, read.retryAfter, read.result], ["pending", false, null, 30, null]);
		assert.equal(read.statusUrl, first.statusUrl);
		assert.equal((await api(owner.keys.full, "GET", `/approvals/${first.approvalId}`)).status, 404, "another key");
		assert.equal((await api(owner.keys.read_only, "GET", `/approvals/${first.approvalId}`)).status, 404, "a read only key too");
		const listed = await api(owner.keys.send_with_approval, "GET", "/approvals?status=pending");
		assert.ok(listed.body.approvals.some(({ id }) => id === first.approvalId));
		assert.equal((await api(owner.keys.full, "GET", "/approvals")).body.approvals.length, 0);
		const viaMcp = await callTool(m, owner.keys.send_with_approval, "get_approval_status", { id: first.approvalId });
		assert.equal(viaMcp.structuredContent.status, "pending");
	});

	test("the queue has a limit, so a runaway agent can't fill it", async () => {
		const key = await makeKey(m, owner, "send_with_approval", { name: "Runaway" });
		const answers = [];
		for (let index = 0; index < 11; index++) answers.push(await api(key, "DELETE", `/campaigns/${await addDraft(m, key)}`));
		assert.equal(answers.filter(({ status: code }) => code === 202).length, 10);
		assert.equal(answers.at(-1).status, 409);
		assert.match(errorOf(answers.at(-1)).message, /already waiting/);
	});
});

describe("deciding", () => {
	test("approving runs the action once, as the key that asked, and the agent reads the result and the note", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, id);
		const result = await decide(owner, approvalId, "approve", "Go ahead");
		assert.equal(result.error, undefined, JSON.stringify(result));
		assert.deepEqual([result.approval.status, result.approval.executed, result.approval.note, result.stale], ["approved", true, "Go ahead", null]);
		assert.equal((await campaign(id)).status, "canceled", "the stored action ran");

		const read = await status(owner.keys.send_with_approval, approvalId);
		assert.deepEqual([read.status, read.executed, read.note, read.execution.state, read.retryAfter], ["approved", true, "Go ahead", "done", null]);
		assert.equal(read.result.deleted ?? read.result.id, read.result.deleted ?? id);

		const log = await m.AgentActivity.find({ accountId: owner.accountId, approvalId }).sort({ createdAt: 1 }).lean();
		assert.deepEqual(log.map(({ status: s }) => s), ["proposed", "approved", "executed"]);
		const acted = await m.AgentActivity.findOne({ accountId: owner.accountId, kind: "call", action: "delete_campaign", status: "ok", summary: new RegExp(id) }).lean();
		assert.equal(acted?.actorName, "send_with_approval key", "the action ran as the key and is logged as its call");
	});

	test("a double submit and a retry run it once", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, id);
		const before = newDeliveries().length;
		const [a, b] = await Promise.all([decide(owner, approvalId, "approve"), decide(owner, approvalId, "approve")]);
		const c = await decide(owner, approvalId, "approve");
		for (const result of [a, b, c]) assert.equal(result.approval.status, "approved");
		assert.equal(await m.AgentActivity.countDocuments({ accountId: owner.accountId, approvalId, status: "executed" }), 1);
		assert.equal(await m.AgentActivity.countDocuments({ accountId: owner.accountId, kind: "call", action: "delete_campaign", status: "ok", summary: new RegExp(id) }), 1, "the action ran once");
		assert.equal(before, 0);
		assert.equal((await decide(owner, approvalId, "reject")).error, "This request was already approved.", "and it can't be turned around");
	});

	test("rejecting runs nothing and the agent reads why", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, id);
		const result = await decide(owner, approvalId, "reject", "Not this one: wrong audience");
		assert.deepEqual([result.approval.status, result.approval.executed], ["rejected", false]);
		assert.equal((await campaign(id)).status, "draft");
		const read = await status(owner.keys.send_with_approval, approvalId);
		assert.deepEqual([read.status, read.note, read.executed, read.result], ["rejected", "Not this one: wrong audience", false, null]);
		assert.equal((await decide(owner, approvalId, "approve")).error, "This request was already rejected.");
		assert.equal((await campaign(id)).status, "draft");
	});

	test("a request nobody decided in 24 hours is expired, and approving it then runs nothing", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, id);
		await m.ApprovalRequest.updateOne({ _id: approvalId, accountId: owner.accountId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		assert.equal((await status(owner.keys.send_with_approval, approvalId)).status, "expired", "expired the moment its time is up");
		const result = await decide(owner, approvalId, "approve");
		assert.equal(result.approval.status, "expired");
		assert.equal((await campaign(id)).status, "draft");
		assert.equal((await stored(approvalId)).pendingKey, undefined, "the same ask can be made again");
		const again = await propose(owner.keys.send_with_approval, id);
		assert.notEqual(again.approvalId, approvalId);
	});

	test("the hourly sweep expires what is left and tells the agent", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, id);
		await m.ApprovalRequest.updateOne({ _id: approvalId, accountId: owner.accountId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		const run = await m.housekeeping.runAgentHousekeeping();
		assert.ok(run.expired >= 1, JSON.stringify(run));
		assert.equal((await stored(approvalId)).status, "expired");
		assert.equal((await m.housekeeping.runAgentHousekeeping()).expired, 0, "once");
		assert.equal(await m.AgentActivity.countDocuments({ accountId: owner.accountId, approvalId, status: "expired" }), 1);
	});

	test("if the campaign was edited since the request, approving asks again, and runs only once the owner has seen it", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, id);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal((await api(owner.keys.drafts, "PATCH", `/campaigns/${id}`, { subject: "Changed after the request" })).status, 200);

		const first = await decide(owner, approvalId, "approve");
		assert.match(first.stale, /it was edited/);
		assert.equal(first.approval.status, "pending", "nothing was approved");
		assert.equal((await campaign(id)).status, "draft");
		const second = await decide(owner, approvalId, "approve", "Saw it", true);
		assert.deepEqual([second.approval.status, second.approval.executed], ["approved", true]);
	});

	test("the stored input can't change: a tampered request is not run, and no call edits one", async () => {
		const mine = await addDraft(m, owner.keys.send_with_approval);
		const victim = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, mine);
		const hash = (await stored(approvalId)).inputHash;
		for (const method of ["PATCH", "POST", "DELETE"]) {
			const attempt = await api(owner.keys.full, method, `/approvals/${approvalId}`, { input: { id: victim } });
			assert.equal(attempt.status, 404, `${method} on an approval`);
		}
		await m.ApprovalRequest.updateOne({ _id: approvalId, accountId: owner.accountId }, { $set: { input: { id: victim } } });
		assert.match((await decide(owner, approvalId, "approve")).stale, /./, "the change is noticed even before the hash is");
		const result = await decide(owner, approvalId, "approve", "", true);
		assert.equal(result.approval.execution.state, "failed");
		assert.equal(result.approval.execution.error.code, "conflict");
		assert.match(result.approval.execution.error.message, /doesn't match its hash/);
		assert.equal((await campaign(victim)).status, "draft", "the tampered input did not run");
		assert.equal((await stored(approvalId)).inputHash, hash);
		const read = await status(owner.keys.send_with_approval, approvalId);
		assert.deepEqual([read.status, read.executed, read.execution.error.code], ["approved", false, "conflict"]);
	});

	test("a key revoked before the owner decides can't have its request run", async () => {
		const key = await makeKey(m, owner, "send_with_approval", { name: "Soon revoked" });
		const id = await addDraft(m, key);
		const { approvalId } = await propose(key, id);
		const doc = await m.ApiKey.findOne({ accountId: owner.accountId, name: "Soon revoked" }).lean();
		await as(owner, () => m.apiKeys.revokeApiKey(String(doc._id)));
		const result = await decide(owner, approvalId, "approve");
		assert.equal(result.approval.execution.error.code, "unauthorized");
		assert.equal((await campaign(id)).status, "draft");
	});

	test("the agent hears of the decision by webhook", async () => {
		const endpoint = await api(owner.keys.full, "POST", "/webhooks", { url: RECEIVER, events: ["approval.decided"] });
		assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
		newDeliveries();
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = await propose(owner.keys.send_with_approval, id);
		await decide(owner, approvalId, "approve", "Fine");
		await flushAfter();
		const [job] = newDeliveries();
		assert.ok(job, "a delivery was queued");
		let sent;
		await m.webhooks.deliverWebhook(job.body, { fetchImpl: async (_url, init) => ((sent = JSON.parse(init.body)), new Response("ok")) });
		assert.equal(sent.type, "approval.decided");
		assert.deepEqual(
			{ ...sent.data.approval, decidedAt: typeof sent.data.approval.decidedAt },
			{
				id: approvalId,
				newsletterId: owner.newsletterId,
				action: "delete_campaign",
				summary: sent.data.approval.summary,
				status: "approved",
				note: "Fine",
				decidedAt: "string",
				executed: true,
				error: null,
				actor: { type: "key", id: sent.data.approval.actor.id, name: "send_with_approval key" },
			}
		);

		const rejected = await propose(owner.keys.send_with_approval, await addDraft(m, owner.keys.send_with_approval));
		await decide(owner, rejected.approvalId, "reject", "No");
		await flushAfter();
		const [second] = newDeliveries();
		await m.webhooks.deliverWebhook(second.body, { fetchImpl: async (_url, init) => ((sent = JSON.parse(init.body)), new Response("ok")) });
		assert.deepEqual([sent.data.approval.status, sent.data.approval.executed], ["rejected", false]);

		const lapsed = await propose(owner.keys.send_with_approval, await addDraft(m, owner.keys.send_with_approval));
		await m.ApprovalRequest.updateOne({ _id: lapsed.approvalId, accountId: owner.accountId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		await m.housekeeping.runAgentHousekeeping();
		await flushAfter();
		const [third] = newDeliveries();
		await m.webhooks.deliverWebhook(third.body, { fetchImpl: async (_url, init) => ((sent = JSON.parse(init.body)), new Response("ok")) });
		assert.deepEqual([sent.data.approval.id, sent.data.approval.status, sent.data.approval.executed], [lapsed.approvalId, "expired", false], "an expiry is told too");
	});
});

describe("nobody approves their own request", () => {
	test("no key, app or tool can decide, and the REST API has no route for it", async () => {
		const { approvalId } = await propose(owner.keys.send_with_approval, await addDraft(m, owner.keys.send_with_approval));
		for (const level of ["send_with_approval", "full", "drafts"]) {
			const key = owner.keys[level];
			assert.equal((await api(key, "POST", `/approvals/${approvalId}/decide`, { decision: "approve" })).status, 404, `${level}: no such route`);
			assert.equal((await api(key, "PATCH", "/agent-approval", { newsletter: owner.slug, required: false })).status, 404);
			const tools = (await mcp(m, key, "tools/list")).body.result.tools.map(({ name }) => name);
			assert.ok(!tools.includes("decide_approval") && !tools.includes("set_agent_approval"), level);
			const called = await mcp(m, key, "tools/call", { name: "decide_approval", arguments: { id: approvalId, decision: "approve" } });
			assert.ok(called.body.error || called.body.result?.isError, "an unknown tool");
		}
		const account = await m.Account.findById(owner.accountId).lean();
		const apiKey = await m.ApiKey.findOne({ accountId: owner.accountId, name: "full key" }).lean();
		for (const via of ["api", "mcp"]) {
			await assert.rejects(m.runAction("decide_approval", { account, apiKey, via, input: { id: approvalId, decision: "approve" } }), { code: "forbidden", message: /only be done by a person/ });
			await assert.rejects(m.runAction("decide_approval", { account, connection: { id: "6650f1c2e9b1d4a012345678", clientId: "https://app.example.com/c.json", name: "An app", level: "full" }, via, input: { id: approvalId, decision: "approve" } }), { code: "forbidden" });
		}
		assert.equal((await stored(approvalId)).status, "pending", "still waiting for a person");
		const doc = (await import("../lib/docs/openapi.js")).getOpenApiDocument("http://localhost:3000");
		const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map(({ operationId }) => operationId));
		assert.ok(!operations.includes("decide_approval") && !operations.includes("set_agent_approval") && !Object.keys(doc.paths).some((path) => path.endsWith("/decide")), "the API document doesn't list it");
	});

	test("another account's owner can't decide it either", async () => {
		const { approvalId } = await propose(owner.keys.send_with_approval, await addDraft(m, owner.keys.send_with_approval));
		const stranger = await agentOwner(m, "agent-approvals-stranger@example.com");
		const result = await decide(stranger, approvalId, "approve");
		assert.equal(result.error, "Approval not found");
		assert.equal((await stored(approvalId)).status, "pending");
	});
});

describe("a newsletter that asks", () => {
	test("turned on in the dashboard, even a full key waits; turned off, it doesn't; and no key can turn it off", async () => {
		const key = owner.keys.full;
		const direct = await addDraft(m, key);
		assert.equal((await api(key, "DELETE", `/campaigns/${direct}`)).status, 200, "a full key deletes at once while nothing asks");

		const on = await as(owner, () => m.approvals.setAgentApproval(owner.newsletterId, true));
		assert.deepEqual(on, { required: true });
		const id = await addDraft(m, key);
		const waiting = await api(key, "DELETE", `/campaigns/${id}`);
		assert.equal(waiting.status, 202);
		assert.equal((await stored(waiting.body.approvalId)).reason, "newsletter");
		assert.equal((await campaign(id)).status, "draft");
		assert.equal((await api(key, "POST", "/campaigns", { subject: "Drafting is free", content: "x" })).status, 201, "drafting isn't a send");
		assert.equal((await api(key, "PATCH", `/newsletters/${owner.newsletterId}`, { description: "Still allowed" })).status, 200, "nor is a setting");
		const otherNewsletter = await addDraft(m, key, { newsletter: owner.otherSlug });
		assert.equal((await api(key, "DELETE", `/campaigns/${otherNewsletter}`)).status, 200, "the other newsletter doesn't ask");

		const unchanged = await api(key, "PATCH", `/newsletters/${owner.newsletterId}`, { agentApproval: false });
		assert.ok(unchanged.status === 400 || (await m.Newsletter.findOne({ _id: owner.newsletterId, accountId: owner.accountId }).lean()).agentApproval === true, "update_newsletter can't switch it off");

		await as(owner, () => m.approvals.setAgentApproval(owner.newsletterId, false));
		assert.equal((await api(key, "DELETE", `/campaigns/${id}`)).status, 200, "off again");
	});
});

describe("size", () => {
	test("a test email to addresses the agent names waits, and shows the owner where it would go", async () => {
		const key = owner.keys.send_with_approval;
		const id = await addDraft(m, key, { subject: "Test me" });
		const waiting = await api(key, "POST", `/campaigns/${id}/test`, { to: ["stranger@example.org"] });
		assert.equal(waiting.status, 202);
		const row = await stored(waiting.body.approvalId);
		assert.equal(row.className, "send");
		const lines = Object.fromEntries(row.preview.lines);
		assert.deepEqual([lines.Subject, lines["Goes to"]], ["[Test] Test me", "stranger@example.org"]);
		const toOwner = await api(key, "POST", `/campaigns/${id}/test`, {});
		assert.notEqual(toOwner.status, 202, "a test to the owner is part of drafting");
	});

	test("signups keep coming in from a website's key, and a send with approval key adding contacts one by one stops at the day's limit", async () => {
		const site = owner.keys.signups;
		for (let index = 0; index < 5; index++) assert.equal((await api(site, "POST", "/contacts", { email: `site${index}@signups.example.org`, newsletter: owner.slug })).status, 201);
		const key = await makeKey(m, owner, "send_with_approval", { name: "Adder" });
		let waiting = 0;
		for (let index = 0; index < 105; index++) {
			const answer = await api(key, "POST", "/contacts", { email: `adder${index}@signups.example.org`, newsletter: owner.slug });
			if (answer.status === 202) waiting++;
			else assert.equal(answer.status, 201, JSON.stringify(answer.body));
		}
		assert.equal(waiting, 5, "the first 100 of the day go in, the rest wait for the owner");
	});

	test("a send with approval key's big import waits, and many small ones in a day add up to one", async () => {
		const key = await makeKey(m, owner, "send_with_approval", { name: "Importer" });
		const rows = (count, tag) => Array.from({ length: count }, (_, index) => ({ email: `${tag}${index}@import.example.org` }));
		const big = await api(key, "POST", "/contacts/import", { newsletter: owner.slug, consent: true, contacts: rows(30, "big") });
		assert.equal(big.status, 202);
		const row = await stored(big.body.approvalId);
		assert.deepEqual([row.reason, row.className, row.action], ["scale", "write", "import_contacts"]);
		assert.equal(Object.fromEntries(row.preview.lines)["Contacts in this call"], "30");
		assert.equal(await m.Contact.countDocuments({ accountId: owner.accountId, email: /@import\.example\.org$/ }), 0, "not imported");

		let waiting = 0;
		for (let call = 0; call < 8; call++) {
			const answer = await api(key, "POST", "/contacts/import", { newsletter: owner.slug, consent: true, contacts: rows(20, `small${call}x`) });
			if (answer.status === 202) waiting++;
			else assert.equal(answer.status, 200);
		}
		assert.ok(waiting >= 3 && waiting <= 4, `20 contacts at a time stop at the day's 100 (${waiting} waited)`);
		const approved = await decide(owner, big.body.approvalId, "approve");
		assert.equal(approved.approval.executed, true, JSON.stringify(approved.approval.execution));
		assert.ok((await m.Contact.countDocuments({ accountId: owner.accountId, email: /^big\d+@import\.example\.org$/ })) > 0, "imported once approved");
	});
});

describe("an agent changes drafts, not what the owner approved to go out", () => {
	test("a scheduled campaign can't be edited by an agent that asks, nor by a full key while the newsletter asks", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		await m.Campaign.updateOne({ _id: id, accountId: owner.accountId }, { $set: { status: "scheduled", scheduledAt: new Date(Date.now() + 3_600_000) } });
		const refused = await api(owner.keys.send_with_approval, "PATCH", `/campaigns/${id}`, { subject: "Swapped after approval" });
		assert.equal(refused.status, 409);
		assert.match(errorOf(refused).message, /only while it is draft/);
		assert.equal((await api(owner.keys.full, "PATCH", `/campaigns/${id}`, { subject: "A full key edits" })).status, 200, "full access, with nothing asking");
		await as(owner, () => m.approvals.setAgentApproval(owner.newsletterId, true));
		assert.equal((await api(owner.keys.full, "PATCH", `/campaigns/${id}`, { subject: "Now it asks" })).status, 409);
		await as(owner, () => m.approvals.setAgentApproval(owner.newsletterId, false));
	});
});
