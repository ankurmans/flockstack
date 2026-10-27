import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, newsletterInput, toId, toIso } from "@/lib/actions/shared";
import { isObjectIdString } from "@/lib/validation";
import { REFERRAL_COUNT_TAG, REFERRAL_LINK_TAG } from "@/lib/referral-tags";
import { MAX_REWARDS, MAX_REWARD_REFERRALS, getReferralSetupProblem, isReferralActive, normalizeRewards } from "@/lib/referral-rules";
import { REJECTION_REASONS, getLeaderboard, getReferralTotals } from "@/lib/referrals";
import { addRewardCodes, getRewardStock, MAX_REFERRAL_CODES, retryRewardBenefits } from "@/lib/referral-benefits";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import ReferralReward from "@/models/ReferralReward";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Referral, { REFERRAL_STATUSES } from "@/models/Referral";

const GROUP = "Referrals";
const MAX_LEADERBOARD = 100;
const LIST_PAGE = 50;

const RewardSchema = z.object({
	id: z.string().describe("Stable: send it back to keep the reward's unlocks when you edit it"),
	referrals: z.number().int().describe("Confirmed referrals needed to unlock it"),
	title: z.string(),
	url: z.string().describe("An https:// link revealed on unlock, or empty"),
	text: z.string().describe("A message revealed on unlock, or empty"),
	kind: z.enum(["message", "code", "gift"]).optional().describe("Shared message by default, exact inventory code, or complimentary paid access"),
	tierId: z.string().optional().describe("Paid tier for a gift"),
	months: z.number().int().optional().describe("Gifted access months, without changing Stripe charges"),
});

const TotalsSchema = z.object({
	credited: z.number().int().describe("Referrals that counted: the new subscriber confirmed"),
	pending: z.number().int().describe("Signed up through a link and haven't confirmed yet"),
	rejected: z.number().int().describe("Never counted: self-referrals, repeats of one inbox or network, floods"),
	referrers: z.number().int().describe("Subscribers with at least one referral"),
});

const SettingsSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean(),
	isActive: z.boolean().describe("Enabled, and the newsletter can count referrals: it confirms signups and has its website on"),
	problem: z.string().nullable().describe("Why referrals can't count yet, when they can't"),
	rewards: z.array(RewardSchema).describe("Lowest number first"),
	mergeTags: z.object({ link: z.string(), count: z.string() }).describe("Put these in an issue: each subscriber's own link and number of referrals"),
	totals: TotalsSchema,
	stock: z.array(z.object({ rewardId: z.string(), available: z.number(), assigned: z.number(), pending: z.number() })).describe("Code inventory and unfulfilled rewards; never raw codes"),
	tiers: z.array(z.object({ id: z.string(), name: z.string() })).describe("Paid tiers available for gifts"),
});

async function toSettings(account, newsletter) {
	const referral = newsletter.referral ?? {};
	return {
		newsletterId: String(newsletter._id),
		enabled: Boolean(referral.enabled),
		isActive: isReferralActive(newsletter),
		problem: getReferralSetupProblem(newsletter),
		rewards: (referral.rewards ?? []).map(({ id, referrals, title, url, text, kind, tierId, months }) => ({ id, referrals, title, url: url ?? "", text: text ?? "", ...(kind && { kind }), ...(tierId && { tierId }), ...(months && { months }) })),
		mergeTags: { link: REFERRAL_LINK_TAG, count: REFERRAL_COUNT_TAG },
		totals: await getReferralTotals(account, newsletter._id),
		stock: await getRewardStock(newsletter),
		tiers: getNewsletterTiers(newsletter).map(({ id, name }) => ({ id, name })),
	};
}

const settingsFields = "accountId name slug requireConfirmation archiveEnabled referral paidTier paidTiers fromEmail";

const getReferralSettings = defineAction({
	name: "get_referral_settings",
	tryWithoutPlan: true,
	title: "Get referral settings",
	group: GROUP,
	description:
		"Gets a newsletter's referral program: whether it is on, its rewards, and how many referrals counted. Every subscriber has a link of their own to your website. A referral counts for the subscriber who shared it once the new subscriber confirms their address, and rewards unlock at the numbers you set.",
	http: { method: "GET", path: "/referrals/settings" },
	readOnly: true,
	input: z.object({ newsletter: newsletterInput }),
	output: SettingsSchema,
	handler: async ({ account, input }) => toSettings(account, await findNewsletter(account, input.newsletter, settingsFields)),
});

const updateReferralSettings = defineAction({
	name: "update_referral_settings",
	tryWithoutPlan: true,
	title: "Update referral settings",
	group: GROUP,
	description: `Turns a newsletter's referral program on or off and sets its rewards. Send only what changes; rewards replaces the whole list. A reward is a title, the number of referrals that unlocks it (1 to ${MAX_REWARD_REFERRALS}) and a link or a message, revealed on the subscriber's referral page and sent in an email through the usual sending path, with its unsubscribe link, counted toward the month's emails. Unique code rewards use exact owner-supplied inventory; gift rewards issue complimentary paid-access months and do not change recurring Stripe charges. The private page shows preparation status until fulfillment. Up to ${MAX_REWARDS} rewards. The program needs the newsletter's confirmation emails and website on: referral links lead to the website's signup form, and a referral counts once the new subscriber confirms. Put ${REFERRAL_LINK_TAG} and ${REFERRAL_COUNT_TAG} in an issue to show each subscriber their link and count.`,
	http: { method: "PATCH", path: "/referrals/settings" },
	idempotent: true,
	example: { enabled: true, rewards: [{ referrals: 3, title: "The field guide", url: "https://example.com/field-guide.pdf" }] },
	input: z.object({
		newsletter: newsletterInput,
		enabled: z.boolean().optional().describe("Turn the program on or off. Off keeps the counts and rewards."),
		rewards: z
			.array(
				z.object({
					id: z.string().max(40).optional().describe("The reward's ID, to keep its unlocks when you change it. Leave it out for a new reward."),
					referrals: z.number().int().describe("Confirmed referrals that unlock it"),
					title: z.string().max(200).describe("What the subscriber gets, 100 characters at most"),
					url: z.string().max(600).optional().describe("An https:// link revealed on unlock, e.g. a file or a page"),
					text: z.string().max(2000).optional().describe("A message revealed on unlock, 1,000 characters at most"),
					kind: z.enum(["message", "code", "gift"]).optional().describe("Shared message by default, unique inventory code, or gifted paid-access months"),
					tierId: z.string().max(80).optional().describe("Existing paid tier for a gift"),
					months: z.number().int().min(1).max(12).optional().describe("Gifted access months; existing Stripe charges continue unchanged"),
				})
			)
			.max(20)
			.optional()
			.describe("The whole list of rewards"),
	}),
	output: SettingsSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, settingsFields);
		const set = {};
		if (input.rewards !== undefined) {
			const { rewards, problem } = normalizeRewards(input.rewards);
			if (problem) throw actionError("validation_failed", problem);
			for (const reward of rewards) {
				if (reward.kind === "gift" && !findTier(getNewsletterTiers(newsletter), reward.tierId)) throw actionError("validation_failed", "Choose an existing paid tier for gifted months.");
				const earned = await ReferralReward.findOne(scoped(account, { newsletterId: newsletter._id, rewardId: reward.id })).select({ benefit: 1 }).lean();
				const previous = earned?.benefit ?? newsletter.referral?.rewards?.find((r) => r.id === reward.id);
				if (previous && JSON.stringify([previous.kind ?? "message", previous.tierId, previous.months]) !== JSON.stringify([reward.kind ?? "message", reward.tierId, reward.months]) && earned) throw actionError("conflict", "This reward has already been earned. Add a new reward to change its benefit.");
			}
			set["referral.rewards"] = rewards;
		}
		if (input.enabled !== undefined) {
			const problem = input.enabled && getReferralSetupProblem(newsletter);
			if (problem) throw actionError("validation_failed", problem);
			set["referral.enabled"] = input.enabled;
		}
		if (Object.keys(set).length > 0) await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: set });
		return toSettings(account, await Newsletter.findOne(scoped(account, { _id: newsletter._id })).lean());
	},
});

const ReferralSchema = z.object({
	id: z.string(),
	status: z.enum(REFERRAL_STATUSES),
	reason: z.string().nullable().describe("Why it never counted, for a rejected referral"),
	referrer: z.object({ id: z.string(), email: z.string().nullable() }),
	referred: z.object({ id: z.string(), email: z.string().nullable(), status: z.string().nullable() }),
	createdAt: dateOutput,
	creditedAt: dateOutput,
});

const listReferrals = defineAction({
	name: "list_referrals",
	tryWithoutPlan: true,
	title: "List referrals",
	group: GROUP,
	description: `Lists a newsletter's referrals, newest first, ${LIST_PAGE} a page: who referred whom, and whether it counted. A referral is pending until the new subscriber confirms, credited once it counts, and rejected when it never will: a self-referral, a repeat of one inbox or network, a flood, an address that can't be emailed. Pass nextCursor back as cursor for the next page.`,
	http: { method: "GET", path: "/referrals" },
	readOnly: true,
	example: { status: "rejected" },
	input: z.object({
		newsletter: newsletterInput,
		status: z.enum(REFERRAL_STATUSES).optional().describe("Only referrals with this status"),
		referrer: z.string().trim().min(1).max(100).optional().describe("Only this subscriber's referrals: their contact ID"),
		limit: z.number().int().min(1).max(100).optional().describe(`Referrals per page, ${LIST_PAGE} by default, 100 at most`),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		referrals: z.array(ReferralSchema),
		nextCursor: z.string().nullable().describe("null on the last page"),
		totals: TotalsSchema,
	}),
	handler: async ({ account, input }) => {
		if (input.referrer && !isObjectIdString(input.referrer)) throw actionError("validation_failed", "referrer: use a contact's ID");
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const limit = input.limit ?? LIST_PAGE;
		const filter = scoped(account, {
			newsletterId: newsletter._id,
			...(input.status && { status: input.status }),
			...(input.referrer && { referrerId: input.referrer }),
			...(input.cursor && afterCursor(input.cursor, "createdAt")),
		});
		const found = await Referral.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
		const page = found.slice(0, limit);
		const contacts = await Contact.find(scoped(account, { _id: { $in: page.flatMap(({ referrerId, referredId }) => [referrerId, referredId]) } }))
			.select({ email: 1, status: 1 })
			.lean();
		const byId = new Map(contacts.map((contact) => [String(contact._id), contact]));
		const last = page.at(-1);
		return {
			referrals: page.map((item) => ({
				id: String(item._id),
				status: item.status,
				reason: item.reason ? (REJECTION_REASONS[item.reason] ?? item.reason) : null,
				referrer: { id: toId(item.referrerId), email: byId.get(String(item.referrerId))?.email ?? null },
				referred: { id: toId(item.referredId), email: byId.get(String(item.referredId))?.email ?? null, status: byId.get(String(item.referredId))?.status ?? null },
				createdAt: toIso(item.createdAt),
				creditedAt: toIso(item.creditedAt),
			})),
			nextCursor: found.length > limit ? encodeCursor(last.createdAt, last._id) : null,
			totals: await getReferralTotals(account, newsletter._id),
		};
	},
});

const getReferralLeaderboard = defineAction({
	name: "get_referral_leaderboard",
	tryWithoutPlan: true,
	title: "Get the referral leaderboard",
	group: GROUP,
	description: "Lists the subscribers with the most confirmed referrals, most first, with how many each brought in.",
	http: { method: "GET", path: "/referrals/leaderboard" },
	readOnly: true,
	input: z.object({
		newsletter: newsletterInput,
		limit: z.number().int().min(1).max(MAX_LEADERBOARD).optional().describe(`How many subscribers, 25 by default, ${MAX_LEADERBOARD} at most`),
	}),
	output: z.object({
		referrers: z.array(z.object({ id: z.string(), email: z.string(), status: z.string(), referrals: z.number().int() })),
		totals: TotalsSchema,
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const [referrers, totals] = await Promise.all([getLeaderboard(account, newsletter._id, input.limit ?? 25), getReferralTotals(account, newsletter._id)]);
		return {
			referrers: referrers.map((contact) => ({ id: String(contact._id), email: contact.email, status: contact.status, referrals: contact.referral?.count ?? 0 })),
			totals,
		};
	},
});

const addReferralCodes = defineAction({
	name: "add_referral_codes",
	title: "Add referral reward codes",
	group: GROUP,
	description: `Adds exact unique codes to a code reward's private inventory, up to ${MAX_REFERRAL_CODES} per call. Duplicate codes in the same newsletter are ignored, including codes already assigned to another reward. Case is preserved. This does not create or validate coupons at a vendor, assign codes, send mail, or change billing. Run fulfill_referral_rewards after restocking pending rewards.`,
	http: { method: "POST", path: "/referrals/codes" },
	idempotent: true,
	input: z.object({ newsletter: newsletterInput, rewardId: z.string().regex(/^[a-f0-9]{12}$/).describe("Saved code reward ID"), codes: z.array(z.string().min(1).max(200)).min(1).max(MAX_REFERRAL_CODES).describe("Exact codes, one value per code; no outer spaces or control characters") }),
	output: z.object({ added: z.number().int(), duplicates: z.number().int() }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, settingsFields);
		if (!newsletter.referral?.rewards?.some((r) => r.id === input.rewardId && r.kind === "code") && !await ReferralReward.exists(scoped(account, { newsletterId: newsletter._id, rewardId: input.rewardId, "benefit.kind": "code" }))) throw actionError("not_found", "Code reward not found.");
		try { return await addRewardCodes({ newsletter, rewardId: input.rewardId, codes: input.codes }); }
		catch (error) { if (error.message?.startsWith("Use exact codes")) throw actionError("validation_failed", error.message); throw error; }
	},
});

const fulfillReferralRewards = defineAction({
	name: "fulfill_referral_rewards",
	title: "Fulfill referral rewards",
	group: GROUP,
	description: "Retries up to 25 already-earned pending rewards. Assigns one private inventory code or creates one complimentary gift per receipt. Only active subscribers qualify. Does not send emails, enroll readers or change Stripe billing. Pass nextCursor as cursor for the next batch; null ends this pass. Codes without stock and gifts with a removed tier remain pending. Reads never fulfill rewards.",
	http: { method: "POST", path: "/referrals/fulfill" },
	idempotent: true,
	input: z.object({ newsletter: newsletterInput, cursor: z.string().regex(/^[a-f0-9]{24}$/).optional().describe("nextCursor from the previous fulfillment batch") }),
	output: z.object({ checked: z.number().int(), ready: z.number().int(), nextCursor: z.string().nullable() }),
	handler: async ({ account, input }) => retryRewardBenefits({ newsletter: await findNewsletter(account, input.newsletter, settingsFields), after: input.cursor }),
});

export const referralActions = [getReferralSettings, updateReferralSettings, listReferrals, getReferralLeaderboard, addReferralCodes, fulfillReferralRewards];
