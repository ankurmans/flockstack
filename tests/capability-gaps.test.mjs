import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "../lib/docdb/index.js";
import { as, callApi, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, callTool, errorOf, loadAgentModules } from "./helpers/agents.mjs";

// The capability gaps of docs/capability-gaps/STATUS.md: approval for every credential by default (G1), team approvers and a code
// to approve (G2), the activity log's clients, export, audit read and retention (G3), a key limited to chosen actions (G4), an app
// limited to one newsletter (G5), a key's IP allow-list (G6) and the rate limit's headers (G7).
let app;
let m;
let safe;
let relaxed;

const ownerOf = (user) => ({ id: String(user.userId), email: user.email, emailVerified: true, name: "" });
const accountOf = (user) => m.Account.findById(user.accountId).lean();
const run = async (user, name, input, extra = {}) => m.runAction(name, { account: await accountOf(user), user: ownerOf(user), input, via: "dashboard", ...extra });

async function createKey(user, input) {
	const { key } = await run(user, "create_api_key", { name: input.name ?? `${input.level} restricted`, ...input });
	return key;
}

// An app connected with OAuth, as the consent page leaves it: its level and, if the owner picked one, its newsletter.
async function connectApp(user, { level = "full", newsletterId = null, name = "Claude" } = {}) {
	const { toConnection, OAUTH_MODELS } = await import("../lib/oauth-apps.js");
	const consent = {
		_id: new mongoose.Types.ObjectId(),
		userId: new mongoose.Types.ObjectId(String(user.userId)),
		clientId: `https://${name.toLowerCase()}.example.com/client`,
		scopes: ["flockstack:full"],
		flockstackClientName: name,
		flockstackLevel: level,
		...(newsletterId && { flockstackNewsletterId: newsletterId }),
		createdAt: new Date(),
	};
	await mongoose.connection.db.collection(OAUTH_MODELS.consent).insertOne(consent);
	return toConnection(consent);
}

before(async () => {
	app = await startTestApp();
	m = await loadAgentModules();
	m.activity = await import("../lib/agent-activity.js");
	m.rules = await import("../lib/agent-activity-rules.js");
	m.TeamSeat = (await import("../models/TeamSeat.js")).default;
	safe = await agentOwner(m, "gaps-safe@example.com", { approvalByDefault: true });
	relaxed = await agentOwner(m, "gaps-relaxed@example.com");
	await m.Contact.insertMany(
		Array.from({ length: 3 }, (_, index) => ({ accountId: safe.accountId, newsletterId: safe.newsletterId, email: `reader${index}@gaps.example.org`, status: "active" }))
	);
});

after(() => app?.stop());

describe("G1: approval for every credential, by default", () => {
	test("an account made from now on has the default", async () => {
		const ownerId = new mongoose.Types.ObjectId();
		assert.equal(await (await import("../lib/accounts.js")).createAccount(ownerId), true);
		assert.equal((await m.Account.findOne({ ownerId }).lean()).agentApprovalByDefault, true);
	});

	test("a new account's newsletters ask before an agent sends, and an older account's don't until the owner says so", async () => {
		const account = await accountOf(safe);
		assert.equal(account.agentApprovalByDefault, true);
		const newsletter = await m.Newsletter.findOne({ _id: safe.newsletterId, accountId: safe.accountId }).lean();
		assert.equal(newsletter.agentApproval, true);
		assert.ok(newsletter.agentApprovalChangedAt);

		await m.Account.updateOne({ _id: safe.accountId }, { $unset: { agentApprovalByDefault: 1 } });
		const older = await run(safe, "create_newsletter", { name: "From before", slug: "gaps-from-before", postalAddress: "1 Main St, Paris" });
		const created = await m.Newsletter.findOne({ _id: older.id, accountId: safe.accountId }).lean();
		assert.equal(created.agentApproval, undefined, "an account from before keeps what its keys did");
		await m.Account.updateOne({ _id: safe.accountId }, { $set: { agentApprovalByDefault: true } });
	});

	for (const level of ["send_with_approval", "full"]) {
		test(`an API key with ${level} access waits for approval to send, and it runs once approved`, async () => {
			const id = await addDraft(m, safe.keys[level]);
			const answer = await api(safe.keys[level], "POST", `/campaigns/${id}/send`, {});
			assert.equal(answer.status, 202, JSON.stringify(answer.body));
			assert.equal(answer.body.status, "approval_required");
			assert.equal((await m.Campaign.findOne({ _id: id, accountId: safe.accountId }).lean()).status, "draft", "nothing went out");
			const stored = await m.ApprovalRequest.findOne({ _id: answer.body.approvalId, accountId: safe.accountId }).lean();
			assert.equal(stored.reason, level === "full" ? "newsletter" : "key");
			const decided = await run(safe, "decide_approval", { id: answer.body.approvalId, decision: "approve" });
			assert.equal(decided.approval.executed, true, JSON.stringify(decided.approval.execution));
			assert.notEqual((await m.Campaign.findOne({ _id: id, accountId: safe.accountId }).lean()).status, "draft", "it ran once approved");
		});
	}

	for (const level of ["read_only", "drafts", "signups"]) {
		test(`an API key with ${level} access can't send at all`, async () => {
			const id = await addDraft(m, safe.keys.full);
			assert.equal((await api(safe.keys[level], "POST", `/campaigns/${id}/send`, {})).status, 403);
		});
	}

	test("an MCP session with a full key waits too", async () => {
		const id = await addDraft(m, safe.keys.full);
		const result = await callTool(m, safe.keys.full, "delete_campaign", { id });
		assert.equal(result.structuredContent?.status, "approval_required", JSON.stringify(result));
		assert.equal((await m.Campaign.findOne({ _id: id, accountId: safe.accountId }).lean()).status, "draft");
	});

	test("a connected OAuth app with full access waits, and runs as itself once approved", async () => {
		const connection = await connectApp(safe, { name: "Claude" });
		const id = await addDraft(m, safe.keys.full);
		const account = await accountOf(safe);
		const answer = await m.runAction("delete_campaign", { account, connection, input: { id }, via: "mcp" });
		assert.equal(answer.status, "approval_required");
		const decided = await run(safe, "decide_approval", { id: answer.approvalId, decision: "approve" });
		assert.equal(decided.approval.executed, true);
		const ran = await m.AgentActivity.findOne({ accountId: safe.accountId, kind: "call", action: "delete_campaign", actorType: "app", status: "ok" }).lean();
		assert.equal(ran?.actorName, "Claude");
	});

	test("billing changes wait too, for a full key on a newsletter that asks", async () => {
		const answer = await api(safe.keys.full, "POST", "/billing/change-plan", { plan: "growth" });
		assert.equal(answer.status, 202, JSON.stringify(answer.body));
		assert.equal((await m.ApprovalRequest.findOne({ _id: answer.body.approvalId, accountId: safe.accountId }).lean()).reason, "newsletter");
	});

	test("relaxing it is the owner's, in the dashboard, and is recorded with who did it", async () => {
		const key = await api(safe.keys.full, "PATCH", "/agent-approval", { newsletter: safe.otherNewsletterId, required: false });
		assert.ok([403, 404].includes(key.status), "no key can switch it off");
		const result = await run(safe, "set_agent_approval", { newsletter: safe.otherNewsletterId, required: false });
		assert.equal(result.required, false);
		const entry = await m.AgentActivity.findOne({ accountId: safe.accountId, kind: "setting", action: "set_agent_approval" }).lean();
		assert.deepEqual([entry.actorType, entry.status, entry.summary, String(entry.newsletterId)], ["person", "ok", "Ask before agents send: off", safe.otherNewsletterId]);
		assert.match(entry.actorName, /\(owner\)$/);
		const id = await addDraft(m, safe.keys.full, { newsletter: safe.otherSlug });
		assert.equal((await api(safe.keys.full, "DELETE", `/campaigns/${id}`)).status, 200, "relaxed, a full key's own level decides again");
		await run(safe, "set_agent_approval", { newsletter: safe.otherNewsletterId, required: true });
	});
});

describe("G2: team approvers and a code to approve", () => {
	let member;
	let seatId;
	const memberUser = () => ({ id: String(member.userId), email: member.email, emailVerified: true, name: "Sam" });
	const asMember = async (name, input) => m.runAction(name, { account: { ...(await accountOf(safe)), memberRole: "editor" }, user: memberUser(), input, via: "dashboard" });

	before(async () => {
		member = await signIn("gaps-approver@example.com");
		const invited = await run(safe, "invite_team_member", { email: member.email, role: "editor" });
		seatId = invited.id;
		const { acceptTeamInvitation } = await import("../lib/team.js");
		await acceptTeamInvitation(memberUser(), seatId);
	});

	async function waitingSend(newsletter = safe.slug) {
		const id = await addDraft(m, safe.keys.full, { newsletter });
		return (await api(safe.keys.full, "POST", `/campaigns/${id}/send`, {})).body.approvalId;
	}

	test("a team member who isn't an approver can't decide", async () => {
		const id = await waitingSend();
		await assert.rejects(asMember("decide_approval", { id, decision: "approve" }), (error) => error.code === "forbidden");
	});

	test("a named approver decides their newsletters' requests, and nothing else", async () => {
		await run(safe, "set_team_approver", { id: seatId, newsletters: [safe.slug] });
		assert.deepEqual((await m.TeamSeat.findOne({ _id: seatId, accountId: safe.accountId }).lean()).approverFor, [safe.newsletterId]);
		const theirs = await waitingSend();
		const decided = await asMember("decide_approval", { id: theirs, decision: "approve" });
		assert.equal(decided.approval.executed, true);
		const entry = await m.AgentActivity.findOne({ accountId: safe.accountId, approvalId: theirs, status: "approved" }).lean();
		assert.match(entry.summary, /approved by Sam \(editor\), signed in$/, "the log names who approved and how");

		const other = await waitingSend(safe.otherSlug);
		await assert.rejects(asMember("decide_approval", { id: other, decision: "approve" }), (error) => error.code === "forbidden", "another newsletter");
		const billing = (await api(safe.keys.full, "POST", "/billing/change-plan", { plan: "pro" })).body.approvalId;
		await assert.rejects(asMember("decide_approval", { id: billing, decision: "approve" }), (error) => error.code === "forbidden", "never billing");
		await assert.rejects(asMember("set_agent_approval", { newsletter: safe.slug, required: false }), (error) => error.code === "forbidden", "nor the rules");
		await assert.rejects(asMember("set_team_approver", { id: seatId, newsletters: [safe.otherSlug] }), (error) => error.code === "forbidden");
	});

	test("with step-up, approving a send takes the code emailed to whoever approves, once, in time", async () => {
		await run(safe, "set_approval_step_up", { required: true });
		const id = await waitingSend();
		const asked = await run(safe, "decide_approval", { id, decision: "approve" });
		assert.deepEqual([asked.stepUp, asked.approval.status], ["code_sent", "pending"]);
		const email = platformEmails.findLast(({ to }) => to.includes(safe.email));
		const code = email.subject.slice(0, 6);
		assert.match(code, /^\d{6}$/);
		await assert.rejects(run(safe, "decide_approval", { id, decision: "approve", code: code === "000000" ? "111111" : "000000" }), (error) => error.code === "forbidden");

		await m.ApprovalRequest.updateOne({ _id: id, accountId: safe.accountId }, { $set: { "stepUp.expiresAt": new Date(Date.now() - 1000) } });
		await assert.rejects(run(safe, "decide_approval", { id, decision: "approve", code }), (error) => error.code === "forbidden", "an expired code");

		await run(safe, "decide_approval", { id, decision: "approve" });
		const fresh = platformEmails.findLast(({ to }) => to.includes(safe.email)).subject.slice(0, 6);
		const decided = await run(safe, "decide_approval", { id, decision: "approve", code: fresh });
		assert.equal(decided.approval.executed, true);
		const stored = await m.ApprovalRequest.findOne({ _id: id, accountId: safe.accountId }).lean();
		assert.deepEqual([stored.decidedHow, stored.stepUp], ["code", undefined]);
		const entry = await m.AgentActivity.findOne({ accountId: safe.accountId, approvalId: id, status: "approved" }).lean();
		assert.match(entry.summary, /with a code by email$/);

		const rejected = await run(safe, "decide_approval", { id: await waitingSend(), decision: "reject" });
		assert.equal(rejected.approval.status, "rejected", "rejecting never needs a code");
		await run(safe, "set_approval_step_up", { required: false });
	});
});

describe("G3: the activity log", () => {
	test("entries name their client and filter by it; a CSV export has the same rows", async () => {
		await addDraft(m, relaxed.keys.drafts);
		const account = await accountOf(relaxed);
		const listed = await m.runAction("list_agent_activity", { account, via: "dashboard", input: { client: "drafts key" } });
		assert.ok(listed.activity.length > 0 && listed.activity.every(({ actor }) => actor.name === "drafts key"));
		const exported = await m.runAction("export_agent_activity", { account, via: "dashboard", input: { client: "drafts key" } });
		const lines = exported.csv.trim().split("\n");
		assert.equal(lines[0], "at,kind,actorType,actorId,actorName,via,action,className,newsletterId,status,errorCode,summary,requestId,approvalId");
		assert.equal(lines.length - 1, exported.rows);
		assert.ok(lines.slice(1).every((line) => line.includes('"drafts key"')));
		assert.equal(exported.isTruncated, false);
	});

	test("a CSV cell can't become a spreadsheet formula", () => {
		const csv = m.rules.toActivityCsv([{ createdAt: new Date(0), summary: "=HYPERLINK(1)", actorName: "+evil" }]);
		assert.match(csv, /"'=HYPERLINK\(1\)"/);
		assert.match(csv, /"'\+evil"/);
	});

	test("a key reads its own entries unless it was made with auditRead, which no existing key has", async () => {
		const listed = await run(relaxed, "list_api_keys", {});
		assert.ok(listed.apiKeys.every(({ auditRead }) => auditRead === false), "never by default");
		const own = await api(relaxed.keys.full, "GET", "/agent-activity");
		assert.ok(own.body.activity.every(({ actor }) => actor.name === "full key"));
		await addDraft(m, relaxed.keys.full);
		const auditor = await createKey(relaxed, { name: "Auditor", level: "read_only", auditRead: true });
		const all = await api(auditor, "GET", "/agent-activity");
		assert.ok(new Set(all.body.activity.map(({ actor }) => actor.name)).size > 1, JSON.stringify(all.body));
		const exported = await api(auditor, "GET", "/agent-activity/export");
		assert.equal(exported.status, 200);
	});

	test("a team member's dashboard change is in the log with their name and role", async () => {
		const member = await signIn("gaps-editor@example.com");
		const invited = await run(relaxed, "invite_team_member", { email: member.email, role: "editor" });
		const user = { id: String(member.userId), email: member.email, emailVerified: true, name: "Robin" };
		await (await import("../lib/team.js")).acceptTeamInvitation(user, invited.id);
		const account = { ...(await accountOf(relaxed)), memberRole: "editor" };
		await m.runAction("create_campaign", { account, user, input: { subject: "By a member", content: "x" }, via: "dashboard" });
		const entry = await m.AgentActivity.findOne({ accountId: relaxed.accountId, actorType: "person", action: "create_campaign" }).lean();
		assert.deepEqual([entry.actorName, entry.via, entry.status], ["Robin (editor)", "dashboard", "ok"]);
		assert.equal(await m.AgentActivity.countDocuments({ accountId: relaxed.accountId, actorType: "person", action: "list_campaigns" }), 0, "reads aren't");
	});

	test("the retention is the owner's choice, and the purge deletes by it", async () => {
		const old = new Date(Date.now() - 45 * 86_400_000);
		const row = await m.AgentActivity.create({ accountId: relaxed.accountId, kind: "call", actorType: "key", actorId: "x", actorName: "Old key", action: "create_campaign", status: "ok", summary: "Old" });
		await m.AgentActivity.updateOne({ _id: row._id, accountId: relaxed.accountId }, { $set: { createdAt: old } });
		await m.activity.purgeAgentActivity();
		assert.ok(await m.AgentActivity.findOne({ _id: row._id, accountId: relaxed.accountId }).lean(), "90 days keeps it");

		assert.ok((await api(relaxed.keys.full, "PATCH", "/agent-activity/retention", { days: 30 })).status >= 400, "no key changes it");
		assert.deepEqual(await run(relaxed, "set_agent_activity_retention", { days: 30 }), { days: 30 });
		assert.equal((await m.AgentActivity.findOne({ _id: row._id, accountId: relaxed.accountId }).lean()).keepDays, 30);
		await m.activity.purgeAgentActivity();
		assert.equal(await m.AgentActivity.findOne({ _id: row._id, accountId: relaxed.accountId }).lean(), null, "30 days deletes it");
		await assert.rejects(run(relaxed, "set_agent_activity_retention", { days: 45 }), (error) => error.code === "validation_failed");
		await run(relaxed, "set_agent_activity_retention", { days: 90 });
	});
});

describe("G4: a key limited to chosen actions", () => {
	test("a drafts key can't send; a key limited to sending can't change contacts; it still reads its approvals", async () => {
		const id = await addDraft(m, relaxed.keys.full);
		assert.equal((await api(relaxed.keys.drafts, "POST", `/campaigns/${id}/send`, {})).status, 403);

		const sender = await createKey(relaxed, { name: "Sender", level: "send_with_approval", actions: ["send_campaign", "schedule_campaign", "get_campaign"] });
		const contact = await m.Contact.findOne({ accountId: relaxed.accountId }).lean()
			?? (await m.Contact.create({ accountId: relaxed.accountId, newsletterId: relaxed.newsletterId, email: "one@gaps.example.org", status: "active" }));
		const refused = await api(sender, "PATCH", `/contacts/${contact._id}`, { status: "unsubscribed" });
		assert.equal(refused.status, 403);
		assert.match(errorOf(refused).message, /limited to some actions/);
		assert.equal((await api(sender, "GET", "/contacts")).status, 403, "reads too, unless listed");
		const asked = await api(sender, "POST", `/campaigns/${id}/send`, {});
		assert.equal(asked.status, 202);
		assert.equal((await api(sender, "GET", `/approvals/${asked.body.approvalId}`)).status, 200, "it can follow its own request");
	});

	test("a list is checked against the level when the key is made", async () => {
		await assert.rejects(createKey(relaxed, { level: "drafts", actions: ["send_campaign"] }), (error) => error.code === "validation_failed");
		await assert.rejects(createKey(relaxed, { level: "full", actions: ["no_such_action"] }), (error) => error.code === "validation_failed");
		await assert.rejects(createKey(relaxed, { level: "signups", actions: ["add_contact"] }), (error) => error.code === "validation_failed");
	});

	test("the manifest and the docs describe the permission", async () => {
		const { ACTIONS } = m.registry;
		const create = ACTIONS.find(({ name }) => name === "create_api_key");
		assert.ok(create.input.shape.actions && create.input.shape.allowedIps && create.input.shape.auditRead);
		const { getAgentSafetyMarkdown } = await import("../lib/docs/agent-safety.js");
		const text = getAgentSafetyMarkdown("http://localhost:3000");
		assert.match(text, /Limit a key to some actions/);
	});
});

describe("G5: an app limited to one newsletter", () => {
	test("it gets forbidden on the other newsletter for campaigns, contacts, content and settings, and on the account", async () => {
		const connection = await connectApp(relaxed, { name: "ChatGPT", newsletterId: relaxed.newsletterId });
		const account = await accountOf(relaxed);
		const call = (name, input) => m.runAction(name, { account, connection, input, via: "mcp" });
		const otherCampaign = await addDraft(m, relaxed.keys.full, { newsletter: relaxed.otherSlug });
		for (const [name, input] of [
			["get_campaign", { id: otherCampaign }],
			["list_campaigns", { newsletter: relaxed.otherSlug }],
			["list_contacts", { newsletter: relaxed.otherSlug }],
			["create_content_item", { newsletter: relaxed.otherSlug, channel: "newsletter", title: "Elsewhere" }],
			["update_newsletter", { id: relaxed.otherNewsletterId, description: "Elsewhere" }],
			["create_newsletter", { name: "Another", slug: "gaps-app-another", postalAddress: "1 Main St, Paris" }],
		]) {
			await assert.rejects(call(name, input), (error) => error.code === "forbidden" && /limited to one newsletter/.test(error.message), name);
		}
		const own = await call("list_campaigns", {});
		assert.ok(own.campaigns.every(({ newsletterId }) => newsletterId === relaxed.newsletterId));
		const listed = await call("list_newsletters", {});
		assert.deepEqual(listed.newsletters.map(({ id }) => id), [relaxed.newsletterId]);
	});

	test("every action has a newsletter target, so a new one is refused to a limited app rather than let through", async () => {
		const { getNewsletterTarget } = await import("../lib/action-scopes.js");
		const kinds = new Set(["input", "newsletter", "model", "field", "ids", "open", "list_newsletters", "account"]);
		for (const action of m.registry.ACTIONS) {
			const target = getNewsletterTarget(action.name, Object.hasOwn(action.input.shape, "newsletter"));
			assert.ok(kinds.has(target.kind), action.name);
		}
		assert.equal(getNewsletterTarget("an_action_added_later", false).kind, "account");
	});
});

describe("G6: a key's IP allow-list", () => {
	test("outside the list it answers 403 without saying the list, and the attempt is in the log", async () => {
		const key = await createKey(relaxed, { name: "Office only", level: "read_only", allowedIps: ["203.0.113.0/24", "2001:db8::/32"] });
		const outside = await callApi("GET", "/api/v1/newsletters", { key, headers: { "cf-connecting-ip": "198.51.100.9" } });
		assert.equal(outside.status, 403);
		assert.doesNotMatch(JSON.stringify(outside.body), /203\.0\.113|2001:db8/);
		const spoofed = await callApi("GET", "/api/v1/newsletters", { key, headers: { "x-forwarded-for": "203.0.113.5" } });
		assert.equal(spoofed.status, 403, "X-Forwarded-For doesn't open it");
		assert.equal((await callApi("GET", "/api/v1/newsletters", { key, headers: { "cf-connecting-ip": "203.0.113.5" } })).status, 200);
		assert.equal((await callApi("GET", "/api/v1/newsletters", { key, headers: { "cf-connecting-ip": "2001:db8::7" } })).status, 200);
		const blocked = await m.AgentActivity.findOne({ accountId: relaxed.accountId, actorName: "Office only", status: "denied", action: "authenticate" }).lean();
		assert.equal(blocked?.errorCode, "ip_not_allowed");
		await assert.rejects(createKey(relaxed, { level: "read_only", allowedIps: ["10.0.0.0/33"] }), (error) => error.code === "validation_failed");
	});
});

describe("G7: the rate limit's headers", () => {
	test("every answer says the key's limit and what is left; they match the configured limit", async () => {
		const { REQUESTS_PER_KEY } = await import("../lib/api/rest.js");
		const answer = await api(relaxed.keys.read_only, "GET", "/newsletters");
		assert.equal(answer.headers.get("ratelimit-limit"), String(REQUESTS_PER_KEY.limit));
		assert.equal(answer.headers.get("ratelimit-policy"), `${REQUESTS_PER_KEY.limit};w=60`);
		assert.equal(answer.headers.get("ratelimit-reset"), "60");
		const remaining = Number(answer.headers.get("ratelimit-remaining"));
		assert.ok(remaining >= 0 && remaining < REQUESTS_PER_KEY.limit);
		const next = Number((await api(relaxed.keys.read_only, "GET", "/newsletters")).headers.get("ratelimit-remaining"));
		assert.equal(next, remaining - 1);
	});
});

describe("G8: team roles, from the code", () => {
	test("the docs table, the agent brief and the check read one table", async () => {
		const { TEAM_ROLE_CLASSES } = await import("../lib/action-scopes.js");
		const { getAgentSafetyGuide } = await import("../lib/docs/agent-safety.js");
		const section = getAgentSafetyGuide("http://localhost:3000").find(({ id }) => id === "team-roles");
		assert.deepEqual(
			section.table.rows.map(([role, classes]) => [role, classes]),
			Object.entries(TEAM_ROLE_CLASSES).map(([role, classes]) => [role, classes.join(", ")])
		);
		const brief = await api(relaxed.keys.read_only, "GET", "/agent/brief");
		assert.equal(brief.status, 200, JSON.stringify(brief.body));
		assert.deepEqual(Object.fromEntries(brief.body.teamRoles.map(({ role, classes }) => [role, classes])), TEAM_ROLE_CLASSES);
		const viewer = await signIn("gaps-viewer@example.com");
		const invited = await run(relaxed, "invite_team_member", { email: viewer.email, role: "viewer" });
		const user = { id: String(viewer.userId), email: viewer.email, emailVerified: true, name: "" };
		await (await import("../lib/team.js")).acceptTeamInvitation(user, invited.id);
		const account = { ...(await accountOf(relaxed)), memberRole: "viewer" };
		await assert.rejects(m.runAction("create_campaign", { account, user, input: { subject: "No", content: "x" }, via: "dashboard" }), (error) => error.code === "forbidden");
		assert.ok(await m.runAction("list_campaigns", { account, user, input: {}, via: "dashboard" }));
	});
});
