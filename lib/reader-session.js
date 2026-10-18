import "server-only";
import { cookies } from "next/headers";
import { getSignInUrl, readTokenTime, readerCookieName, readerMarkerName, SESSION_MAX_AGE_SECONDS, SIGNIN_MINUTES, createReaderToken, verifyReaderToken } from "@/lib/reader-links";
import { areCommentsOn } from "@/lib/comment-rules";
import { PUBLISHED_STATUSES } from "@/lib/archive-issues";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { sendTransactionalEmail } from "@/lib/sending";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";

// A reader has no account: after an emailed link, the browser keeps a signed session for this newsletter only, in a cookie
// of its own (httpOnly) and a marker the page can read to know whether to ask who is there.
function cookieOptions(httpOnly) {
	return { httpOnly, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MAX_AGE_SECONDS };
}

export async function startReaderSession(newsletter, contactId) {
	const jar = await cookies();
	const token = createReaderToken("session", { contactId, newsletterId: newsletter._id });
	jar.set(readerCookieName(newsletter.slug), token, cookieOptions(true));
	jar.set(readerMarkerName(newsletter.slug), "1", cookieOptions(false));
}

export async function endReaderSession(newsletter) {
	const jar = await cookies();
	jar.set(readerCookieName(newsletter.slug), "", { ...cookieOptions(true), maxAge: 0 });
	jar.set(readerMarkerName(newsletter.slug), "", { ...cookieOptions(false), maxAge: 0 });
}

// The subscriber behind the browser's session, or null: no session, one for another newsletter or past its time, and a
// contact who left (unsubscribed, bounced, complained or never confirmed) all read as nobody.
export async function findSessionReader(newsletter) {
	const token = (await cookies()).get(readerCookieName(newsletter.slug))?.value;
	const reference = verifyReaderToken("session", token);
	if (!reference || reference.newsletterId !== String(newsletter._id)) return null;
	return findActiveContact(newsletter, reference.contactId);
}

export async function findActiveContact(newsletter, contactId) {
	const contact = await Contact.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, _id: contactId }).lean();
	return contact?.status === "active" ? contact : null;
}

// The link in a newsletter's email: signs the reader in. { newsletter, contact } when it worked, { newsletter } when it was
// a real link that no longer works (expired, or the reader left), {} for a forgery.
export async function signInWithEmailLink(token) {
	const reference = verifyReaderToken("email", token);
	if (!reference) return {};
	const newsletter = await findOpenNewsletter({ _id: reference.newsletterId });
	if (!newsletter) return {};
	const contact = await findActiveContact(newsletter, reference.contactId);
	if (!contact) return { newsletter };
	await startReaderSession(newsletter, contact._id);
	return { newsletter, contact };
}

// The sign-in email's link, used once: the contact remembers the time of the last one used, and a link made no later than
// that is spent. { newsletter, contact }, { newsletter, spent: true }, or {} for a link that is forged or expired.
export async function redeemSignInLink(token) {
	const reference = verifyReaderToken("signin", token);
	if (!reference) return {};
	const newsletter = await findOpenNewsletter({ _id: reference.newsletterId });
	if (!newsletter) return {};
	const contact = await findActiveContact(newsletter, reference.contactId);
	if (!contact) return { newsletter };
	const issuedAt = readTokenTime(token);
	const { matchedCount } = await Contact.updateOne(
		{
			accountId: newsletter.accountId,
			_id: contact._id,
			status: "active",
			$or: [{ "community.lastSignInT": { $exists: false } }, { "community.lastSignInT": { $lt: issuedAt } }],
		},
		{ $set: { "community.lastSignInT": issuedAt } }
	);
	if (!matchedCount) return { newsletter, spent: true };
	await startReaderSession(newsletter, contact._id);
	return { newsletter, contact };
}

// Without it a link whose time has passed and one that was never real look alike, which is the point; the page only
// needs to know whether to offer the button.
export async function previewSignInLink(token) {
	const reference = verifyReaderToken("signin", token);
	if (!reference) return { state: "invalid" };
	const newsletter = await findOpenNewsletter({ _id: reference.newsletterId });
	const contact = newsletter && (await findActiveContact(newsletter, reference.contactId));
	if (!contact) return { state: "invalid" };
	return readTokenTime(token) <= (contact.community?.lastSignInT ?? 0) ? { state: "spent", newsletter } : { state: "ready", newsletter };
}

// Asked for on an issue's page. Only a subscriber who could comment there gets the email; nobody can tell from the answer,
// which is the same for every address. Through the sending path, so an address that bounced or is suppressed gets nothing.
export async function sendSignInEmail({ newsletter, email, issueSlug }) {
	const campaign = issueSlug ? await findIssue(newsletter, issueSlug) : null;
	if (!campaign || !areCommentsOn(newsletter, campaign)) return { sent: false, reason: "comments are off" };
	const contact = await Contact.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, email, status: "active" }).lean();
	if (!contact) return { sent: false, reason: "not a subscriber" };
	const url = getSignInUrl({ contactId: contact._id, newsletterId: newsletter._id }, newsletter, { issueSlug });
	return sendTransactionalEmail({
		accountId: newsletter.accountId,
		newsletterId: newsletter._id,
		to: email,
		kind: "comment",
		subject: `Your sign-in link for ${newsletter.name}`,
		markdown: `[Sign in to comment on ${campaign.subject || "this issue"}](${url})\n\nThe link works once and expires in ${SIGNIN_MINUTES} minutes.`,
		reason: `You asked for this link on the ${newsletter.name} website. If it wasn't you, ignore this email: nothing happens until someone opens the link.`,
	});
}

function findIssue(newsletter, issueSlug) {
	return Campaign.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, archiveSlug: issueSlug, status: { $in: PUBLISHED_STATUSES } })
		.select({ subject: 1, audience: 1, comments: 1 })
		.lean();
}
