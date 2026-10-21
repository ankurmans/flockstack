import assert from "node:assert/strict";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn } from "./app.mjs";

// An account with two newsletters and a key of each level, for the tests of what an agent may do. Keys are made on the API
// keys page, the way a person makes them.
export async function loadAgentModules() {
	return {
		mcpRoute: await import("../../app/mcp/route.js"),
		newsletters: await import("../../app/(app)/newsletters/actions.js"),
		apiKeys: await import("../../app/(app)/api-keys/actions.js"),
		approvals: await import("../../app/(app)/approvals/actions.js"),
		registry: await import("../../lib/actions/registry.js"),
		runAction: (await import("../../lib/actions/run-action.js")).runAction,
		approvalLib: await import("../../lib/approvals.js"),
		housekeeping: await import("../../lib/agent-housekeeping.js"),
		Account: (await import("../../models/Account.js")).default,
		AgentActivity: (await import("../../models/AgentActivity.js")).default,
		AgentDay: (await import("../../models/AgentDay.js")).default,
		ApiKey: (await import("../../models/ApiKey.js")).default,
		ApprovalRequest: (await import("../../models/ApprovalRequest.js")).default,
		Campaign: (await import("../../models/Campaign.js")).default,
		Contact: (await import("../../models/Contact.js")).default,
		Newsletter: (await import("../../models/Newsletter.js")).default,
		WebhookDelivery: (await import("../../models/WebhookDelivery.js")).default,
	};
}

export async function makeKey(m, user, level, extra = {}) {
	const result = await as(user, () => m.apiKeys.createApiKey(null, form({ name: extra.name ?? `${level} key`, level, ...extra })));
	assert.ok(result.key, JSON.stringify(result));
	return result.key;
}

export async function agentOwner(m, email, { slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-") } = {}) {
	const user = await signIn(email);
	await activate(user, { limitOverrides: { emailsPerMonth: 100_000, subscribers: 100_000 } });
	user.slug = slug;
	user.newsletterId = (await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} one`, slug, postalAddress: "1 Main St, Paris" }))))).split("/").at(-1);
	user.otherSlug = `${slug}-two`;
	user.otherNewsletterId = (
		await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} two`, slug: user.otherSlug, postalAddress: "1 Main St, Paris" }))))
	).split("/").at(-1);
	user.keys = {};
	for (const level of ["read_only", "drafts", "send_with_approval", "full", "signups"]) user.keys[level] = await makeKey(m, user, level);
	return user;
}

export const api = (key, method, path, body) => callApi(method, `/api/v1${path}`, { key, body });

let nextId = 0;

// An MCP request the way a client sends it, with the key as a bearer token.
export async function mcp(m, key, method, params = {}) {
	const request = new Request("http://localhost:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(method !== "initialize" && { "mcp-protocol-version": "2025-06-18" }),
			...(key && { authorization: `Bearer ${key}` }),
		},
		body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++nextId }),
	});
	const response = await anonymous(() => m.mcpRoute.POST(request));
	const text = await response.text();
	const data = text.split("\n").find((line) => line.startsWith("data: "));
	return { status: response.status, body: data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : null };
}

export async function callTool(m, key, name, args = {}) {
	const { body } = await mcp(m, key, "tools/call", { name, arguments: args });
	return body.result;
}

export function errorOf(response) {
	return response.body?.error;
}

export async function addDraft(m, key, fields = {}) {
	const response = await api(key, "POST", "/campaigns", { subject: "Issue", previewText: "This week", content: "Hello **readers**.", ...fields });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body.id;
}
