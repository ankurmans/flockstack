import assert from "node:assert/strict";
import { activate, addSentIssue, as, callApi, catchRedirect, form, signIn } from "./app.mjs";
import { runWithRequest } from "../stubs/next-headers.mjs";
import { flushAfter } from "../stubs/next-server.mjs";

export const SHARED_DOMAIN = "flockstackmail.com";
let sequence = 0;

export const nextIp = () => `198.18.${Math.floor(++sequence / 250)}.${(sequence % 250) + 1}`;

// A paying account with a newsletter whose website is on and which has sent an issue, so its signup form is live.
export async function creator(name, { confirm = true, archive = true, issue = true, extra = {} } = {}) {
	const newsletters = await import("../../app/(app)/newsletters/actions.js");
	const apiKeys = await import("../../app/(app)/api-keys/actions.js");
	const Newsletter = (await import("../../models/Newsletter.js")).default;
	const user = await signIn(`${name}@example.com`);
	await activate(user);
	user.slug = name;
	const url = await as(user, () =>
		catchRedirect(
			newsletters.saveNewsletter(
				null,
				form({
					name: `${name} news`,
					slug: name,
					description: `All about ${name}.`,
					fromEmail: `hello@${name}.${SHARED_DOMAIN}`,
					postalAddress: "1 Main St, Paris",
					...(archive && { archiveEnabled: "on" }),
					...(confirm && { requireConfirmation: "on" }),
					...extra,
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	await Newsletter.updateOne(
		{ accountId: user.accountId, _id: user.newsletterId },
		{ $set: { "sharedSender.domain": `${name}.${SHARED_DOMAIN}`, "sharedSender.provider": "ses", "sharedSender.verified": true } }
	);
	if (issue) await addSentIssue(user);
	return user;
}

export async function findContact(user, email) {
	const Contact = (await import("../../models/Contact.js")).default;
	return Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, email }).lean();
}

// Someone anonymous on the web, from an address of their own.
export function visit(ip, run, headers = {}) {
	return runWithRequest({ jar: new Map(), headers: { "x-forwarded-for": ip, ...headers } }, run);
}

// A visit to a route handler or action, then the work it left for after the response.
export async function visitAndFlush(ip, run, headers) {
	const result = await visit(ip, run, headers);
	await flushAfter();
	return result;
}

// The REST API with every answer checked against the action's output schema.
export async function api(key, method, path, body) {
	const rest = await import("../../lib/api/rest.js");
	const response = await callApi(method, `/api/v1${path}`, { key, body });
	if (response.status < 300) {
		const segments = new URL(path, "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const { action } = await rest.matchRoute(method, segments);
		const checked = action.output.safeParse(response.body);
		assert.ok(checked.success, `${action.name} answered outside its schema: ${checked.error?.message}`);
	}
	return response;
}

export function assertError(response, status, code) {
	assert.equal(response.status, status, JSON.stringify(response.body));
	assert.equal(response.body.error.code, code, response.body.error.message);
	return response.body.error.message;
}

export { callApi };
