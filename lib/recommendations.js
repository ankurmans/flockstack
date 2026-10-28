import "server-only";
import { scoped } from "@/lib/account-scope";
import { ACCESS_FIELDS } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { hasPublishedIssue, revalidateArchive } from "@/lib/archive-data";
import { getArchiveUrls, getNewsletterHost } from "@/lib/archive-hosts";
import { buildAcquisition } from "@/lib/attribution";
import { getSignupProblem, upsertContact } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { createRecommendToken, verifyRecommendToken } from "@/lib/recommendation-token";
import {
	MAX_RECOMMENDATIONS,
	OWN_NEWSLETTER_MESSAGE,
	getNotFoundMessage,
	getRecommendationLink,
	getRecommendationSource,
	getRecommendationState,
	getSubscriberRange,
	normalizePitch,
	normalizeReason,
	normalizeSlug,
	readRecommenderSlug,
} from "@/lib/recommendation-rules";
import { findNewsletterAnywhere, findOpenNewsletter, findSignupNewsletter } from "@/lib/public-newsletters";
import { withActiveProvider } from "@/lib/sender-rules";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Domain from "@/models/Domain";
import Newsletter from "@/models/Newsletter";
import Recommendation from "@/models/Recommendation";

// What the recommended side needs to be judged (getRecommendationState) and shown.
const RECOMMENDED_FIELDS =
	"accountId name slug imageUrl description fromEmail replyTo requireConfirmation archiveEnabled archiveHost mount sharedSender recommendations";
// A reader's signup through the step, per source and recommended newsletter: a bot loop can't turn one recommender into a
// subscription machine. Each IP also has its own cap in the signup form's action.
const PER_PAIR = { name: "recommendation-pair", limit: 300, window: "1 d" };
const ADDS = { name: "recommendation-adds", limit: 30, window: "1 d" };
const COUNTED_STATUSES = ["pending", "active"];
const DIRECTORY_CHUNK = 24;
const DIRECTORY_CANDIDATES = 2000;

// The accounts, domains and first issues of some newsletters, read together, to say which of them can take a recommendation.
async function loadContext(newsletters) {
	await connectDb();
	const accountIds = [...new Set(newsletters.map(({ accountId }) => String(accountId)))];
	if (accountIds.length === 0) return { accounts: new Map(), domains: new Map(), issues: new Set() };
	const [accounts, domains, issues] = await Promise.all([
		Account.find({ _id: { $in: accountIds } })
			.select({ ...ACCESS_FIELDS, status: 1 })
			.lean(),
		Domain.find({ accountId: { $in: accountIds } })
			.setOptions({ crossAccount: true })
			.select({ domain: 1, verified: 1, provider: 1, accountId: 1 })
			.lean(),
		Promise.all(newsletters.map(async (newsletter) => ((await hasPublishedIssue(newsletter)) ? String(newsletter._id) : null))),
	]);
	const byAccount = new Map();
	for (const domain of domains) {
		const key = String(domain.accountId);
		byAccount.set(key, [...(byAccount.get(key) ?? []), withActiveProvider(domain)]);
	}
	return {
		accounts: new Map(accounts.map((account) => [String(account._id), account])),
		domains: byAccount,
		issues: new Set(issues.filter(Boolean)),
	};
}

// Uses the same current signup checks as recommendations, without exposing account or sender details.
export async function eligibleCreatorNewsletters(newsletters) {
	const context = await loadContext(newsletters);
	return newsletters.filter((item) => item.creatorMatch?.enabled && item.recommendations?.listed && item.recommendations?.allowIncoming !== false && stateOf(context, { status: "active" }, item).status === "active");
}

function stateOf(context, recommendation, recommended) {
	return getRecommendationState({
		recommendation,
		recommended,
		account: recommended && context.accounts.get(String(recommended.accountId)),
		hasIssue: Boolean(recommended) && context.issues.has(String(recommended._id)),
		domains: recommended ? (context.domains.get(String(recommended.accountId)) ?? []) : [],
	});
}

function findNewsletters(ids, select = RECOMMENDED_FIELDS) {
	if (ids.length === 0) return Promise.resolve([]);
	return Newsletter.find({ _id: { $in: ids } })
		.setOptions({ crossAccount: true })
		.select(select)
		.lean();
}

function findOutgoing(newsletter, extra = {}) {
	return Recommendation.find(scoped(newsletter.accountId, { recommenderId: newsletter._id, ...extra }))
		.sort({ position: 1, _id: 1 })
		.lean();
}

// The recommendations a newsletter shows readers, in its order: stored as active and their newsletters can take them now.
export async function listLiveRecommendations(newsletter) {
	await connectDb();
	const recommendations = await findOutgoing(newsletter, { status: "active" });
	if (recommendations.length === 0) return [];
	const recommended = await findNewsletters(recommendations.map(({ recommendedId }) => recommendedId));
	const byId = new Map(recommended.map((item) => [String(item._id), item]));
	const context = await loadContext(recommended);
	return recommendations.flatMap((recommendation) => {
		const target = byId.get(String(recommendation.recommendedId));
		if (stateOf(context, recommendation, target).status !== "active") return [];
		return [
			{
				id: String(target._id),
				slug: target.slug,
				name: target.name,
				imageUrl: target.imageUrl || null,
				description: target.description || "",
				pitch: recommendation.pitch,
				url: getRecommendationLink(target, newsletter.slug),
			},
		];
	});
}

// An issue's email asks for the block once per recipient: a short memory per newsletter keeps a send of thousands to one read.
const EMAIL_MEMORY_MS = 30_000;
const emailMemory = new Map();

export function forgetEmailRecommendations() {
	emailMemory.clear();
}

export async function getEmailRecommendations(newsletter) {
	const key = String(newsletter._id);
	const remembered = emailMemory.get(key);
	if (remembered && Date.now() - remembered.at < EMAIL_MEMORY_MS) return remembered.items;
	const items = (await listLiveRecommendations(newsletter)).map(({ name, pitch, url }) => ({ name, pitch, url }));
	emailMemory.set(key, { at: Date.now(), items });
	if (emailMemory.size > 500) emailMemory.delete(emailMemory.keys().next().value);
	return items;
}

// The step after a signup: what to offer and the token that proves the reader just subscribed to this newsletter.
export async function getReaderStep({ newsletter, contact }) {
	if (!contact || contact.status === "pending") return null;
	const items = await listLiveRecommendations(newsletter);
	if (items.length === 0) return null;
	return {
		token: createRecommendToken({ contactId: contact._id, newsletterId: newsletter._id }),
		newsletter: newsletter.slug,
		newsletterName: newsletter.name,
		recommendations: items.map(({ slug, name, pitch, imageUrl, description }) => ({ slug, name, pitch, imageUrl, description })),
	};
}

// A reader's ticks on the step. Every tick is a signup through that newsletter's own flow: its confirmation email, its
// suppression and consent rules. The reader's address is used only for the newsletters they chose, and only with the token of
// the signup or confirmation that just happened. Returns what was done for the action to send the emails.
export async function subscribeToRecommended({ token, slugs }) {
	const reference = verifyRecommendToken(token);
	if (!reference) return { error: "This page has expired. Subscribe from the newsletter's website again." };
	await connectDb();
	const source = await findOpenNewsletter({ _id: reference.newsletterId });
	const contact = source && (await Contact.findOne(scoped(source.accountId, { _id: reference.contactId, newsletterId: source._id })).lean());
	if (!contact) return { error: "This page has expired. Subscribe from the newsletter's website again." };

	const wanted = new Set((Array.isArray(slugs) ? slugs : []).map(normalizeSlug).filter(Boolean));
	const chosen = (await listLiveRecommendations(source)).filter(({ slug }) => wanted.has(slug));
	if (chosen.length === 0) return { error: "Tick the newsletters you want first." };
	const problem = await getSignupProblem(contact.email);
	if (problem) return { error: problem };

	const results = [];
	for (const item of chosen) {
		const newsletter = await findSignupNewsletter({ _id: item.id });
		if (!newsletter || newsletter.recommendations?.allowIncoming === false || !newsletter.requireConfirmation) continue;
		if (await isRateLimited({ ...PER_PAIR, key: `${source.slug}:${newsletter.slug}` })) continue;
		const { contact: joined, created } = await upsertContact({
			newsletter,
			email: contact.email,
			source: getRecommendationSource(source.slug),
			resubscribe: true,
			acquisition: buildAcquisition({ source: getRecommendationSource(source.slug), referrer: getNewsletterHost(source), ownHosts: [getNewsletterHost(newsletter)] }),
		});
		// An address that left or bounced before comes back as it was, and brought nobody.
		if (created && COUNTED_STATUSES.includes(joined.status)) {
			await countSignup({ recommender: source, recommendedId: newsletter._id, isConfirmed: joined.status === "active" });
		}
		results.push({ newsletter, contact: joined, created, isPending: joined.status === "pending" });
	}
	return { results };
}

// A signup from a recommendation's link: the recommender's slug rides in the address as ?rec=. It counts only for a
// recommendation that is active between those two newsletters and that the recommended one can take. Returns the contact's source
// and the recommender, or null.
export async function findAttribution({ newsletter, slug }) {
	const recommenderSlug = normalizeSlug(slug);
	if (!recommenderSlug || recommenderSlug === newsletter.slug || newsletter.recommendations?.allowIncoming === false) return null;
	const recommender = await findNewsletterAnywhere({ slug: recommenderSlug });
	if (!recommender || String(recommender._id) === String(newsletter._id)) return null;
	const recommendation = await Recommendation.findOne(
		scoped(recommender.accountId, { recommenderId: recommender._id, recommendedId: newsletter._id, status: "active" })
	).lean();
	return recommendation ? { source: getRecommendationSource(recommender.slug), recommender } : null;
}

// Counts one new contact for a recommendation. isConfirmed: it joined without a confirmation to wait for.
export async function countSignup({ recommender, recommendedId, isConfirmed = false }) {
	await Recommendation.updateOne(
		scoped(recommender.accountId, { recommenderId: recommender._id, recommendedId }),
		{ $inc: { "stats.signups": 1, ...(isConfirmed && { "stats.confirmed": 1 }) } }
	);
}

// A contact that came through a recommendation confirmed: counted once, because only the first confirmation reports it.
export async function countConfirmation({ newsletter, contact }) {
	const recommenderSlug = readRecommenderSlug(contact?.source);
	if (!recommenderSlug) return;
	const recommender = await findNewsletterAnywhere({ slug: recommenderSlug });
	if (!recommender) return;
	await Recommendation.updateOne(
		scoped(recommender.accountId, { recommenderId: recommender._id, recommendedId: newsletter._id }),
		{ $inc: { "stats.confirmed": 1 } }
	);
}

// Pages that showed a newsletter's recommendations, one count per recommendation that was on the page. The page says which, and
// only those the newsletter stores as active count. No reader is identified.
export async function countImpressions({ slug, shown }) {
	const recommenderSlug = normalizeSlug(slug);
	const shownSlugs = [...new Set((Array.isArray(shown) ? shown : []).map(normalizeSlug).filter(Boolean))].slice(0, MAX_RECOMMENDATIONS);
	if (!recommenderSlug || shownSlugs.length === 0) return 0;
	await connectDb();
	const recommender = await findNewsletterAnywhere({ slug: recommenderSlug });
	if (!recommender) return 0;
	const shownIds = (await findNewslettersBySlug(shownSlugs)).map(({ _id }) => _id);
	if (shownIds.length === 0) return 0;
	const { modifiedCount } = await Recommendation.updateMany(
		scoped(recommender.accountId, { recommenderId: recommender._id, status: "active", recommendedId: { $in: shownIds } }),
		{ $inc: { "stats.impressions": 1 } }
	);
	return modifiedCount;
}

function findNewslettersBySlug(slugs) {
	return Newsletter.find({ slug: { $in: slugs } })
		.setOptions({ crossAccount: true })
		.select({ _id: 1 })
		.lean();
}

function toOutgoing(recommendation, recommended, state) {
	return {
		id: String(recommendation._id),
		newsletter: recommended ? { id: String(recommended._id), slug: recommended.slug, name: recommended.name, imageUrl: recommended.imageUrl || null } : null,
		pitch: recommendation.pitch,
		position: recommendation.position ?? 0,
		status: state.status,
		reason: state.reason,
		removedBy: state.removedBy,
		impressions: recommendation.stats?.impressions ?? 0,
		signups: recommendation.stats?.signups ?? 0,
		confirmed: recommendation.stats?.confirmed ?? 0,
		createdAt: recommendation.createdAt,
	};
}

// A newsletter's recommendations to others, with where each stands and the reason when it isn't showing.
export async function listOutgoing(newsletter) {
	await connectDb();
	const recommendations = await findOutgoing(newsletter);
	const recommended = await findNewsletters(recommendations.map(({ recommendedId }) => recommendedId));
	const byId = new Map(recommended.map((item) => [String(item._id), item]));
	const context = await loadContext(recommended);
	return recommendations.map((recommendation) => {
		const target = byId.get(String(recommendation.recommendedId));
		return toOutgoing(recommendation, target, stateOf(context, recommendation, target));
	});
}

// Who recommends a newsletter, with the pitch they wrote and what it brought. Removed and declined ones stay in the list with
// their reason, so the owner can bring one back.
export async function listIncoming(newsletter) {
	await connectDb();
	const recommendations = await Recommendation.find({ recommendedId: newsletter._id })
		.setOptions({ crossAccount: true })
		.sort({ createdAt: -1, _id: -1 })
		.limit(200)
		.lean();
	const recommenders = await findNewsletters(recommendations.map(({ recommenderId }) => recommenderId), "name slug imageUrl");
	const byId = new Map(recommenders.map((item) => [String(item._id), item]));
	return recommendations.flatMap((recommendation) => {
		const recommender = byId.get(String(recommendation.recommenderId));
		if (!recommender) return [];
		return [
			{
				id: String(recommendation._id),
				recommender: { slug: recommender.slug, name: recommender.name, imageUrl: recommender.imageUrl || null },
				pitch: recommendation.pitch,
				status: recommendation.status,
				reason: recommendation.status === "removed" ? recommendation.reason || null : null,
				removedBy: recommendation.status === "removed" ? (recommendation.removedBy ?? "system") : null,
				impressions: recommendation.stats?.impressions ?? 0,
				signups: recommendation.stats?.signups ?? 0,
				confirmed: recommendation.stats?.confirmed ?? 0,
				createdAt: recommendation.createdAt,
			},
		];
	});
}

export function sumStats(items) {
	return items.reduce(
		(total, item) => ({ impressions: total.impressions + item.impressions, signups: total.signups + item.signups, confirmed: total.confirmed + item.confirmed }),
		{ impressions: 0, signups: 0, confirmed: 0 }
	);
}

export async function findOutgoingById(account, recommenderId, id) {
	return Recommendation.findOne(scoped(account, { _id: id, recommenderId })).lean();
}

// Adds a recommendation from a newsletter, or brings back one its owner removed. Refused with a plain message when the other
// newsletter can't take it.
export async function addRecommendation({ account, recommender, slug, pitch }) {
	const recommendedSlug = normalizeSlug(slug);
	if (!recommendedSlug) throw actionError("validation_failed", "slug: use the slug of the newsletter, like weekly-fox");
	const { pitch: text, problem } = normalizePitch(pitch);
	if (problem) throw actionError("validation_failed", problem);

	const target = await findNewsletterAnywhere({ slug: recommendedSlug });
	if (!target) throw actionError("not_found", getNotFoundMessage(recommendedSlug));
	if (String(target._id) === String(recommender._id)) throw actionError("validation_failed", OWN_NEWSLETTER_MESSAGE);

	const existing = await Recommendation.findOne(scoped(account, { recommenderId: recommender._id, recommendedId: target._id })).lean();
	if (existing?.status === "active") throw actionError("conflict", `You already recommend ${target.name}.`);
	if (existing?.removedBy === "recommended") {
		throw actionError("conflict", `${target.name} declined your recommendation: ${existing.reason || "no reason given"}`);
	}
	const unavailable = await getAddProblem(target);
	if (unavailable) throw actionError("conflict", unavailable);
	const active = await Recommendation.countDocuments(scoped(account, { recommenderId: recommender._id, status: "active" }));
	if (active >= MAX_RECOMMENDATIONS) {
		throw actionError("conflict", `A newsletter recommends up to ${MAX_RECOMMENDATIONS} others. Remove one first.`);
	}
	if (await isRateLimited({ ...ADDS, key: String(account._id) })) {
		throw actionError("rate_limited", `You can add ${ADDS.limit} recommendations a day. Try again tomorrow.`);
	}

	const position = active;
	let saved;
	if (existing) {
		saved = await Recommendation.findOneAndUpdate(
			scoped(account, { _id: existing._id }),
			{ $set: { pitch: text, position, status: "active", recommendedAccountId: target.accountId }, $unset: { reason: 1, removedBy: 1, removedAt: 1 } },
			{ returnDocument: "after" }
		).lean();
	} else {
		try {
			saved = (
				await Recommendation.create({
					accountId: account._id,
					recommenderId: recommender._id,
					recommendedId: target._id,
					recommendedAccountId: target.accountId,
					pitch: text,
					position,
				})
			).toObject();
		} catch (error) {
			if (error?.code === 11000) throw actionError("conflict", `You already recommend ${target.name}.`);
			throw error;
		}
	}
	revalidateArchive();
	return (await listOutgoing(recommender)).find(({ id }) => id === String(saved._id));
}

async function getAddProblem(target) {
	const context = await loadContext([target]);
	const state = stateOf(context, { status: "active" }, target);
	return state.status === "active" ? null : state.reason;
}

export async function updateRecommendation({ account, recommender, id, pitch, position }) {
	const recommendation = await findOutgoingById(account, recommender._id, id);
	if (!recommendation) throw actionError("not_found", "Recommendation not found");
	const set = {};
	if (pitch !== undefined) {
		const { pitch: text, problem } = normalizePitch(pitch);
		if (problem) throw actionError("validation_failed", problem);
		set.pitch = text;
	}
	if (position !== undefined) set.position = position;
	if (Object.keys(set).length > 0) {
		if (recommendation.status === "removed") throw actionError("conflict", "This recommendation was removed. Add the newsletter again to change it.");
		await Recommendation.updateOne(scoped(account, { _id: recommendation._id }), { $set: set });
		revalidateArchive();
	}
	return (await listOutgoing(recommender)).find((item) => item.id === id);
}

// Taking a recommendation out. One that never brought anything isn't kept; the others stay with their counts, as removed.
// The record stays, removed, with its pitch and counts: adding the same newsletter again brings it back as it was.
export async function removeRecommendation({ account, recommender, id }) {
	const recommendation = await findOutgoingById(account, recommender._id, id);
	if (!recommendation) throw actionError("not_found", "Recommendation not found");
	if (recommendation.status !== "removed") {
		await Recommendation.updateOne(scoped(account, { _id: recommendation._id }), {
			$set: { status: "removed", reason: "You removed it.", removedBy: "recommender", removedAt: new Date() },
		});
	}
	revalidateArchive();
	return { removed: true };
}

// The owner of the recommended newsletter declines one recommendation, with the reason its recommender will read, or brings
// it back.
export async function decideIncoming({ account, newsletter, id, decision, reason }) {
	const recommendation = await Recommendation.findOne({ _id: id, recommendedId: newsletter._id, recommendedAccountId: account._id })
		.setOptions({ crossAccount: true })
		.lean();
	if (!recommendation) throw actionError("not_found", "Recommendation not found");
	const filter = scoped(recommendation.accountId, { _id: recommendation._id });
	if (decision === "decline") {
		const { reason: text, problem } = normalizeReason(reason);
		if (problem) throw actionError("validation_failed", problem);
		await Recommendation.updateOne(filter, { $set: { status: "removed", reason: text, removedBy: "recommended", removedAt: new Date() } });
	} else {
		if (recommendation.status !== "removed" || recommendation.removedBy !== "recommended") {
			throw actionError("conflict", "Only a recommendation you declined can be brought back.");
		}
		await Recommendation.updateOne(filter, { $set: { status: "active" }, $unset: { reason: 1, removedBy: 1, removedAt: 1 } });
	}
	revalidateArchive();
	return (await listIncoming(newsletter)).find((item) => item.id === id);
}

// Opting out takes effect at once: readers stop seeing it and new signups stop counting. The recommenders keep their records,
// shown as pending with the reason.
export async function saveSettings({ account, newsletter, allowIncoming, listed }) {
	const set = {};
	if (allowIncoming !== undefined) set["recommendations.allowIncoming"] = allowIncoming;
	if (listed !== undefined) {
		if (listed) {
			const stays = allowIncoming ?? (newsletter.recommendations?.allowIncoming !== false);
			if (!stays) throw actionError("validation_failed", "A newsletter that turned off incoming recommendations can't be listed in the directory");
			if (!newsletter.archiveEnabled) throw actionError("validation_failed", "Turn the website on first: the directory links to it");
		}
		set["recommendations.listed"] = listed;
	}
	if (allowIncoming === false && !("recommendations.listed" in set)) set["recommendations.listed"] = false;
	if (Object.keys(set).length > 0) {
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: set });
		revalidateArchive();
	}
	return Newsletter.findOne(scoped(account, { _id: newsletter._id })).lean();
}

function matches(newsletter, query) {
	if (!query) return true;
	const haystack = `${newsletter.name} ${newsletter.description ?? ""}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word));
}

// The directory: newsletters that listed themselves, take recommendations and can take a signup now. Names, descriptions and a
// range of subscribers, never an exact number. excludeAccount: a creator looking for newsletters to recommend doesn't see their own.
export async function searchListedNewsletters({ query = "", page = 1, pageSize = 12, excludeAccount = null } = {}) {
	await connectDb();
	const candidates = (
		await Newsletter.find({ "recommendations.listed": true, archiveEnabled: true })
			.setOptions({ crossAccount: true })
			.select(`${RECOMMENDED_FIELDS} socialLinks`)
			.limit(DIRECTORY_CANDIDATES)
			.lean()
	)
		.filter((item) => item.recommendations?.allowIncoming !== false && String(item.accountId) !== String(excludeAccount ?? ""))
		.filter((item) => matches(item, String(query).trim().slice(0, 100)))
		.sort((a, b) => a.name.localeCompare(b.name) || String(a._id).localeCompare(String(b._id)));

	const wanted = (page - 1) * pageSize + pageSize + 1;
	const eligible = [];
	for (let start = 0; start < candidates.length && eligible.length < wanted; start += DIRECTORY_CHUNK) {
		const chunk = candidates.slice(start, start + DIRECTORY_CHUNK);
		const context = await loadContext(chunk);
		for (const item of chunk) if (stateOf(context, { status: "active" }, item).status === "active") eligible.push(item);
	}
	const shown = eligible.slice((page - 1) * pageSize, page * pageSize);
	const counts = await Promise.all(
		shown.map((item) => Contact.countDocuments(scoped(item.accountId, { newsletterId: item._id, status: "active" })))
	);
	return {
		newsletters: shown.map((item, index) => ({
			id: String(item._id),
			slug: item.slug,
			name: item.name,
			description: item.description || "",
			imageUrl: item.imageUrl || null,
			subscriberRange: getSubscriberRange(counts[index]),
			url: getArchiveUrls(item).siteIndex,
		})),
		hasMore: eligible.length > page * pageSize,
	};
}
