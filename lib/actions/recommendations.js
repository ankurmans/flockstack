import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, newsletterInput, toIso } from "@/lib/actions/shared";
import { MAX_PITCH_LENGTH, MAX_RECOMMENDATIONS, REGION_RULE } from "@/lib/recommendation-rules";
import { RECOMMENDATIONS_TAG } from "@/lib/recommendation-tags";
import {
	addRecommendation,
	decideIncoming,
	listIncoming,
	listOutgoing,
	removeRecommendation,
	saveSettings,
	searchListedNewsletters,
	sumStats,
	updateRecommendation,
} from "@/lib/recommendations";

const GROUP = "Recommendations";
const SEARCH_PAGE = 12;
const settingsFields = "name slug archiveEnabled recommendations accountId";

const NewsletterRef = z.object({ id: z.string(), slug: z.string(), name: z.string(), imageUrl: z.string().nullable() });
const CountsShape = {
	impressions: z.number().int().describe("Times a page showed it, counted once per visitor and day"),
	signups: z.number().int().describe("New contacts it brought to the recommended newsletter"),
	confirmed: z.number().int().describe("Of those, the ones who confirmed their address"),
};

const OutgoingSchema = z.object({
	id: z.string(),
	newsletter: NewsletterRef.nullable().describe("The recommended newsletter; null once it no longer exists"),
	pitch: z.string(),
	position: z.number().int().describe("Order on the website, in emails and on the signup step; lowest first"),
	status: z
		.enum(["active", "pending", "removed"])
		.describe(
			"active: readers see it. pending: the other newsletter can't take it right now, see reason; it shows again when that clears. removed: taken out, see reason."
		),
	reason: z.string().nullable().describe("Why it isn't showing, for pending and removed"),
	removedBy: z.enum(["recommender", "recommended", "system"]).nullable().describe("Who removed it, for removed"),
	...CountsShape,
	createdAt: dateOutput,
});

const IncomingSchema = z.object({
	id: z.string(),
	recommender: z.object({ slug: z.string(), name: z.string(), imageUrl: z.string().nullable() }),
	pitch: z.string().describe("What the recommender wrote about your newsletter"),
	status: z.enum(["active", "removed"]),
	reason: z.string().nullable().describe("Why it was removed, for removed"),
	removedBy: z.enum(["recommender", "recommended", "system"]).nullable(),
	...CountsShape,
	createdAt: dateOutput,
});

const SettingsSchema = z.object({
	newsletterId: z.string(),
	allowIncoming: z.boolean().describe("Other newsletters may recommend this one. On unless you turn it off."),
	listed: z.boolean().describe("Shown in the directory at /recommendations. Off unless you turn it on."),
});

const UpdatedSchema = z.object({
	id: z.string(),
	side: z.enum(["outgoing", "incoming"]).describe("outgoing: one you make. incoming: one that recommends your newsletter."),
	pitch: z.string(),
	status: z.enum(["active", "pending", "removed"]),
	reason: z.string().nullable(),
	removedBy: z.enum(["recommender", "recommended", "system"]).nullable(),
	...CountsShape,
});

const TotalsSchema = z.object({ impressions: z.number().int(), signups: z.number().int(), confirmed: z.number().int() });

function toSettings(newsletter) {
	return {
		newsletterId: String(newsletter._id),
		allowIncoming: newsletter.recommendations?.allowIncoming !== false,
		listed: Boolean(newsletter.recommendations?.listed),
	};
}

function toUpdated(side, { id, pitch, status, reason, removedBy, impressions, signups, confirmed }) {
	return { id, side, pitch, status, reason, removedBy, impressions, signups, confirmed };
}

function toOutgoing(item) {
	return { ...item, createdAt: toIso(item.createdAt) };
}

const listRecommendations = defineAction({
	name: "list_recommendations",
	tryWithoutPlan: true,
	title: "List recommendations",
	group: GROUP,
	description: `Lists a newsletter's recommendations: the newsletters it recommends to its readers (up to ${MAX_RECOMMENDATIONS}, with where each stands and the reason when it isn't showing) and the ones that recommend it, with the pitch they wrote and the subscribers it brought, plus its two settings. ${REGION_RULE}`,
	http: { method: "GET", path: "/recommendations" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: z.object({
		settings: SettingsSchema,
		limit: z.number().int().describe("How many newsletters one newsletter can recommend"),
		outgoing: z.array(OutgoingSchema).describe("Newsletters this one recommends, in the order readers see them"),
		incoming: z.array(IncomingSchema).describe("Newsletters that recommend this one, newest first"),
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, settingsFields);
		const [outgoing, incoming] = await Promise.all([listOutgoing(newsletter), listIncoming(newsletter)]);
		return {
			settings: toSettings(newsletter),
			limit: MAX_RECOMMENDATIONS,
			outgoing: outgoing.map(toOutgoing),
			incoming: incoming.map(toOutgoing),
		};
	},
});

const getRecommendationStats = defineAction({
	name: "get_recommendation_stats",
	tryWithoutPlan: true,
	title: "Get recommendation stats",
	group: GROUP,
	description:
		"Gets what a newsletter's recommendations did: how many pages showed the ones it makes, how many new contacts and confirmed contacts they brought to the newsletters it recommends, and how many new contacts and confirmed contacts the newsletters that recommend it brought to it. No reader is identified; each count comes from the recommendation that was shown or followed.",
	http: { method: "GET", path: "/recommendations/stats" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: z.object({
		given: TotalsSchema.describe("Across the newsletters this one recommends"),
		received: TotalsSchema.describe("Across the newsletters that recommend this one"),
		outgoing: z.array(z.object({ id: z.string(), newsletter: z.string().nullable().describe("The recommended newsletter's slug"), ...CountsShape })),
		incoming: z.array(z.object({ id: z.string(), recommender: z.string().describe("The recommending newsletter's slug"), ...CountsShape })),
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, settingsFields);
		const [outgoing, incoming] = await Promise.all([listOutgoing(newsletter), listIncoming(newsletter)]);
		return {
			given: sumStats(outgoing),
			received: sumStats(incoming),
			outgoing: outgoing.map(({ id, newsletter: other, impressions, signups, confirmed }) => ({ id, newsletter: other?.slug ?? null, impressions, signups, confirmed })),
			incoming: incoming.map(({ id, recommender, impressions, signups, confirmed }) => ({ id, recommender: recommender.slug, impressions, signups, confirmed })),
		};
	},
});

const searchRecommendable = defineAction({
	name: "search_recommendable_newsletters",
	tryWithoutPlan: true,
	title: "Search recommendable newsletters",
	group: GROUP,
	description: `Searches the directory of newsletters that listed themselves, take recommendations and can take a signup now, by name or description, ${SEARCH_PAGE} a page, never your own. It shows each one's name, description, website and a range of subscribers ("1,000 to 5,000"), not an exact number. ${REGION_RULE} Add one with add_recommendation.`,
	http: { method: "GET", path: "/recommendations/search" },
	readOnly: true,
	rateLimit: { limit: 120, window: "1 h" },
	limitDashboard: true,
	example: { query: "garden" },
	input: z.object({
		query: z.string().trim().max(100).optional().describe("Words from the name or description. Default: every listed newsletter, by name."),
		page: z.number().int().min(1).max(100).optional().describe("Page number, from 1"),
	}),
	output: z.object({
		newsletters: z.array(
			z.object({
				slug: z.string().describe("What add_recommendation takes"),
				name: z.string(),
				description: z.string(),
				imageUrl: z.string().nullable(),
				subscriberRange: z.string(),
				url: z.string().describe("Its website"),
			})
		),
		hasMore: z.boolean(),
	}),
	handler: async ({ account, input }) => {
		const { newsletters, hasMore } = await searchListedNewsletters({ query: input.query, page: input.page ?? 1, pageSize: SEARCH_PAGE, excludeAccount: account._id });
		return { newsletters: newsletters.map(({ id, ...rest }) => rest), hasMore };
	},
});

const setRecommendationSettings = defineAction({
	name: "set_recommendation_settings",
	tryWithoutPlan: true,
	title: "Set recommendation settings",
	group: GROUP,
	description:
		"Sets whether other newsletters may recommend this one and whether it is listed in the directory at /recommendations. Send only what changes. Turning incoming recommendations off takes effect at once: the newsletters that recommend it keep their record, marked pending with that reason, and readers stop seeing it. Listing needs the website on and incoming recommendations allowed, and is off by default.",
	http: { method: "PATCH", path: "/recommendations/settings" },
	idempotent: true,
	example: { allowIncoming: true, listed: true },
	input: z.object({
		newsletter: newsletterInput,
		allowIncoming: z.boolean().optional().describe("Other newsletters may recommend this one"),
		listed: z.boolean().optional().describe("Show this newsletter in the directory"),
	}),
	output: SettingsSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, settingsFields);
		return toSettings(await saveSettings({ account, newsletter, allowIncoming: input.allowIncoming, listed: input.listed }));
	},
});

const addRecommendationAction = defineAction({
	name: "add_recommendation",
	tryWithoutPlan: true,
	title: "Recommend a newsletter",
	group: GROUP,
	description: `Makes a newsletter recommend another one, by slug, with a pitch in its own words (${MAX_PITCH_LENGTH} characters at most, plain text). Up to ${MAX_RECOMMENDATIONS} per newsletter. Readers see it on a "You might also like" step after they subscribe or confirm, on the website, and wherever an issue has ${RECOMMENDATIONS_TAG}. A reader's email goes to a recommended newsletter only when that reader ticks it and presses Subscribe, and that newsletter then asks them to confirm. Refused with the reason when the other newsletter is yours, turned off recommendations, doesn't confirm signups, has its website off or unsent, can't take subscribers right now or sends from an unverified address. There is no payment either way. ${REGION_RULE}`,
	http: { method: "POST", path: "/recommendations", status: 201 },
	rateLimit: { limit: 30, window: "1 h" },
	limitDashboard: true,
	example: { slug: "weekly-fox", pitch: "A short Friday read on trail running, written by people who run." },
	input: z.object({
		newsletter: newsletterInput.describe("The newsletter that recommends. Default: the account's first newsletter."),
		slug: z.string().trim().min(1).max(40).describe("The slug of the newsletter to recommend, in this region"),
		pitch: z.string().max(400).describe(`Why readers would like it, in your words: plain text, ${MAX_PITCH_LENGTH} characters at most, no links`),
	}),
	output: OutgoingSchema,
	handler: async ({ account, input }) => {
		const recommender = await findNewsletter(account, input.newsletter, settingsFields);
		return toOutgoing(await addRecommendation({ account, recommender, slug: input.slug, pitch: input.pitch }));
	},
});

const updateRecommendationAction = defineAction({
	name: "update_recommendation",
	tryWithoutPlan: true,
	title: "Update a recommendation",
	group: GROUP,
	description:
		"Changes a recommendation you make (its pitch or its place in the order), or, for one that recommends your newsletter, declines it with a reason the recommender reads, or brings back one you declined. A declined recommendation stops showing at once, and the recommender sees the reason on their page; they can't add your newsletter again until you bring it back.",
	http: { method: "PATCH", path: "/recommendations/{id}" },
	idempotent: true,
	rateLimit: { limit: 60, window: "1 h" },
	limitDashboard: true,
	example: { pitch: "A short Friday read on trail running." },
	input: z.object({
		id: z.string().trim().min(1).max(100).describe("The recommendation's ID, from list_recommendations"),
		newsletter: newsletterInput.describe("The newsletter the recommendation belongs to: the one that recommends, or the one recommended. Default: the account's first newsletter."),
		pitch: z.string().max(400).optional().describe(`New pitch, for a recommendation you make: plain text, ${MAX_PITCH_LENGTH} characters at most`),
		position: z.number().int().min(0).max(MAX_RECOMMENDATIONS).optional().describe("New place in the order, for a recommendation you make; lowest first"),
		decision: z.enum(["decline", "restore"]).optional().describe("For a recommendation of your newsletter: decline it, or bring back one you declined"),
		reason: z.string().max(400).optional().describe("With decline: why, 200 characters at most. The recommender reads it."),
	}),
	output: UpdatedSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, settingsFields);
		if (input.decision) {
			if (input.pitch !== undefined || input.position !== undefined) {
				throw actionError("validation_failed", "decision: decline or restore a recommendation of your newsletter on its own, without a pitch or position");
			}
			return toUpdated("incoming", await decideIncoming({ account, newsletter, id: input.id, decision: input.decision, reason: input.reason }));
		}
		return toUpdated("outgoing", await updateRecommendation({ account, recommender: newsletter, id: input.id, pitch: input.pitch, position: input.position }));
	},
});

const removeRecommendationAction = defineAction({
	name: "remove_recommendation",
	tryWithoutPlan: true,
	title: "Remove a recommendation",
	group: GROUP,
	description:
		"Stops a newsletter recommending another. Readers stop seeing it at once. Its record stays as removed, with its pitch and counts, and add_recommendation with the same newsletter brings it back. The other newsletter's subscribers are not touched.",
	http: { method: "DELETE", path: "/recommendations/{id}" },
	destructive: true,
	idempotent: true,
	rateLimit: { limit: 60, window: "1 h" },
	limitDashboard: true,
	input: z.object({
		id: z.string().trim().min(1).max(100).describe("The recommendation's ID, from list_recommendations"),
		newsletter: newsletterInput.describe("The newsletter that recommends. Default: the account's first newsletter."),
	}),
	output: z.object({ id: z.string(), removed: z.literal(true) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, settingsFields);
		await removeRecommendation({ account, recommender: newsletter, id: input.id });
		return { id: input.id, removed: true };
	},
});

// The literal paths first: /recommendations/{id} would take "stats", "search" and "settings" for IDs.
export const recommendationActions = [
	listRecommendations,
	getRecommendationStats,
	searchRecommendable,
	setRecommendationSettings,
	addRecommendationAction,
	updateRecommendationAction,
	removeRecommendationAction,
];
