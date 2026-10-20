import "server-only";
import { after } from "next/server";
import { sendAlert } from "@/lib/alerts";
import { buildAcquisition, parseAttributionInput } from "@/lib/attribution";
import { getNewsletterHost } from "@/lib/archive-hosts";
import { getAppHost, isSendingEnabled } from "@/lib/config";
import { getSignupProblem, upsertContact } from "@/lib/contacts";
import { buildFieldUpdate, parseFieldValue } from "@/lib/custom-fields";
import { connectDb } from "@/lib/db";
import { getInbox } from "@/lib/inbox-links";
import { findSignupNewsletter } from "@/lib/public-newsletters";
import { isRateLimited } from "@/lib/rate-limit";
import { countSignup, findAttribution, getReaderStep } from "@/lib/recommendations";
import { recordReferral } from "@/lib/referrals";
import { getHeaderCountry } from "@/lib/signup-country";
import { queueConfirmationEmail, queueWelcomeEmail } from "@/lib/sending";
import { getSurveyUrl } from "@/lib/subscriber-links";
import { findPlacedSurvey, getPlacedSurveyUrl } from "@/lib/surveys";
import { normalizeEmail } from "@/lib/validation";
import CustomField from "@/models/CustomField";

export const SIGNUP_PER_IP = { name: "subscribe-ip", limit: 5, window: "10 m" };
// Only alerts: refusing signups past a shared limit would let one flooder block every real signup.
// A flood from many IPs (list bombing) still needs a look: it fills the list with spam traps.
const PER_NEWSLETTER = { name: "subscribe-newsletter", limit: 300, window: "10 m" };
// Where a signup on the newsletter's own pages came from. A form, a magic link or the API name themselves.
export const WEBSITE_SOURCES = ["website", "popup", "gate"];
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9_-]{27}$/;

// One signup to a newsletter, whatever it came through: the website form, a popup, an embedded form, a Magic Link. formData has
// the email, the "newsletter" slug, the custom fields the form asks for (field_<key>), and optionally "rec", "ref" and "acq"
// (lib/attribution.js). The "website" field is the honeypot. source says where the signup was made; referrer is the page that
// holds the form when the browser didn't say (an embedded form's page). headers: the request's, which say the country the
// signup came from (lib/signup-country.js); the country and where the signup came from (lib/attribution.js) are read here, once,
// for every way in. fieldKeys: the custom fields a form of its own asks
// for, instead of the ones marked for the newsletter's signup form. onSignup({ newsletter, contact, created }) runs once the
// contact is stored, for a form's counts; it never fails the signup.
// requireWebsite: the newsletter's website has to be on, as for its own signup form; a form or a Magic Link lives on the
// newsletter's host whatever the website says. resubscribe: signing up again brings back a contact who left or went dormant;
// a link that someone else's platform filled in with the address (a Magic Link) is no sign that its owner wants that.
export async function signUp({ formData, ip, headers = null, source = "website", utm = null, referrer = "", fieldKeys = null, onSignup = null, requireWebsite = true, resubscribe = true }) {
	// People never see this field; bots fill in every input they find.
	if (formData.get("website")) return { ok: true };

	const email = normalizeEmail(formData.get("email"));
	if (!email) return { error: "Enter a valid email" };

	if (await isRateLimited({ ...SIGNUP_PER_IP, key: ip })) {
		return { error: "Too many signups from your network. Try again in a few minutes." };
	}
	const emailProblem = await getSignupProblem(email);
	if (emailProblem) return { error: emailProblem };

	await connectDb();
	const newsletter = await findSignupNewsletter({
		slug: String(formData.get("newsletter") ?? ""),
		...(requireWebsite && { archiveEnabled: true }),
	});
	if (!newsletter) return { error: "This newsletter is not taking signups" };

	// Visitors only ever fill in the fields the form asks for, and never tags.
	const definitions = await CustomField.find({
		accountId: newsletter.accountId,
		newsletterId: newsletter._id,
		...(fieldKeys ? { key: { $in: fieldKeys } } : { onSignupForm: true }),
	}).lean();
	const values = {};
	for (const definition of definitions) {
		const { key, label, type, multiple } = definition;
		const value = type === "list" && multiple ? formData.getAll(`field_${key}`).map(String) : String(formData.get(`field_${key}`) ?? "").trim();
		if (value.length === 0) continue;
		const { problem } = parseFieldValue(type, value, definition);
		if (problem) return { error: `${label} ${problem}` };
		values[key] = value;
	}
	const fieldUpdate = buildFieldUpdate(definitions, values);

	if (await isRateLimited({ ...PER_NEWSLETTER, key: newsletter.slug })) {
		after(() =>
			sendAlert({
				accountId: newsletter.accountId,
				key: `signup-flood:${newsletter.slug}`,
				title: "Website signup flood",
				detail: `Over ${PER_NEWSLETTER.limit} signups to ${newsletter.name} in 10 minutes. They still go through (${SIGNUP_PER_IP.limit} per visitor per 10 minutes); check new contacts for junk.`,
				path: "/contacts",
			})
		);
	}

	// A visitor who followed another newsletter's recommendation: the signup is counted for it (lib/recommendations.js).
	const recommended = await findAttribution({ newsletter, slug: String(formData.get("rec") ?? "") }).catch(() => null);
	const referralCode = String(formData.get("ref") ?? "").trim();
	const carried = parseAttributionInput(formData.get("acq"));
	const contactSource = recommended?.source ?? source;
	const acquisition = buildAcquisition({
		source: referralCode && REFERRAL_CODE_PATTERN.test(referralCode) ? "referral" : contactSource,
		utm: utm ?? carried.utm,
		referrer: referrer || carried.referrer,
		ownHosts: [getNewsletterHost(newsletter), getAppHost()],
	});
	const { contact, created } = await upsertContact({ newsletter, email, source: contactSource, resubscribe, fieldUpdate, country: getHeaderCountry(headers), acquisition });
	if (onSignup) {
		await Promise.resolve()
			.then(() => onSignup({ newsletter, contact, created }))
			.catch((error) => console.error(`[signup] Count for ${contact._id} failed:`, error.message));
	}
	if (recommended && created && contact.status !== "unsubscribed" && contact.status !== "bounced" && contact.status !== "complained") {
		await countSignup({ recommender: recommended.recommender, recommendedId: newsletter._id, isConfirmed: contact.status === "active" }).catch((error) =>
			console.error(`[signup] Recommendation signup for ${contact._id} not counted:`, error.message)
		);
	}
	// A signup through a subscriber's referral link: counted once the new subscriber confirms.
	if (referralCode && created) {
		after(() =>
			recordReferral({ newsletter, contact, created, code: referralCode, ip }).catch((error) =>
				console.error(`[signup] Referral for ${contact._id} not recorded:`, error.message)
			)
		);
	}
	const isPending = contact.status === "pending";
	if (isSendingEnabled() && (isPending || (created && contact.status === "active"))) {
		const queue = isPending ? queueConfirmationEmail : queueWelcomeEmail;
		after(() =>
			queue({ newsletter, contact }).catch((error) =>
				console.error(`[signup] Signup email for ${contact._id} failed:`, error.message)
			)
		);
	}
	const survey = await getSignupSurvey({ newsletter, contact, created });
	if (!isPending) {
		const step = await getStep({ newsletter, contact });
		return { ok: true, ...(step && { step }), ...(survey && { survey }) };
	}
	return { ok: true, pending: true, email, inbox: getInbox({ email, fromEmail: newsletter.fromEmail }), ...(survey && { survey }) };
}

// The newsletter's after-signup survey (lib/surveys.js). Only a contact this signup made answers as themselves, like the
// form's own fields: typing someone else's address never opens their answers. Never fails the signup.
async function getSignupSurvey({ newsletter, contact, created }) {
	try {
		if (created) return await getPlacedSurveyUrl(newsletter, "afterSignup", contact._id);
		const survey = await findPlacedSurvey(newsletter, "afterSignup");
		return survey ? getSurveyUrl(null, newsletter, { surveyId: String(survey._id), from: "signup" }) : null;
	} catch (error) {
		console.error(`[signup] Survey for ${newsletter.slug} not loaded:`, error.message);
		return null;
	}
}

// The newsletters this one recommends, for the reader who just joined. Never fails the signup.
async function getStep({ newsletter, contact }) {
	try {
		return await getReaderStep({ newsletter, contact });
	} catch (error) {
		console.error(`[signup] Recommendations for ${newsletter.slug} not loaded:`, error.message);
		return null;
	}
}
