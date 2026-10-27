import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { buildAudienceQuery } from "@/lib/audience";
import { listCustomFields } from "@/lib/custom-fields";
import { countResendAudience, isResend } from "@/lib/resends";
import { MAX_LOOKUP_CONTACTS, checkRules, collectLookups, compileRules, getIssueLinks, needsLookup } from "@/lib/segment-rules";
import { getNewsletterTiers } from "@/lib/tier-rules";
import Campaign from "@/models/Campaign";
import CampaignLink from "@/models/CampaignLink";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Poll from "@/models/Poll";
import Segment from "@/models/Segment";
import SegmentMember from "@/models/SegmentMember";
import Suppression from "@/models/Suppression";

const SAMPLE_SIZE = 10;

// The poll conditions keep the poll's question and the answers' labels, for the summary.
async function fillInPolls(account, newsletterId, conditions) {
	const polls = await Poll.find(scoped(account, { newsletterId, _id: { $in: [...new Set(conditions.map(({ poll }) => poll))] } }))
		.select({ question: 1, options: 1 })
		.lean();
	const byId = new Map(polls.map((poll) => [String(poll._id), poll]));
	for (const condition of conditions) {
		const poll = byId.get(condition.poll);
		if (!poll) throw actionError("validation_failed", `rules: the newsletter has no poll ${condition.poll}`);
		condition.question = poll.question;
		const picked = condition.options ?? (condition.option === undefined ? [] : [condition.option]);
		if (picked.some((option) => option >= poll.options.length)) throw actionError("validation_failed", `rules: the poll has ${poll.options.length} answers`);
		if (condition.option !== undefined) condition.answer = poll.options[condition.option].label;
		if (condition.options) condition.answers = condition.options.map((option) => poll.options[option].label);
	}
}

// An issue condition keeps the issue's subject, and a link's address becomes the places it has in the issue.
async function fillInIssues(account, newsletterId, conditions) {
	for (const condition of conditions) {
		const campaign = await Campaign.findOne(scoped(account, { _id: condition.campaign, newsletterId })).select({ subject: 1 }).lean();
		if (!campaign) throw actionError("validation_failed", `rules: the newsletter has no issue ${condition.campaign}`);
		condition.subject = campaign.subject;
		if (condition.url) {
			const links = await CampaignLink.find(scoped(account, { campaignId: condition.campaign, url: condition.url })).select({ index: 1 }).lean();
			if (links.length === 0) throw actionError("validation_failed", "rules: the issue has no link with that address: use a link as the issue's report lists it");
			condition.links = links.map(({ index }) => index).sort((a, b) => a - b);
		} else if (condition.link !== undefined && !(await CampaignLink.exists(scoped(account, { campaignId: condition.campaign, index: condition.link })))) {
			throw actionError("validation_failed", `rules: the issue has no link ${condition.link}: the report lists them from 0`);
		}
	}
}

async function fillInSnapshots(account, newsletterId, conditions) {
	for (const condition of conditions) {
		const list = await Segment.findOne(scoped(account, { _id: condition.segment, newsletterId, kind: "static" })).select({ name: 1, buildStatus: 1 }).lean();
		if (!list) throw actionError("validation_failed", `rules: the newsletter has no saved list ${condition.segment}`);
		condition.name = list.name;
	}
}

// Rules from a caller, checked against the newsletter's custom fields, polls, issues and saved lists and ready to store,
// or a validation error. Polls, issues and lists keep what the summary needs to read in words.
export async function validateRules(account, newsletterId, input) {
	const fields = await listCustomFields(account, newsletterId);
	const result = checkRules(input, new Map(fields.map((field) => [field.key, field])));
	if (result.problem) throw actionError("validation_failed", `rules: ${result.problem}`);
	const conditions = result.rules.conditions.flatMap((item) => item.conditions ?? [item]);
	const of = (type) => conditions.filter((condition) => condition.type === type);
	if (of("poll").length > 0) await fillInPolls(account, newsletterId, of("poll"));
	if (of("issue").length > 0) await fillInIssues(account, newsletterId, of("issue"));
	if (of("snapshot").length > 0) await fillInSnapshots(account, newsletterId, of("snapshot"));
	await nameTierConditions(account, newsletterId, of("tier").filter(({ value }) => value !== "free" && value !== "paid"));
	return result.rules;
}

// A tier condition names a tier of the newsletter, and keeps its name for the summary.
async function nameTierConditions(account, newsletterId, conditions) {
	if (conditions.length === 0) return;
	const newsletter = await Newsletter.findOne(scoped(account, { _id: newsletterId })).lean();
	const tiers = getNewsletterTiers(newsletter);
	for (const condition of conditions) {
		const tier = tiers.find(({ id }) => id === condition.value);
		if (!tier) throw actionError("validation_failed", `rules: the newsletter has no paid tier ${condition.value}`);
		condition.name = tier.name;
	}
}

export async function findSegmentByReference(account, reference, newsletterId) {
	const value = String(reference ?? "").trim();
	const byId = /^[a-f0-9]{24}$/i.test(value) ? { _id: value.toLowerCase() } : null;
	const segment = await Segment.findOne(scoped(account, { ...(newsletterId && { newsletterId }), ...(byId ?? { name: value }) })).lean();
	if (!segment) throw actionError("not_found", "Segment not found");
	return segment;
}

const SENT_STATUSES = ["sent", "delivered", "complained"];

async function readIssueContacts(accountId, condition, contactIds) {
	const links = getIssueLinks(condition);
	const base = { campaignId: condition.campaign, kind: "campaign", ...(contactIds && { contactId: { $in: contactIds } }) };
	const filters = {
		opened: { openedAt: { $exists: true } },
		clicked: links ? { clickedLinks: { $in: links } } : { clickedAt: { $exists: true } },
		not_opened: { status: { $in: SENT_STATUSES }, openedAt: { $exists: false } },
		not_clicked: { status: { $in: SENT_STATUSES }, ...(links ? { clickedLinks: { $nin: links } } : { clickedAt: { $exists: false } }) },
	};
	return Message.distinct("contactId", scoped(accountId, { ...base, ...filters[condition.action] }));
}

// Who the conditions that need a look-up name, by their key (lib/segment-rules.js collectLookups), as the ID strings
// compileRules reads. contactIds: only these contacts matter (one contact's branch), which keeps the lists short.
export async function loadLookups(account, rules, { contactIds = null } = {}) {
	const lookups = new Map();
	for (const { key, condition } of collectLookups(rules)) {
		const found =
			condition.type === "snapshot"
				? await SegmentMember.distinct("contactId", scoped(account, { segmentId: condition.segment, ...(contactIds && { contactId: { $in: contactIds } }) }))
				: await readIssueContacts(account, condition, contactIds);
		if (found.length > MAX_LOOKUP_CONTACTS) {
			throw actionError("validation_failed", `A condition on an issue or a saved list reaches over ${MAX_LOOKUP_CONTACTS.toLocaleString("en-US")} contacts: narrow it with another condition or a link`);
		}
		lookups.set(key, found.map(String));
	}
	return lookups;
}

export function hasLookups(rules) {
	return rules.conditions.some((item) => (item.conditions ?? [item]).some(needsLookup));
}

// The filter for the contacts rules match, to put next to the account and newsletter: the rules compiled with the
// contacts their issue and saved-list conditions name.
export async function compileRulesFor(account, rules, now = new Date(), options) {
	return compileRules(rules, now, await loadLookups(account, rules, options));
}

// Every contact the rules match in the newsletter, whatever its status.
export async function getSegmentFilter(account, newsletterId, rules, now = new Date()) {
	return scoped(account, { newsletterId, ...(await compileRulesFor(account, rules, now)) });
}

// Whether one contact matches the rules: an automation's branch.
export async function contactMatchesRules(account, newsletterId, contactId, rules, now = new Date()) {
	const compiled = await compileRulesFor(account, rules, now, { contactIds: [String(contactId)] });
	return Boolean(await Contact.exists(scoped(account, { _id: contactId, newsletterId, ...compiled })));
}

// The audience of a send: active contacts the account never suppressed, who also match the rules.
async function getSendableFilter(account, newsletterId, rules, now) {
	const suppressedEmails = await Suppression.distinct("email", { accountId: scoped(account).accountId });
	return buildAudienceQuery({ accountId: scoped(account).accountId, newsletterId, suppressedEmails, segmentFilter: await compileRulesFor(account, rules, now) }).filter;
}

// Live counts for a segment: everyone it matches, the active ones, and the ones a send would reach once suppressed
// addresses are out (the list cleanup, which a send also applies, is campaign-wide: preview_campaign_recipients).
export async function previewRules(account, newsletterId, rules, { sample = SAMPLE_SIZE, now = new Date() } = {}) {
	const matchFilter = await getSegmentFilter(account, newsletterId, rules, now);
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
	return Contact.countDocuments(await getSegmentFilter(account, newsletterId, rules, now));
}

export const MAX_CAMPAIGN_SEGMENTS = 5;

// The segments a campaign goes to and leaves out, by ID. A campaign from before several segments has segmentId alone.
export function getCampaignSegmentIds(campaign) {
	const include = campaign?.segmentIds?.length ? campaign.segmentIds : campaign?.segmentId ? [campaign.segmentId] : [];
	return { include: include.map(String), exclude: (campaign?.excludeSegmentIds ?? []).map(String) };
}

function segmentDeleted() {
	return Object.assign(new Error("The campaign's segment was deleted: pick another audience"), { code: "not_found" });
}

// The segments a campaign goes to: the rules copied when its send started, else the saved segments' own. Null for a
// campaign that goes to everyone. One segment in, none out, is { name, rules } as before several segments; otherwise
// include and exclude hold each one's.
export async function resolveCampaignSegment(campaign) {
	if (campaign.segmentSnapshot?.rules || campaign.segmentSnapshot?.include) return campaign.segmentSnapshot;
	const { include, exclude } = getCampaignSegmentIds(campaign);
	if (include.length === 0 && exclude.length === 0) return null;
	const segments = await Segment.find({ accountId: campaign.accountId, _id: { $in: [...include, ...exclude] } }).select({ name: 1, rules: 1, buildStatus: 1 }).lean();
	const notReady = segments.find(({ buildStatus }) => buildStatus && buildStatus !== "ready");
	if (notReady) throw Object.assign(new Error(`The saved list ${notReady.name} ${notReady.buildStatus === "failed" ? "couldn't be saved" : "is still being saved"}: pick another audience${notReady.buildStatus === "failed" ? "" : " or wait for it"}`), { code: "conflict" });
	const byId = new Map(segments.map((segment) => [String(segment._id), { name: segment.name, rules: segment.rules }]));
	const pick = (ids) =>
		ids.map((id) => {
			if (!byId.has(id)) throw segmentDeleted();
			return byId.get(id);
		});
	const included = pick(include);
	const excluded = pick(exclude);
	if (included.length === 1 && excluded.length === 0) return included[0];
	const name = [included.map(({ name }) => name).join(" or "), ...excluded.map(({ name }) => `not ${name}`)].filter(Boolean).join(", ");
	return { name, include: included, exclude: excluded };
}

// In any of the included segments, and in none of the left out ones.
export async function resolveCampaignSegmentFilter(campaign, now = new Date()) {
	const segment = await resolveCampaignSegment(campaign);
	if (!segment) return null;
	const compile = ({ rules }) => compileRulesFor(campaign.accountId, rules, now);
	const included = await Promise.all((segment.include ?? [segment]).map(compile));
	const parts = [
		...(included.length === 1 ? included : included.length > 1 ? [{ $or: included }] : []),
		...(await Promise.all((segment.exclude ?? []).map(async (item) => ({ $nor: [await compile(item)] })))),
	];
	return parts.length === 1 ? parts[0] : { $and: parts };
}

// The filter for the contacts a send of the campaign would reach: the same as the send's own (lib/audience.js), so
// counts and previews agree with it. A segment deleted since counts as nobody here; the send itself refuses.
// audience (all, free or paid) narrows it to a tier, as the send's own does.
export async function getCampaignAudienceFilter(campaign, { audience = "all", audienceTiers = campaign.audienceTiers } = {}) {
	let segmentFilter = null;
	try {
		segmentFilter = await resolveCampaignSegmentFilter(campaign);
	} catch (error) {
		if (error.code !== "not_found" && error.code !== "conflict") throw error;
		return null;
	}
	const suppressedEmails = await Suppression.distinct("email", { accountId: campaign.accountId });
	return buildAudienceQuery({ accountId: campaign.accountId, newsletterId: campaign.newsletterId, suppressedEmails, segmentFilter, audience, audienceTiers, listIds: campaign.listIds, excludeListIds: campaign.excludeListIds }).filter;
}

// A resend counts its first send's readers who didn't open it: at most this many.
export async function countCampaignAudience(campaign, options) {
	if (isResend(campaign)) return countResendAudience(campaign);
	const filter = await getCampaignAudienceFilter(campaign, options);
	return filter ? Contact.countDocuments(filter) : 0;
}
