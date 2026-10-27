import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, toIso } from "@/lib/actions/shared";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { countRedemptions, createCoupon, deleteCoupon, findOfferByCode } from "@/lib/offers";
import { MAX_OFFERS_PER_NEWSLETTER, OFFER_CODE_PATTERN, describeOffer, getOfferProblem } from "@/lib/offer-rules";
import { MAX_PRICE_CENTS, formatPrice } from "@/lib/payments/config";
import { assertPaymentsReady } from "@/lib/payments/connect";
import { StripeError } from "@/lib/payments/stripe-api";
import { revalidateShop } from "@/lib/products";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { audienceTierFilter, isPaidContact } from "@/lib/tiers";
import { isObjectIdString } from "@/lib/validation";
import { getPaidTrialProblem, getTrialMinimumCents, MAX_TRIAL_DAYS } from "@/lib/paid-trial-rules";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Offer, { OFFER_DURATIONS, OFFER_TYPES } from "@/models/Offer";

const GROUP = "Offers";
const NO_CUT = "FlockStack takes no cut of what you earn: readers pay your own Stripe account, and only Stripe's own processing fee comes off.";
const newsletterId = z.string().trim().min(1).max(100).describe("The newsletter's ID or slug");

const OfferSchema = z.object({
	id: z.string(),
	name: z.string(),
	code: z.string().describe("In the offer's link"),
	url: z.string().nullable().describe("The offer's link, once the newsletter's website is on: the subscribe page with the offer applied and the discounted price shown"),
	type: z.enum(OFFER_TYPES).describe("percent and amount are discounts (a coupon on your Stripe account); trial is a free trial or a one-time trial access fee for the link's visitors only"),
	summary: z.string().describe("The offer in words, e.g. 20% off for 3 months"),
	percentOff: z.number().nullable(),
	amountOffCents: z.number().int().nullable(),
	currency: z.string().nullable(),
	duration: z.enum(OFFER_DURATIONS).nullable().describe("once: the first payment. repeating: durationMonths months. forever: every payment."),
	durationMonths: z.number().int().nullable(),
	maxRedemptions: z.number().int().nullable(),
	expiresAt: dateOutput,
	tiers: z.array(z.string()).describe("The tiers it applies to, by ID; empty for every tier"),
	trialDays: z.number().int().nullable(),
	trialNoCard: z.boolean().nullable(),
	trialAmountCents: z.number().int().optional().describe("A one-time charge for trial access, in the offer currency; absent is free"),
	active: z.boolean(),
	status: z.enum(["live", "inactive", "ended", "used_up"]).describe("live: the link works. inactive: switched off. ended: past its expiry. used_up: its redemption limit was reached."),
	redemptions: z.number().int().describe("Readers who signed up through it"),
	payingNow: z.number().int().describe("Of those, who are paid readers now"),
	stripeCouponId: z.string().nullable(),
});

async function toOffer(account, newsletter, offer) {
	const redemptions = await countRedemptions(account, offer);
	const paying = await Contact.countDocuments(scoped(account, { newsletterId: offer.newsletterId, offerId: String(offer._id), status: "active", ...audienceTierFilter("paid") }));
	const currency = newsletter.paidTier?.currency || "usd";
	const wrongCurrency = (offer.type === "amount" || offer.trialAmountCents > 0) && offer.currency !== currency;
	const problem = getOfferProblem(offer, { redemptions, currency });
	const status = problem === null ? "live" : !offer.active ? "inactive" : (wrongCurrency || getPaidTrialProblem(offer) || (offer.expiresAt && new Date(offer.expiresAt).getTime() <= Date.now())) ? "ended" : "used_up";
	return {
		id: String(offer._id),
		name: offer.name,
		code: offer.code,
		url: newsletter.archiveEnabled ? getArchiveUrls(newsletter).absoluteOffer(offer.code) : null,
		type: offer.type,
		summary: describeOffer(offer, formatPrice),
		percentOff: offer.percentOff ?? null,
		amountOffCents: offer.amountOffCents ?? null,
		currency: offer.currency ?? null,
		duration: offer.duration ?? null,
		durationMonths: offer.durationMonths ?? null,
		maxRedemptions: offer.maxRedemptions ?? null,
		expiresAt: toIso(offer.expiresAt),
		tiers: offer.tierIds ?? [],
		trialDays: offer.trialDays ?? null,
		trialNoCard: offer.trialNoCard ?? null,
		...(offer.trialAmountCents > 0 && { trialAmountCents: offer.trialAmountCents }),
		active: offer.active !== false,
		status,
		redemptions,
		payingNow: paying,
		stripeCouponId: offer.stripeCouponId ?? null,
	};
}

function slugifyCode(name) {
	return String(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

function readTierIds(newsletter, references) {
	if (!references?.length) return undefined;
	const tiers = getNewsletterTiers(newsletter);
	return [
		...new Set(
			references.map((reference) => {
				const wanted = reference.toLowerCase();
				const tier = findTier(tiers, wanted) ?? tiers.find((candidate) => candidate.name.toLowerCase() === wanted);
				if (!tier) throw actionError("validation_failed", `tiers: the newsletter has no paid tier ${JSON.stringify(reference)}`);
				return tier.id;
			})
		),
	];
}

const createOffer = defineAction({
	name: "create_offer",
	title: "Create an offer",
	group: GROUP,
	description: `Makes an offer for a newsletter's paid tiers: a discount (percent or fixed amount, once, for some months or forever, with an optional redemption limit and expiry) made as a coupon on your own Stripe account, or a trial with an optional one-time upfront charge. Paid trials require a card, an enabled paid tier and ready payments; their recurring price begins after the trial. Every offer has a link, <your site>/offer/<code>, that shows the discounted price and applies it at Checkout. A trial can ask for no card until it ends. Its terms can't change afterwards, as a Stripe coupon's can't: make another offer instead. Needs a Stripe account that can take payments (discounts) and a paid tier. ${NO_CUT}`,
	http: { method: "POST", path: "/newsletters/{id}/offers", status: 201 },
	openWorld: true,
	limitDashboard: false,
	example: { name: "Launch week", type: "percent", percentOff: 20, duration: "repeating", durationMonths: 3, maxRedemptions: 100 },
	input: z.object({
		id: newsletterId,
		name: z.string().trim().min(1).max(60).describe("What the offer is called, shown to readers on Stripe's page, 60 characters at most"),
		code: z.string().trim().toLowerCase().max(40).optional().describe("In the offer's link: lowercase letters, digits and dashes, 3 to 40 characters. Default: made from the name."),
		type: z.enum(OFFER_TYPES).describe("percent: a percentage off. amount: a fixed amount off, in the newsletter's currency. trial: a free trial, or a one-time trial charge with trialAmountCents."),
		percentOff: z.number().min(1).max(100).optional().describe("With percent: how much comes off, 1 to 100"),
		amountOffCents: z.number().int().min(1).max(MAX_PRICE_CENTS).optional().describe("With amount: how much comes off, in the currency's smallest unit"),
		duration: z.enum(OFFER_DURATIONS).optional().describe("With a discount: once (the first payment, the default), repeating (durationMonths months) or forever"),
		durationMonths: z.number().int().min(1).max(36).optional().describe("With duration repeating: how many months"),
		maxRedemptions: z.number().int().min(1).max(1_000_000).optional().describe("Stop after this many readers take it"),
		expiresAt: z.string().max(40).optional().describe("ISO 8601 date and time after which the offer can't be taken, e.g. 2026-12-31T23:59:59Z"),
		tiers: z.array(z.string().trim().min(1).max(100)).max(3).optional().describe("Only for these tiers: IDs or names. Default: every tier."),
		trialDays: z.number().int().min(1).max(MAX_TRIAL_DAYS).optional().describe(`A trial of this many days for readers who take the offer, ${MAX_TRIAL_DAYS} at most. Needed for the trial type.`),
		trialAmountCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional().describe("With type trial and trialDays: a one-time upfront access charge in minor units. Zero or omitted is free. Currency is frozen from the newsletter. Paid trials require a card and a currency-dependent minimum; no discount or promotion code applies to this fee."),
		trialNoCard: z.boolean().optional().describe("With a trial: ask for no card until it ends, when Stripe asks for one. Default: the newsletter's setting."),
	}),
	output: OfferSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const isDiscount = input.type === "percent" || input.type === "amount";
		const isPaidTrial = input.trialAmountCents > 0;
		if (isPaidTrial) {
			if (input.type !== "trial" || !input.trialDays || input.trialNoCard === true) throw actionError("validation_failed", "A paid trial needs type trial, trialDays and a card. It cannot be combined with a discount.");
			if (!newsletter.paidTier?.enabled) throw actionError("validation_failed", "Enable the paid tier before creating a paid trial.");
			const minimum = getTrialMinimumCents(newsletter.paidTier?.currency || "usd");
			if (input.trialAmountCents < minimum) throw actionError("validation_failed", `trialAmountCents: use at least ${minimum} minor units in this currency. Stripe may require more when settlement involves conversion.`);
			assertPaymentsReady(account);
		}
		if (isDiscount) assertPaymentsReady(account);
		if (input.type === "percent" && !input.percentOff) throw actionError("validation_failed", "percentOff: say how much comes off, 1 to 100");
		if (input.type === "amount" && !input.amountOffCents) throw actionError("validation_failed", "amountOffCents: say how much comes off");
		if (input.type === "trial" && !input.trialDays) throw actionError("validation_failed", "trialDays: a trial offer needs its length");
		if (input.duration === "repeating" && !input.durationMonths) throw actionError("validation_failed", "durationMonths: say how many months");
		if (input.expiresAt && !(new Date(input.expiresAt).getTime() > Date.now())) throw actionError("validation_failed", "expiresAt: use a date and time in the future, e.g. 2026-12-31T23:59:59Z");
		const code = input.code || slugifyCode(input.name);
		if (!OFFER_CODE_PATTERN.test(code)) throw actionError("validation_failed", "code: use lowercase letters, digits and dashes, 3 to 40 characters");
		if ((await Offer.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_OFFERS_PER_NEWSLETTER) throw actionError("conflict", `A newsletter has ${MAX_OFFERS_PER_NEWSLETTER} offers at most: delete one first`);
		if (await findOfferByCode({ ...newsletter, accountId: account._id }, code)) throw actionError("conflict", "Another offer of this newsletter has that code");

		const offer = (
			await Offer.create({
				accountId: account._id,
				newsletterId: newsletter._id,
				name: input.name,
				code,
				type: input.type,
				...(input.type === "percent" && { percentOff: input.percentOff }),
				...(input.type === "amount" && { amountOffCents: input.amountOffCents, currency: newsletter.paidTier?.currency || "usd" }),
				...(isDiscount && { duration: input.duration ?? "once", ...(input.duration === "repeating" && { durationMonths: input.durationMonths }) }),
				...(input.maxRedemptions && { maxRedemptions: input.maxRedemptions }),
				...(input.expiresAt && { expiresAt: new Date(input.expiresAt) }),
				...(readTierIds(newsletter, input.tiers) && { tierIds: readTierIds(newsletter, input.tiers) }),
				...(input.trialDays && { trialDays: input.trialDays }),
				...(isPaidTrial ? { trialAmountCents: input.trialAmountCents, currency: newsletter.paidTier.currency || "usd", trialNoCard: false } : input.trialNoCard !== undefined ? { trialNoCard: input.trialNoCard } : {}),
			})
		).toObject();
		try {
			const couponId = await createCoupon({ account, offer });
			if (couponId) {
				await Offer.updateOne(scoped(account, { _id: offer._id }), { $set: { stripeCouponId: couponId } });
				offer.stripeCouponId = couponId;
			}
		} catch (error) {
			await Offer.deleteOne(scoped(account, { _id: offer._id }));
			if (!(error instanceof StripeError)) throw error;
			console.error("[offers] Stripe didn't take the coupon:", error.message);
			throw actionError("unavailable", error.status === 400 ? `Stripe refused the offer: ${error.message.replace(/^Stripe answered \d+ to [A-Z]+ \S+: /, "")}` : "Stripe can't be reached right now. Try again in a minute.");
		}
		return toOffer(account, newsletter, offer);
	},
});

const listOffers = defineAction({
	name: "list_offers",
	title: "List offers",
	group: GROUP,
	description:
		"Lists a newsletter's offers, newest first, each with its link, its terms and how it is doing: how many readers took it, how many of them are paid readers now, and whether the link still works. Redemptions are counted from the readers who signed up through the link. Also returns the launch banner.",
	http: { method: "GET", path: "/newsletters/{id}/offers" },
	readOnly: true,
	input: z.object({ id: newsletterId }),
	output: z.object({ offers: z.array(OfferSchema), banner: z.object({ enabled: z.boolean(), text: z.string(), offerId: z.string().nullable() }) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const offers = await Offer.find(scoped(account, { newsletterId: newsletter._id })).sort({ createdAt: -1, _id: -1 }).limit(MAX_OFFERS_PER_NEWSLETTER).lean();
		const banner = newsletter.paidTier?.banner ?? {};
		return {
			offers: await Promise.all(offers.map((offer) => toOffer(account, newsletter, offer))),
			banner: { enabled: Boolean(banner.enabled), text: banner.text ?? "", offerId: banner.offerId ?? null },
		};
	},
});

async function findOffer(account, reference) {
	const value = String(reference).trim();
	const offer = isObjectIdString(value) ? await Offer.findOne(scoped(account, { _id: value })).lean() : await Offer.findOne(scoped(account, { code: value.toLowerCase() })).lean();
	if (!offer) throw actionError("not_found", "Offer not found");
	return offer;
}

const getOffer = defineAction({
	name: "get_offer",
	title: "Get an offer",
	group: GROUP,
	description: "Gets one offer by ID or code, with the readers who took it: their email, the tier they hold and whether they are paid now. The first 100, newest first.",
	http: { method: "GET", path: "/offers/{id}" },
	readOnly: true,
	input: z.object({ id: z.string().trim().min(1).max(100).describe("The offer's ID or code") }),
	output: OfferSchema.extend({
		redeemers: z.array(z.object({ email: z.string(), tierId: z.string().nullable(), since: dateOutput, paidNow: z.boolean() })),
	}),
	handler: async ({ account, input }) => {
		const offer = await findOffer(account, input.id);
		const newsletter = await Newsletter.findOne(scoped(account, { _id: offer.newsletterId })).lean();
		const contacts = await Contact.find(scoped(account, { newsletterId: offer.newsletterId, offerId: String(offer._id) }))
			.sort({ paidSince: -1, _id: -1 })
			.limit(100)
			.select({ email: 1, paidTierId: 1, paidSince: 1, tier: 1, paidUntil: 1 })
			.lean();
		return {
			...(await toOffer(account, newsletter, offer)),
			redeemers: contacts.map((contact) => ({ email: contact.email, tierId: contact.paidTierId ?? null, since: toIso(contact.paidSince), paidNow: isPaidContact(contact) })),
		};
	},
});

const updateOffer = defineAction({
	name: "update_offer",
	title: "Change an offer",
	group: GROUP,
	description: "Renames an offer, switches its link on or off, or changes the tiers it applies to. Its discount, duration, limit and expiry can't change (a Stripe coupon's can't): make another offer. Switching it off stops new readers; those who took it keep it.",
	http: { method: "PATCH", path: "/offers/{id}" },
	idempotent: true,
	example: { active: false },
	input: z.object({
		id: z.string().trim().min(1).max(100).describe("The offer's ID or code"),
		name: z.string().trim().min(1).max(60).optional().describe("The new name"),
		active: z.boolean().optional().describe("false switches the link off, true back on"),
		tiers: z.array(z.string().trim().min(1).max(100)).max(3).optional().describe("Only for these tiers (IDs or names); an empty list is every tier"),
	}),
	output: OfferSchema,
	handler: async ({ account, input }) => {
		const offer = await findOffer(account, input.id);
		const newsletter = await Newsletter.findOne(scoped(account, { _id: offer.newsletterId })).lean();
		const set = { ...(input.name && { name: input.name }), ...(input.active !== undefined && { active: input.active }) };
		const tierIds = input.tiers ? readTierIds(newsletter, input.tiers) : undefined;
		if (tierIds) set.tierIds = tierIds;
		const unset = input.tiers && !tierIds ? { tierIds: 1 } : null;
		if (Object.keys(set).length > 0 || unset) await Offer.updateOne(scoped(account, { _id: offer._id }), { ...(Object.keys(set).length > 0 && { $set: set }), ...(unset && { $unset: unset }) });
		revalidateShop();
		return toOffer(account, newsletter, { ...offer, ...set, ...(unset && { tierIds: undefined }) });
	},
});

const deleteOffer = defineAction({
	name: "delete_offer",
	title: "Delete an offer",
	group: GROUP,
	description: "Deletes an offer and its coupon on your Stripe account. Its link stops working. Readers who took it keep their discount: Stripe keeps applying it to their subscriptions. It can't be undone.",
	http: { method: "DELETE", path: "/offers/{id}" },
	destructive: true,
	idempotent: true,
	openWorld: true,
	input: z.object({ id: z.string().trim().min(1).max(100).describe("The offer's ID or code") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const offer = await findOffer(account, input.id);
		await deleteCoupon({ account, offer });
		await Offer.deleteOne(scoped(account, { _id: offer._id }));
		const newsletter = await Newsletter.findOne(scoped(account, { _id: offer.newsletterId })).lean();
		if (newsletter?.paidTier?.banner?.offerId === String(offer._id)) await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { "paidTier.banner.enabled": false }, $unset: { "paidTier.banner.offerId": 1 } });
		revalidateShop();
		return { id: String(offer._id), deleted: true };
	},
});

const setLaunchBanner = defineAction({
	name: "set_launch_banner",
	title: "Set the launch offer banner",
	group: GROUP,
	description:
		"Shows a banner above a newsletter's website while the paid tier is open: a line of text, linking to an offer's page (its discounted price) or to the subscribe page. It hides itself when the offer ends. Send only the fields to change.",
	http: { method: "PATCH", path: "/newsletters/{id}/launch-banner" },
	idempotent: true,
	example: { enabled: true, text: "Launch week: 20% off for 3 months", offer: "launch-week" },
	input: z.object({
		id: newsletterId,
		enabled: z.boolean().optional().describe("Show the banner"),
		text: z.string().trim().min(1).max(120).optional().describe("The banner's line, 120 characters at most"),
		offer: z.string().trim().max(100).nullable().optional().describe("The offer it links to: its ID or code. null links to the subscribe page."),
	}),
	output: z.object({ enabled: z.boolean(), text: z.string(), offerId: z.string().nullable() }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const current = newsletter.paidTier?.banner ?? {};
		const next = { enabled: input.enabled ?? Boolean(current.enabled), text: input.text ?? current.text ?? "", offerId: current.offerId ?? null };
		if (input.offer === null) next.offerId = null;
		else if (input.offer) next.offerId = String((await findOffer(account, input.offer))._id);
		if (next.enabled && !next.text) throw actionError("validation_failed", "enabled: give the banner some text first");
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { "paidTier.banner.enabled": next.enabled, "paidTier.banner.text": next.text, ...(next.offerId && { "paidTier.banner.offerId": next.offerId }) }, ...(!next.offerId && { $unset: { "paidTier.banner.offerId": 1 } }) });
		revalidateShop();
		return next;
	},
});

export const offerActions = [createOffer, listOffers, getOffer, updateOffer, deleteOffer, setLaunchBanner];
