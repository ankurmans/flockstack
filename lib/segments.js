import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { buildAudienceQuery } from "@/lib/audience";
import { listCustomFields } from "@/lib/custom-fields";
import { countResendAudience, isResend } from "@/lib/resends";
import { SegmentRulesSchema, checkRules, compileRules } from "@/lib/segment-rules";
import Contact from "@/models/Contact";
import Segment from "@/models/Segment";
import Suppression from "@/models/Suppression";

export { SegmentRulesSchema };

const SAMPLE_SIZE = 10;

// Rules from a caller, checked against the newsletter's custom fields and ready to store, or a validation error.
export async function validateRules(account, newsletterId, input) {
	const fields = await listCustomFields(account, newsletterId);
	const result = checkRules(input, new Map(fields.map(({ key, type }) => [key, type])));
	if (result.problem) throw actionError("validation_failed", `rules: ${result.problem}`);
	return result.rules;
}

export async function findSegmentByReference(account, reference, newsletterId) {
	const value = String(reference ?? "").trim();
	const byId = /^[a-f0-9]{24}$/i.test(value) ? { _id: value.toLowerCase() } : null;
	const segment = await Segment.findOne(scoped(account, { ...(newsletterId && { newsletterId }), ...(byId ?? { name: value }) })).lean();
	if (!segment) throw actionError("not_found", "Segment not found");
	return segment;
}

// Every contact the rules match in the newsletter, whatever its status.
export function getSegmentFilter(account, newsletterId, rules, now = new Date()) {
	return scoped(account, { newsletterId, ...compileRules(rules, now) });
}

// The audience of a send: active contacts the account never suppressed, who also match the rules.
async function getSendableFilter(account, newsletterId, rules, now) {
	const suppressedEmails = await Suppression.distinct("email", { accountId: scoped(account).accountId });
	return buildAudienceQuery({ accountId: scoped(account).accountId, newsletterId, suppressedEmails, segmentFilter: compileRules(rules, now) }).filter;
}

// Live counts for a segment: everyone it matches, the active ones, and the ones a send would reach once suppressed
// addresses are out (the list cleanup, which a send also applies, is campaign-wide: preview_campaign_recipients).
export async function previewRules(account, newsletterId, rules, { sample = SAMPLE_SIZE, now = new Date() } = {}) {
	const matchFilter = getSegmentFilter(account, newsletterId, rules, now);
	const [matching, active, sendable, contacts] = await Promise.all([
		Contact.countDocuments(matchFilter),
		Contact.countDocuments({ ...matchFilter, status: "active" }),
		getSendableFilter(account, newsletterId, rules, now).then((filter) => Contact.countDocuments(filter)),
		sample > 0
			? Contact.find(matchFilter).sort({ subscribedAt: -1, _id: -1 }).limit(sample).select({ email: 1, status: 1, tags: 1 }).lean()
			: [],
	]);
	return {
		matching,
		active,
		sendable,
		sample: contacts.map((contact) => ({ id: String(contact._id), email: contact.email, status: contact.status, tags: contact.tags ?? [] })),
	};
}

export async function countMatching(account, newsletterId, rules, now = new Date()) {
	return Contact.countDocuments(getSegmentFilter(account, newsletterId, rules, now));
}

// The segment a campaign goes to: the rules copied when its send started, else the saved segment's own. Null for a
// campaign that goes to everyone.
export async function resolveCampaignSegment(campaign) {
	if (campaign.segmentSnapshot?.rules) return campaign.segmentSnapshot;
	if (!campaign.segmentId) return null;
	const segment = await Segment.findOne({ accountId: campaign.accountId, _id: campaign.segmentId }).select({ name: 1, rules: 1 }).lean();
	if (!segment) {
		throw Object.assign(new Error("The campaign's segment was deleted: pick another audience"), { code: "not_found" });
	}
	return { name: segment.name, rules: segment.rules };
}

export async function resolveCampaignSegmentFilter(campaign, now = new Date()) {
	const segment = await resolveCampaignSegment(campaign);
	return segment ? compileRules(segment.rules, now) : null;
}

// The filter for the contacts a send of the campaign would reach: the same as the send's own (lib/audience.js), so
// counts and previews agree with it. A segment deleted since counts as nobody here; the send itself refuses.
// audience (all, free or paid) narrows it to a tier, as the send's own does.
export async function getCampaignAudienceFilter(campaign, { audience = "all" } = {}) {
	let segmentFilter = null;
	try {
		segmentFilter = await resolveCampaignSegmentFilter(campaign);
	} catch (error) {
		if (error.code !== "not_found") throw error;
		return null;
	}
	const suppressedEmails = await Suppression.distinct("email", { accountId: campaign.accountId });
	return buildAudienceQuery({ accountId: campaign.accountId, newsletterId: campaign.newsletterId, suppressedEmails, segmentFilter, audience }).filter;
}

// A resend counts its first send's readers who didn't open it: at most this many.
export async function countCampaignAudience(campaign, options) {
	if (isResend(campaign)) return countResendAudience(campaign);
	const filter = await getCampaignAudienceFilter(campaign, options);
	return filter ? Contact.countDocuments(filter) : 0;
}
