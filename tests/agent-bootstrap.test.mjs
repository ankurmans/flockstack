import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, callApi, startTestApp } from "./helpers/app.mjs";
import { agentOwner, loadAgentModules } from "./helpers/agents.mjs";
let app, m, owner;
before(async () => {
	app = await startTestApp(); m = await loadAgentModules();
	Object.assign(m, { Form: (await import("../models/Form.js")).default, Item: (await import("../models/ContentItem.js")).default, Workspace: await import("../lib/agent-workspaces.js"), Message: (await import("../models/Message.js")).default });
	owner = await agentOwner(m, "bootstrap-owner@example.com");
	await m.Account.updateOne({ _id: owner.accountId }, { $set: { "limitOverrides.newsletters": 20 } });
});
after(() => app?.stop());
const call = async (name, input, who = owner) => as(who, async () => m.runAction(name, { account: await m.Account.findById(who.accountId).lean(), user: { id: String(who.userId), email: who.email }, input, via: "dashboard" }));
const brief = { externalId: "first-build", name: "Field notes", brief: "Notes for independent gardeners.", description: "Practical gardening notes.", drafts: Array.from({ length: 4 }, (_, index) => ({ subject: `Issue ${index + 1}`, content: `Draft ${index + 1}.` })) };
test("bootstrap creates four unsent drafts and retries without duplicate assets or overwriting edits", async () => {
	const first = await call("bootstrap_newsletter", brief);
	assert.equal(first.sent, false); assert.equal(first.published, false);
	assert.equal(first.drafts.length, 4);
	assert.ok(first.drafts.every((draft) => draft.status === "draft"));
	const newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: first.newsletterId }).lean();
	assert.equal(newsletter.archiveEnabled, false); assert.equal(newsletter.welcome.enabled, false); assert.equal(newsletter.requireConfirmation, true);
	assert.equal(await m.Form.countDocuments({ accountId: owner.accountId, newsletterId: newsletter._id }), 1);
	assert.equal(await m.Item.countDocuments({ accountId: owner.accountId, newsletterId: newsletter._id }), 4);
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: first.drafts[0].id }, { $set: { subject: "Owner's edit" } });
	const again = await call("bootstrap_newsletter", brief);
	assert.equal(again.newsletterId, first.newsletterId);
	assert.equal(await m.Campaign.countDocuments({ accountId: owner.accountId, newsletterId: newsletter._id }), 4);
	assert.equal((await m.Campaign.findOne({ accountId: owner.accountId, _id: first.drafts[0].id }).lean()).subject, "Owner's edit");
	assert.equal(await m.Message.countDocuments({ accountId: owner.accountId, newsletterId: newsletter._id }), 0);
	await assert.rejects(call("bootstrap_newsletter", { ...brief, brief: "Different" }), /different brief/);
});
test("draft keys cannot create newsletters by bootstrapping", async () => {
	const result = await callApi("POST", "/api/v1/agent/bootstrap", { key: owner.keys.drafts, body: brief });
	assert.equal(result.status, 403);
});
test("workspace draft and claim tokens cannot stand in for each other, and stale previews cannot be claimed", async () => {
	const { externalId, ...payload } = brief;
	const workspace = await m.Workspace.createWorkspace({ ...payload, name: "Claimed notes" }, new Headers({ "x-forwarded-for": "198.51.100.88" }));
	const claimToken = new URLSearchParams(new URL(workspace.claimUrl).hash.slice(1)).get("token");
	await assert.rejects(m.Workspace.previewWorkspace({ id: workspace.id, token: workspace.draftToken }), /invalid or expired/);
	const preview = await call("preview_agent_workspace", { id: workspace.id, token: claimToken });
	await m.Workspace.updateDraftWorkspace(workspace.id, workspace.draftToken, { ...payload, name: "Revised notes" }, preview.revision);
	await assert.rejects(call("claim_agent_workspace", { id: workspace.id, token: claimToken, revision: preview.revision }), /changed/);
	const updated = await call("preview_agent_workspace", { id: workspace.id, token: claimToken });
	const claimed = await call("claim_agent_workspace", { id: workspace.id, token: claimToken, revision: updated.revision });
	assert.equal(claimed.drafts.length, 4);
	await assert.rejects(m.Workspace.readDraftWorkspace(workspace.id, workspace.draftToken), /invalid or expired/);
	assert.equal((await callApi("GET", "/api/v1/newsletters", { key: workspace.draftToken })).status, 401);
});
test("agent brief reports missing evidence and never borrows another newsletter's results", async () => {
	const value = await call("get_agent_brief", { newsletter: owner.otherSlug });
	assert.deepEqual(value.recent, []); assert.equal(value.emptyDays.length, 7);
	assert.ok(value.nextSteps.some((text) => text.includes("no sent issues")));
});
test("bootstrap preserves a full brief and accepts a long name without exceeding child action limits", async () => {
	const input = { ...brief, externalId: "long-brief", name: "N".repeat(100), brief: "Private writing context. ".repeat(200).slice(0, 6000) };
	const value = await call("bootstrap_newsletter", input);
	const stored = await m.Newsletter.findOne({ accountId: owner.accountId, _id: value.newsletterId }).lean();
	assert.equal(stored.agentBrief, input.brief.trim()); assert.equal(stored.linkPage.title.length, 80);
	const daily = await call("get_agent_brief", { newsletter: value.newsletterId }); assert.equal(daily.writingBrief, input.brief.trim());
	const { getArchiveSite } = await import("../lib/archive-data.js");
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: value.newsletterId }, { $set: { archiveEnabled: true } });
	assert.equal((await getArchiveSite(value.slug)).agentBrief, undefined, "private brief is absent from public archive data");
	const { toNewsletterSettings } = await import("../lib/account-export-files.js"); assert.equal(toNewsletterSettings(stored).agentBrief, input.brief.trim());
});
test("invalid bootstrap links fail validation before any newsletter is created", async () => {
	const before = await m.Newsletter.countDocuments({ accountId: owner.accountId });
	await assert.rejects(call("bootstrap_newsletter", { ...brief, externalId: "invalid-link", links: [{ label: "Open", url: "javascript:alert(1)" }] }), /web or email address/);
	assert.equal(await m.Newsletter.countDocuments({ accountId: owner.accountId }), before);
});
test("once a claim has started its payload stays fixed for safe retries", async () => {
	const { externalId, ...payload } = brief;
	const workspace = await m.Workspace.createWorkspace({ ...payload, name: "Retryable claim" }, new Headers({ "x-forwarded-for": "198.51.100.89" }));
	const Workspace = (await import("../models/AgentWorkspace.js")).default;
	await Workspace.updateOne({ _id: workspace.id }, { $set: { claimedBy: owner.accountId } });
	await assert.rejects(m.Workspace.updateDraftWorkspace(workspace.id, workspace.draftToken, { ...payload, name: "Changed after claim" }, 1), /Claim has started/);
	const token = new URLSearchParams(new URL(workspace.claimUrl).hash.slice(1)).get("token");
	const preview = await call("preview_agent_workspace", { id: workspace.id, token });
	assert.equal((await call("claim_agent_workspace", { id: workspace.id, token, revision: preview.revision })).drafts.length, 4);
});
