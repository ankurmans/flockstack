import assert from "node:assert/strict";
import { activate, as, callApi, catchRedirect, form, signIn } from "./app.mjs";
import { runWithRequest } from "../stubs/next-headers.mjs";
import { flushAfter } from "../stubs/next-server.mjs";
import { sent as sesEmails } from "../stubs/ses.mjs";

// What the comment tests share: an account with a newsletter whose website is online and that can send, one sent issue,
// readers as contacts, and a browser (a cookie jar) for each reader.
export const SHARED_DOMAIN = "flockstackmail.com";
let visitors = 0;

export async function importModels() {
	return {
		apiKeys: await import("../../app/(app)/api-keys/actions.js"),
		newsletters: await import("../../app/(app)/newsletters/actions.js"),
		readerIn: await import("../../app/reader/in/route.js"),
		signinPage: (await import("../../app/reader/signin/page.js")).default,
		signinActions: await import("../../app/reader/signin/actions.js"),
		commentActions: await import("../../app/archive/comment-actions.js"),
		session: await import("../../lib/reader-session.js"),
		links: await import("../../lib/reader-links.js"),
		rules: await import("../../lib/comment-rules.js"),
		sendingRules: await import("../../lib/sending-rules.js"),
		NextRequest: (await import("next/server")).NextRequest,
		Campaign: (await import("../../models/Campaign.js")).default,
		Contact: (await import("../../models/Contact.js")).default,
		Newsletter: (await import("../../models/Newsletter.js")).default,
		Message: (await import("../../models/Message.js")).default,
	};
}

// A paying account with a newsletter that has its website on and comments on, and one sent issue (user.issue).
export async function createPublisher(m, email, { comments = { enabled: true }, issue = {}, newsletter = {} } = {}) {
	const user = await signIn(email);
	await activate(user);
	user.slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-");
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({
					name: `${user.slug} news`,
					slug: user.slug,
					fromEmail: `hello@${user.slug}.${SHARED_DOMAIN}`,
					postalAddress: "1 Main St, Paris",
					archiveEnabled: "on",
					...newsletter,
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { comments } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	user.issue = await addIssue(m, user, issue);
	return user;
}

export async function addIssue(m, user, { subject = "Sent issue", archiveSlug = `issue-${++visitors}`, ...rest } = {}) {
	const issue = await m.Campaign.create({
		accountId: user.accountId,
		newsletterId: user.newsletterId,
		subject,
		archiveSlug,
		status: "sent",
		sentAt: new Date(),
		format: "rich",
		html: "<p>The issue's text.</p>",
		...rest,
	});
	return issue.toObject();
}

export function addReader(m, user, email, extra = {}) {
	return m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active", source: "website", ...extra });
}

// A browser: its own cookie jar and network address.
export function browser() {
	return { jar: new Map(), ip: `203.0.113.${(++visitors % 250) + 1}` };
}

export function inBrowser(visitor, run) {
	return runWithRequest({ jar: visitor.jar, headers: { "x-forwarded-for": visitor.ip } }, run);
}

// A reader signed in through the link in a newsletter's email, in a browser of their own.
export async function signInReader(m, user, contact, { issue = user.issue } = {}) {
	const visitor = browser();
	visitor.contact = contact;
	const url = m.links.getEmailCommentUrl({ contactId: contact._id, newsletterId: user.newsletterId }, user.newsletter, { issueSlug: issue.archiveSlug });
	const response = await inBrowser(visitor, () => m.readerIn.GET(new m.NextRequest(url)));
	assert.equal(response.status, 303);
	assert.match(response.headers.get("location"), /#comments$/, "lands on the comments");
	return visitor;
}

// The emails SES sent to an address since a point, newest last.
export function emailsTo(address, since = 0) {
	return sesEmails.slice(since).filter((email) => [email.to].flat().includes(address));
}

export function emailCount() {
	return sesEmails.length;
}

export async function settle() {
	await flushAfter();
}

export { callApi };
