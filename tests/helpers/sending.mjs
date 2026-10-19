import { activate, as, catchRedirect, form, jsonRequest, proveVolume, signIn } from "./app.mjs";
import { published } from "../stubs/qstash.mjs";

// A signed-in account with a paid plan, one newsletter and its active contacts, for tests that send campaigns. Jobs
// published to QStash run with runJobs, each once.
export async function loadSendingModules() {
	return {
		newsletters: await import("../../app/(app)/newsletters/actions.js"),
		campaigns: await import("../../app/(app)/campaigns/actions.js"),
		runAction: (await import("../../lib/actions/run-action.js")).runAction,
		sendBatchRoute: await import("../../app/api/jobs/send-batch/route.js"),
		scheduledRoute: await import("../../app/api/jobs/send-scheduled/route.js"),
		Account: (await import("../../models/Account.js")).default,
		Campaign: (await import("../../models/Campaign.js")).default,
		Contact: (await import("../../models/Contact.js")).default,
		Message: (await import("../../models/Message.js")).default,
		Newsletter: (await import("../../models/Newsletter.js")).default,
	};
}

export async function setupSender(m, email, { contacts = 10, mailed = true } = {}) {
	const user = await signIn(email);
	await activate(user, { limitOverrides: { emailsPerMonth: 100_000, subscribers: 100_000 } });
	const slug = email.split("@")[0];
	const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St" }))));
	user.newsletterId = url.split("/").at(-1);
	await proveVolume(user, 1000);
	await m.Contact.insertMany(
		Array.from({ length: contacts }, (_, index) => ({
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			email: `reader${index}@${slug}.example.org`,
			status: "active",
			// Engagement orders the audience: reader0 is the most engaged.
			lastOpenAt: new Date(Date.now() - (index + 1) * 60_000),
			...(mailed && { lastSentAt: new Date(Date.now() - 86_400_000) }),
		}))
	);
	return user;
}

export async function createDraft(m, user, { subject = "Issue", body = "<p>Hello</p>", previewText = "" } = {}) {
	const draftUrl = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const campaignId = draftUrl.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(campaignId, { subject, previewText, body }));
	return campaignId;
}

// An action as the API runs it, with the account as it is now.
export async function act(m, user, name, input) {
	const account = await m.Account.findById(user.accountId).lean();
	return as(user, () => m.runAction(name, { account, user: { id: String(user.userId), email: user.email }, input, via: "api" }));
}

export const QSTASH_KEYS = { QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next", SEND_RATE_PER_SECOND: "1000" };

const handled = new Set();

// Runs the published jobs whose path ends with one of these, in order, until none are left.
export async function runJobs(routes, { only = null } = {}) {
	const results = [];
	for (let index = 0; index < published.length; index++) {
		const job = published[index];
		if (handled.has(index)) continue;
		const path = new URL(job.url).pathname;
		const route = routes[path];
		if (!route || (only && !only(job))) continue;
		handled.add(index);
		const response = await route.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
		results.push({ path, body: job.body, notBefore: job.notBefore, result: await response.json() });
	}
	return results;
}

export function skipPublished() {
	published.forEach((_, index) => handled.add(index));
}

export function sendRoutes(m, extra = {}) {
	return { "/api/jobs/send-batch": m.sendBatchRoute, "/api/jobs/send-scheduled": m.scheduledRoute, ...extra };
}
