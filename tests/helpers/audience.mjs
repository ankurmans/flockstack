import assert from "node:assert/strict";
import { activate, as, callApi, catchRedirect, form, jsonRequest, signIn, startTestApp } from "./app.mjs";
import { published } from "../stubs/qstash.mjs";

// The setup the tags, segments and automations tests share: customers with a newsletter and API keys, the REST API
// with every answer checked against the action's output schema, and the QStash jobs run by hand.
export async function setupAudienceTests(env = {}) {
	const app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next", ...env });
	const m = {
		rest: await import("../../lib/api/rest.js"),
		newsletters: await import("../../app/(app)/newsletters/actions.js"),
		apiKeys: await import("../../app/(app)/api-keys/actions.js"),
		contacts: await import("../../app/(app)/contacts/actions.js"),
		sendBatchRoute: await import("../../app/api/jobs/send-batch/route.js"),
		Account: (await import("../../models/Account.js")).default,
		Campaign: (await import("../../models/Campaign.js")).default,
		Contact: (await import("../../models/Contact.js")).default,
		Message: (await import("../../models/Message.js")).default,
		Newsletter: (await import("../../models/Newsletter.js")).default,
		Suppression: (await import("../../models/Suppression.js")).default,
	};
	const handled = new Set();

	async function api(key, method, path, body) {
		const response = await callApi(method, `/api/v1${path}`, { key, body });
		if (response.status < 300) {
			const segments = new URL(path, "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
			const { action } = await m.rest.matchRoute(method, segments);
			const checked = action.output.safeParse(response.body);
			assert.ok(checked.success, `${action.name} answered outside its schema: ${checked.error?.message}`);
		}
		return response;
	}

	function assertError(response, status, code) {
		assert.equal(response.status, status, JSON.stringify(response.body));
		assert.equal(response.body.error.code, code, response.body.error.message);
		return response.body.error.message;
	}

	// The send-batch jobs QStash was given that this customer's account (every account's without one) hasn't run yet.
	async function runJobs(user = null) {
		for (const [index, { url, body }] of published.entries()) {
			const isBatch = url.endsWith("/api/jobs/send-batch");
			if (handled.has(index) || !isBatch || (user && body.accountId !== String(user.accountId))) continue;
			handled.add(index);
			await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
		}
	}

	async function createKey(user, level) {
		return (await as(user, () => m.apiKeys.createApiKey(null, form({ name: `${level} key`, level })))).key;
	}

	async function customer(email, { limits } = {}) {
		const user = await signIn(email);
		await activate(user, limits ? { limitOverrides: limits } : {});
		user.slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-");
		const url = await as(user, () =>
			catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${user.slug} news`, slug: user.slug, postalAddress: "1 Main St, Paris" })))
		);
		user.newsletterId = url.split("/").at(-1);
		user.key = await createKey(user, "full");
		user.signupsKey = await createKey(user, "signups");
		return user;
	}

	// Active contacts, each with the tags and fields given for its index.
	async function importReaders(user, count, { prefix = "reader", tags, fields } = {}) {
		const contacts = Array.from({ length: count }, (_, index) => ({
			email: `${prefix}${index}@${user.slug}.example.org`,
			...(tags && { tags: tags(index) }),
			...(fields && { fields: fields(index) }),
		}));
		const response = await api(user.key, "POST", "/contacts/import", { consent: true, contacts });
		assert.equal(response.status, 200, JSON.stringify(response.body));
		return response.body;
	}

	async function draft(user, fields = {}) {
		const response = await api(user.key, "POST", "/campaigns", { subject: "Issue", previewText: "This week", content: "Hello **readers**.", ...fields });
		assert.equal(response.status, 201, JSON.stringify(response.body));
		return response.body.id;
	}

	return { app, m, api, assertError, runJobs, customer, importReaders, draft, createKey };
}
