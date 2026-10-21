import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, callTool, errorOf, loadAgentModules } from "./helpers/agents.mjs";

// The agent activity log: what is recorded and what never is, who can read it, and how it is kept down to 90 days.
let app;
let m;
let owner;

const DAY = 86_400_000;
const entries = (filter = {}) => m.AgentActivity.find({ accountId: owner.accountId, ...filter }).sort({ createdAt: 1 }).lean();

before(async () => {
	app = await startTestApp();
	m = await loadAgentModules();
	owner = await agentOwner(m, "agent-activity@example.com");
});

after(() => app?.stop());

describe("what is recorded", () => {
	test("a call that changes something: the action, who, which newsletter, how it ended, a summary and the request's ID", async () => {
		const created = await api(owner.keys.drafts, "POST", "/campaigns", { subject: "A private subject line", content: "Secret body text", newsletter: owner.slug });
		assert.equal(created.status, 201);
		const [entry] = await entries({ action: "create_campaign" });
		assert.deepEqual(
			[entry.kind, entry.actorType, entry.actorName, entry.via, entry.action, entry.className, String(entry.newsletterId), entry.status],
			["call", "key", "drafts key", "api", "create_campaign", "write-draft", owner.newsletterId, "ok"]
		);
		assert.equal(entry.requestId, created.headers.get("x-request-id"));
		assert.match(entry.summary, /^Create a draft campaign \(newsletter: /);
		assert.ok(entry.actorId.length === 24 && entry.createdAt instanceof Date);
	});

	test("never what the call said: no subject, body or address, only ids, options and counts", async () => {
		await api(owner.keys.full, "POST", "/contacts", { email: "jane.private@example.org", newsletter: owner.slug });
		await api(owner.keys.full, "POST", "/contacts/import", { newsletter: owner.slug, consent: true, contacts: [{ email: "one.private@example.org" }, { email: "two.private@example.org" }] });
		await api(owner.keys.full, "PATCH", `/newsletters/${owner.newsletterId}`, { description: "A private description", fromName: "Private Sender" });
		const all = JSON.stringify(await entries());
		for (const secret of ["private@example.org", "A private subject line", "Secret body text", "A private description", "Private Sender"]) {
			assert.ok(!all.includes(secret), `${secret} is in the log`);
		}
		const imported = (await entries({ action: "import_contacts" }))[0];
		assert.match(imported.summary, /contacts: 2/);
		assert.match(imported.summary, /consent: true/);
	});

	test("a call that shows contact data is recorded too; one that only reads numbers is counted, not listed", async () => {
		const before = (await entries()).length;
		await api(owner.keys.read_only, "GET", "/campaigns");
		await api(owner.keys.read_only, "GET", "/overview");
		assert.equal((await entries()).length, before, "reading campaigns isn't recorded");
		await api(owner.keys.read_only, "GET", "/contacts");
		const [listed] = (await entries({ action: "list_contacts" })).slice(-1);
		assert.deepEqual([listed.actorName, listed.className, listed.status], ["read_only key", "read", "ok"]);
		const day = await m.AgentDay.findOne({ accountId: owner.accountId, actorId: listed.actorId }).lean();
		assert.equal(day.calls, 3, "all three are in the day's count");
		assert.equal(day.changes, 0);
	});

	test("a website's signups only key is counted, not listed one by one", async () => {
		const before = (await entries()).length;
		await api(owner.keys.signups, "POST", "/contacts", { email: "visitor@site.example.org", newsletter: owner.slug });
		await api(owner.keys.signups, "GET", "/campaigns");
		assert.equal((await entries()).length, before);
		const doc = await m.ApiKey.findOne({ accountId: owner.accountId, name: "signups key" }).lean();
		const day = await m.AgentDay.findOne({ accountId: owner.accountId, actorId: String(doc._id) }).lean();
		assert.deepEqual([day.calls, day.changes, day.denied], [2, 1, 1]);
	});

	test("what was refused, and what failed, with the code", async () => {
		await api(owner.keys.read_only, "POST", "/campaigns", { subject: "No" });
		const missing = await api(owner.keys.drafts, "PATCH", "/campaigns/6650f1c2e9b1d4a012345678", { subject: "Missing" });
		assert.equal(errorOf(missing).code, "not_found");
		const denied = (await entries({ action: "create_campaign", status: "denied" }))[0];
		assert.deepEqual([denied.actorName, denied.errorCode], ["read_only key", "forbidden"]);
		const failed = (await entries({ action: "update_campaign", status: "failed" }))[0];
		assert.equal(failed.errorCode, "not_found");
		const day = await m.AgentDay.findOne({ accountId: owner.accountId, actorId: denied.actorId }).lean();
		assert.ok(day.denied >= 1);
	});

	test("a call over MCP carries its channel, and the dashboard's own changes are not an agent's", async () => {
		await callTool(m, owner.keys.drafts, "create_campaign", { subject: "Over MCP", content: "x" });
		assert.equal((await entries({ action: "create_campaign", via: "mcp" })).length, 1);
		const before = (await entries()).length;
		await as(owner, () => m.approvals.setAgentApproval(owner.newsletterId, false));
		assert.equal((await entries()).length, before);
	});
});

describe("who can read it", () => {
	test("a key reads only its own entries; the dashboard reads everyone's, filtered", async () => {
		const own = await api(owner.keys.drafts, "GET", "/agent-activity");
		assert.equal(own.status, 200);
		assert.ok(own.body.activity.length > 0 && own.body.activity.every(({ actor }) => actor.name === "drafts key"));
		const askedForAll = await api(owner.keys.drafts, "GET", `/agent-activity?actor=${(await entries({ actorName: "full key" }))[0].actorId}`);
		assert.ok(askedForAll.body.activity.every(({ actor }) => actor.name === "drafts key"), "naming another key shows nothing of it");
		assert.ok(own.body.daily.length >= 1 && own.body.daily[0].calls >= 1, "the day's counts");

		const account = await m.Account.findById(owner.accountId).lean();
		const everyone = await m.runAction("list_agent_activity", { account, via: "dashboard", input: {} });
		assert.ok(new Set(everyone.activity.map(({ actor }) => actor.name)).size >= 3);
		const one = await m.runAction("list_agent_activity", { account, via: "dashboard", input: { action: "import_contacts" } });
		assert.deepEqual(one.activity.map(({ action }) => action), ["import_contacts"]);
		const byNewsletter = await m.runAction("list_agent_activity", { account, via: "dashboard", input: { newsletter: owner.otherSlug } });
		assert.deepEqual(byNewsletter.activity, []);
		const failed = await m.runAction("list_agent_activity", { account, via: "dashboard", input: { status: "denied" } });
		assert.ok(failed.activity.length >= 1 && failed.activity.every(({ status }) => status === "denied"));
	});

	test("pages of it follow a cursor without repeating or skipping", async () => {
		const account = await m.Account.findById(owner.accountId).lean();
		const seen = [];
		let cursor;
		do {
			const page = await m.runAction("list_agent_activity", { account, via: "dashboard", input: { limit: 3, ...(cursor && { cursor }) } });
			seen.push(...page.activity.map(({ id }) => id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.equal(new Set(seen).size, seen.length, "no entry twice");
		assert.equal(seen.length, await m.AgentActivity.countDocuments({ accountId: owner.accountId }));
	});

	test("another account's keys see nothing of it", async () => {
		const stranger = await agentOwner(m, "agent-activity-stranger@example.com");
		await api(stranger.keys.full, "GET", "/contacts");
		const theirs = await api(stranger.keys.full, "GET", "/agent-activity");
		assert.ok(theirs.body.activity.every(({ actor }) => actor.name === "full key"));
		assert.equal(theirs.body.activity.filter(({ action }) => action === "import_contacts").length, 0);
	});
});

describe("how long it is kept", () => {
	test("the hourly cron deletes what is 90 days old and keeps the rest, in the log, the day counts and the approvals", async () => {
		const old = new Date(Date.now() - 91 * DAY);
		const recent = new Date(Date.now() - 89 * DAY);
		const row = (createdAt) => ({ accountId: owner.accountId, kind: "call", actorType: "key", actorId: "a".repeat(24), actorName: "Old", action: "list_contacts", status: "ok", summary: "List contacts", createdAt });
		await m.AgentActivity.collection.insertMany([row(old), row(old), row(recent)]);
		await m.AgentDay.create({ accountId: owner.accountId, actorId: "a".repeat(24), actorType: "key", day: old.toISOString().slice(0, 10), calls: 5 });
		await m.AgentDay.create({ accountId: owner.accountId, actorId: "a".repeat(24), actorType: "key", day: recent.toISOString().slice(0, 10), calls: 5 });

		const key = owner.keys.send_with_approval;
		const ancient = await api(key, "DELETE", `/campaigns/${await addDraft(m, key)}`);
		await m.ApprovalRequest.updateOne({ _id: ancient.body.approvalId, accountId: owner.accountId }, { $set: { createdAt: old, status: "rejected" } });

		const run = await m.housekeeping.runAgentHousekeeping();
		assert.equal(run.activity, 2);
		assert.equal(run.days, 1);
		assert.equal(run.approvalsDeleted, 1);
		assert.equal(await m.AgentActivity.countDocuments({ accountId: owner.accountId, actorName: "Old" }), 1);
		assert.equal(await m.AgentDay.countDocuments({ accountId: owner.accountId, actorId: "a".repeat(24) }), 1);
		assert.equal(await m.ApprovalRequest.countDocuments({ accountId: owner.accountId, _id: ancient.body.approvalId }), 0);
		assert.deepEqual(await m.housekeeping.runAgentHousekeeping().then(({ activity, days }) => [activity, days]), [0, 0], "once");
	});

	test("a decided request keeps its summary and hash but loses its input and result after a week", async () => {
		const key = owner.keys.send_with_approval;
		const waiting = await api(key, "DELETE", `/campaigns/${await addDraft(m, key)}`);
		const decided = await as(owner, () => m.approvals.decideApproval(waiting.body.approvalId, "approve"));
		assert.equal(decided.approval.executed, true);
		const pending = await api(key, "DELETE", `/campaigns/${await addDraft(m, key)}`);
		const aWeekAgo = new Date(Date.now() - 9 * DAY);
		await m.ApprovalRequest.updateMany({ accountId: owner.accountId, _id: { $in: [waiting.body.approvalId, pending.body.approvalId] } }, { $set: { createdAt: aWeekAgo } });
		await m.ApprovalRequest.updateOne({ _id: pending.body.approvalId, accountId: owner.accountId }, { $set: { expiresAt: new Date(Date.now() + DAY) } });

		await m.housekeeping.runAgentHousekeeping();
		const kept = await m.ApprovalRequest.findOne({ _id: waiting.body.approvalId, accountId: owner.accountId }).lean();
		assert.equal(kept.input, undefined);
		assert.equal(kept.execution.result, undefined);
		assert.match(kept.inputHash, /^[a-f0-9]{64}$/);
		assert.ok(kept.summary && kept.scrubbedAt);
		assert.deepEqual((await m.ApprovalRequest.findOne({ _id: pending.body.approvalId, accountId: owner.accountId }).lean()).input.id, pending.body.summary.match(/[a-f0-9]{24}/)[0], "a pending one keeps its input: it still has to run");
	});
});
