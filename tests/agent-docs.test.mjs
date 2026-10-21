import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, loadAgentModules } from "./helpers/agents.mjs";

// What the docs, the OpenAPI document and the llms files say about agent safety is read from the code, and what they show as
// examples is what the API answers.
const APP_URL = "http://localhost:3000";
let app;
let m;
let owner;

const text = (markup) => markup.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");
const render = (Page) => text(renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Page))));

before(async () => {
	app = await startTestApp();
	m = await loadAgentModules();
	m.docs = await import("../lib/docs/llms.js");
	m.openapi = await import("../lib/docs/openapi.js");
	m.guide = await import("../lib/docs/agent-safety.js");
	m.scopes = await import("../lib/action-scopes.js");
	m.rules = await import("../lib/approval-rules.js");
	m.events = await import("../lib/webhook-events.js");
	owner = await agentOwner(m, "agent-docs@example.com");
});

after(() => app?.stop());

describe("the Agent safety page", () => {
	test("is listed with the docs, for people and for agents, and renders every section", async () => {
		const entry = m.docs.DOC_PAGES.find(({ href }) => href === "/docs/agent-safety");
		assert.ok(entry && entry.title === "Agent safety" && entry.summary.length > 40);
		assert.match(m.docs.getLlmsIndex(APP_URL), /\[Agent safety\]\(http:\/\/localhost:3000\/docs\/agent-safety\)/);
		const { default: Page, metadata } = await import("../app/(site)/docs/agent-safety/page.js");
		assert.match(metadata.title.absolute, /Agent safety/);
		const page = render(Page);
		for (const heading of ["Agents propose, you approve", "Levels", "What each level allows", "Limit a key", "The approval flow", "Agent activity", "Setups that work", "What no key can do"]) {
			assert.match(page, new RegExp(heading), heading);
		}
		for (const preset of m.scopes.PRESETS) assert.match(page, new RegExp(m.scopes.PRESET_INFO[preset].label), preset);
		for (const setup of ["Read only analyst", "Drafting assistant", "Send with approval operator"]) assert.match(page, new RegExp(setup), setup);
		assert.match(page, /Asks you first/);
		assert.match(page, /approval_required/);
	});

	test("takes its numbers from the code that runs", () => {
		const page = text(m.guide.getAgentSafetyMarkdown(APP_URL));
		assert.match(page, new RegExp(`${m.rules.APPROVAL_TTL_HOURS} hours`));
		assert.match(page, new RegExp(`more than ${m.scopes.SCALE_LIMITS.perCall} contacts in one call`));
		assert.match(page, new RegExp(`more than ${m.scopes.SCALE_LIMITS.perDay} contacts changed`));
		assert.match(page, /kept 90 days/);
		assert.match(page, new RegExp(`at most ${m.rules.MAX_PENDING_PER_ACTOR} waiting`));
		for (const className of m.scopes.SCOPE_CLASSES) {
			const count = Object.values(m.scopes.ACTION_CLASSES).filter((value) => value === className).length;
			assert.match(page, new RegExp(`${m.scopes.SCOPE_CLASS_INFO[className].label} \\(${count}\\)`), className);
		}
	});

	test("shows the answer a send with approval key really gets", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const real = (await api(owner.keys.send_with_approval, "POST", `/campaigns/${id}/send`, {})).body;
		const markdown = m.guide.getAgentSafetyMarkdown(APP_URL);
		const example = JSON.parse(markdown.match(/POST [^\n]+\/send\n\n(\{[\s\S]*?\n\})/)[1]);
		assert.deepEqual(Object.keys(example).sort(), Object.keys(real).sort());
		assert.equal(example.message, real.message);
		assert.equal(example.retryAfter, real.retryAfter);
		assert.equal(example.status, real.status);

		const status = (await api(owner.keys.send_with_approval, "GET", `/approvals/${real.approvalId}`)).body;
		const approved = JSON.parse(markdown.match(/Poll: GET[^\n]+\n\n```\n([\s\S]*?)\n```/)[1]);
		assert.deepEqual(Object.keys(approved).sort(), Object.keys(status).sort(), "the poll example has every field the API answers");
		assert.deepEqual(Object.keys(approved.preview).sort(), Object.keys(status.preview).sort());
	});

	test("lists the webhook as the event the code sends, with an example shaped like the real one", async () => {
		const id = await addDraft(m, owner.keys.send_with_approval);
		const { approvalId } = (await api(owner.keys.send_with_approval, "DELETE", `/campaigns/${id}`)).body;
		const row = await m.ApprovalRequest.findOne({ _id: approvalId, accountId: owner.accountId }).lean();
		assert.deepEqual(Object.keys(m.events.toApprovalData(row)).sort(), Object.keys(m.events.getWebhookEvent("approval.decided").example.approval).sort());
		assert.ok(m.events.WEBHOOK_EVENT_TYPES.includes("approval.decided"));
		assert.match(m.guide.getAgentSafetyMarkdown(APP_URL), /"type": "approval.decided"/);
	});
});

describe("the reference", () => {
	test("llms-full.txt has the section, the levels in its authentication notes and the approval answer", () => {
		const full = m.docs.getLlmsFull(APP_URL);
		assert.match(full, /## Agent safety/);
		assert.match(full, /`read_only` \(reads\), `drafts`/);
		assert.match(full, /`status: approval_required`/);
		assert.match(full, /429 daily_cap_reached/);
		assert.match(full, /daily_cap_reached/, "the error is listed with the others");
		assert.match(full, /get_approval_status/);
		assert.match(full, /Needs|Keys and up|keys and up/i, "each endpoint says which level it needs");
	});

	test("every endpoint says the lowest level that can run it", async () => {
		const reference = await import("../lib/docs/reference.js");
		const endpoints = new Map(reference.getEndpoints(APP_URL).map((endpoint) => [endpoint.name, endpoint]));
		assert.match(endpoints.get("list_campaigns").level, /^Read only keys and up/);
		assert.match(endpoints.get("create_campaign").level, /^Drafts only keys and up/);
		assert.match(endpoints.get("update_newsletter").level, /^Send with approval keys and up/);
		assert.match(endpoints.get("send_campaign").level, /waits for the owner's approval first/);
		assert.match(endpoints.get("create_api_key").level, /^Full access only/);
		assert.match(endpoints.get("add_contact").level, /signups only keys too/);
		assert.equal(endpoints.get("send_campaign").scopeClass, "send");
	});

	test("the OpenAPI document gives the actions that can wait a 202, with the schema a real answer matches", async () => {
		const doc = m.openapi.getOpenApiDocument(APP_URL);
		const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods));
		const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
		for (const operation of operations) {
			const waits = operation.responses[202]?.$ref === "#/components/responses/ApprovalRequired";
			assert.equal(waits, m.scopes.isGateable(operation.operationId), operation.operationId);
		}
		assert.deepEqual(byId.get("send_campaign")["x-key-levels"], ["send_with_approval", "full"]);
		assert.deepEqual(byId.get("create_campaign")["x-key-levels"], ["drafts", "send_with_approval", "full"]);
		assert.deepEqual(byId.get("add_contact")["x-key-levels"], ["send_with_approval", "full", "signups"]);
		assert.equal(byId.get("send_campaign")["x-scope-class"], "send");

		const schema = doc.components.schemas.ApprovalRequired;
		const id = await addDraft(m, owner.keys.send_with_approval);
		const real = (await api(owner.keys.send_with_approval, "POST", `/campaigns/${id}/send`, {})).body;
		assert.deepEqual(Object.keys(real).sort(), Object.keys(schema.properties).sort());
		for (const field of schema.required) assert.ok(field in real, field);
		assert.ok(doc.components.responses.ApprovalRequired.headers["Retry-After"]);
		assert.ok(!Object.keys(doc.paths).some((path) => path.includes("agent-approval") || path.endsWith("/decide")), "the dashboard-only actions aren't in it");
	});

	test("the authentication and MCP pages describe the levels and the approval answer", async () => {
		const { default: Authentication } = await import("../app/(site)/docs/authentication/page.js");
		const auth = render(Authentication);
		for (const preset of m.scopes.PRESETS) assert.match(auth, new RegExp(`${m.scopes.PRESET_INFO[preset].label}.*${preset}`), preset);
		assert.match(auth, /daily_cap_reached/);
		assert.doesNotMatch(auth, /Two levels/);
		const { default: Mcp } = await import("../app/(site)/docs/mcp/page.js");
		const mcp = render(Mcp);
		assert.match(mcp, /approval_required/);
		assert.match(mcp, /get_approval_status/);
		assert.match(mcp, /flockstack:drafts/);
		assert.doesNotMatch(mcp, /same access as a full access key/);
	});

	test("the error list has the new code, and every code a limited key can meet", async () => {
		const { ERRORS } = await import("../lib/actions/errors.js");
		assert.equal(ERRORS.daily_cap_reached.status, 429);
		assert.match(ERRORS.forbidden.description, /read only/);
	});

	test("the MCP instructions tell an assistant what to do with a request that waits", async () => {
		const { getMcpInstructions } = await import("../lib/mcp/server.js");
		const MCP_INSTRUCTIONS = await getMcpInstructions();
		assert.match(MCP_INSTRUCTIONS, /approval_required/);
		assert.match(MCP_INSTRUCTIONS, /do not call the tool again/);
		assert.match(MCP_INSTRUCTIONS, /get_approval_status/);
	});
});
