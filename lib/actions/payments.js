import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { findOwnerEmail } from "@/lib/accounts";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter } from "@/lib/actions/shared";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { CURRENCIES, MAX_PRICE_CENTS, MIN_PRICE_CENTS } from "@/lib/payments/config";
import { assertPaymentsReady, createConnectOnboarding, getPaymentsState, refreshPaymentsStatus } from "@/lib/payments/connect";
import { StripeError } from "@/lib/payments/stripe-api";
import { revalidateShop } from "@/lib/products";
import { audienceTierFilter } from "@/lib/tiers";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

const GROUP = "Payments";
const TIER_GROUP = "Paid subscriptions";
const NO_CUT = "FlockStack takes no cut of what you earn: your readers pay your own Stripe account, and only Stripe's own processing fee comes off.";
const MAX_TRIAL_DAYS = 90;

const PaymentsStatusSchema = z.object({
	mode: z
		.enum(["connect", "direct", "none"])
		.describe("connect: FlockStack Cloud, where each account connects its own Stripe account. direct: a self-hosted server that charges with its owner's Stripe key. none: payments aren't set up on this server."),
	ready: z.boolean().describe("A sale can be charged now: products can go on sale and the paid tier can be turned on"),
	connected: z.boolean().describe("A Stripe account is connected (always true on a self-hosted server with a key)"),
	chargesEnabled: z.boolean(),
	payoutsEnabled: z.boolean(),
	detailsSubmitted: z.boolean().describe("The account owner finished Stripe's onboarding form"),
	stripeAccountId: z.string().nullable().describe("The connected Stripe account, null where there is none"),
	problem: z.string().nullable().describe("What is missing before a sale can be charged, null when ready"),
	platformFeePercent: z.literal(0).describe("FlockStack's share of every sale: always 0"),
});

function toPaymentsStatus(account) {
	const state = getPaymentsState(account);
	return {
		mode: state.mode,
		ready: state.ready,
		connected: state.connected,
		chargesEnabled: state.chargesEnabled,
		payoutsEnabled: state.payoutsEnabled,
		detailsSubmitted: state.detailsSubmitted,
		stripeAccountId: state.stripeAccountId,
		problem: state.problem,
		platformFeePercent: 0,
	};
}

const PaidTierSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean().describe("Readers can subscribe: the newsletter's /subscribe page is open"),
	currency: z.string(),
	monthlyCents: z.number().int().describe("0: no monthly plan"),
	yearlyCents: z.number().int().describe("0: no yearly plan"),
	trialDays: z.number().int().describe("Free trial days before the first charge, 0 for none"),
	pitch: z.string().describe("The line on the subscribe page and the shop"),
	subscribeUrl: z.string().nullable().describe("The page where readers subscribe, once the tier is on and the archive is"),
	paidSubscribers: z.number().int().describe("Active contacts who are paid now"),
});

async function toPaidTier(account, newsletter) {
	const tier = newsletter.paidTier ?? {};
	return {
		newsletterId: String(newsletter._id),
		enabled: Boolean(tier.enabled),
		currency: tier.currency ?? "usd",
		monthlyCents: tier.monthlyCents ?? 0,
		yearlyCents: tier.yearlyCents ?? 0,
		trialDays: tier.trialDays ?? 0,
		pitch: tier.pitch ?? "",
		subscribeUrl: tier.enabled && newsletter.archiveEnabled ? getArchiveUrls(newsletter).absoluteSubscribe : null,
		paidSubscribers: await Contact.countDocuments(scoped(account, { newsletterId: newsletter._id, status: "active", ...audienceTierFilter("paid") })),
	};
}

const getPaymentsStatus = defineAction({
	name: "get_payments_status",
	title: "Get the payments status",
	group: GROUP,
	description: `Whether the account can take payments for products and paid subscriptions: on FlockStack Cloud, whether its connected Stripe account can take charges; on a self-hosted server, whether Stripe is set up. refresh asks Stripe for the account's latest status. ${NO_CUT}`,
	http: { method: "GET", path: "/payments" },
	readOnly: true,
	openWorld: true,
	example: { refresh: true },
	input: z.object({ refresh: z.boolean().optional().describe("Ask Stripe again, e.g. after the account owner finished onboarding. Default: false.") }),
	output: PaymentsStatusSchema,
	handler: async ({ account, input }) => {
		if (!input.refresh) return toPaymentsStatus(account);
		try {
			return toPaymentsStatus(await refreshPaymentsStatus(account));
		} catch (error) {
			if (!(error instanceof StripeError)) throw error;
			console.error("[payments] The status check failed:", error.message);
			throw actionError("unavailable", "Stripe can't be reached right now. Try again in a minute.");
		}
	},
});

const connectPayments = defineAction({
	name: "connect_payments",
	title: "Connect a Stripe account",
	group: GROUP,
	description: `Returns Stripe's own page where the account owner connects their Stripe account, or finishes connecting it: the account is created in their name, so they keep their money, refunds and disputes in their own Stripe dashboard. Nothing is connected until they finish there; get_payments_status shows when it is. Give the URL to the user. A self-hosted server answers conflict: it charges with its owner's own Stripe key. ${NO_CUT}`,
	http: { method: "POST", path: "/payments/connect" },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	output: z.object({ url: z.string().describe("Stripe's onboarding page. It expires in minutes: ask again for a new one.") }),
	handler: async ({ account, user }) => {
		const state = getPaymentsState(account);
		if (state.mode === "none") throw actionError("unavailable", state.problem);
		if (state.mode === "direct") throw actionError("conflict", "This server charges with its owner's own Stripe key: there is nothing to connect");
		try {
			const email = user?.email ?? (await findOwnerEmail(account._id));
			return { url: (await createConnectOnboarding({ account, email })).url };
		} catch (error) {
			if (!(error instanceof StripeError)) throw error;
			console.error("[payments] Connecting a Stripe account failed:", error.message);
			throw actionError("unavailable", "Stripe can't be reached right now. Try again in a minute.");
		}
	},
});

const getPaidTier = defineAction({
	name: "get_paid_tier",
	title: "Get a newsletter's paid tier",
	group: TIER_GROUP,
	description: "Gets the paid tier of a newsletter: whether readers can subscribe, its prices, its free trial and how many paid subscribers it has.",
	http: { method: "GET", path: "/newsletters/{id}/paid-tier" },
	readOnly: true,
	input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
	output: PaidTierSchema,
	handler: async ({ account, input }) => toPaidTier(account, await findNewsletter(account, input.id)),
});

const priceInput = z
	.number()
	.int()
	.min(0)
	.max(MAX_PRICE_CENTS)
	.describe(`The price in the currency's smallest unit, e.g. 800 for $8.00; at least ${MIN_PRICE_CENTS}, or 0 to not offer the plan`);

const setPaidTier = defineAction({
	name: "set_paid_tier",
	title: "Set a newsletter's paid tier",
	group: TIER_GROUP,
	description: `Turns a newsletter's paid tier on or off and sets its prices. With it on, readers subscribe monthly or yearly on the newsletter's /subscribe page through Stripe Checkout, pay your own Stripe account, and become paid contacts: campaigns can then go to paid readers only (audience paid), with a teaser on the web and the full issue by email, and paid readers get a manage-subscription link in every email. Send only the fields to change. Prices apply to new subscribers; people already subscribed keep what they pay. Turning it off closes the page to new subscribers but doesn't cancel anyone: end subscriptions in Stripe. ${NO_CUT}`,
	http: { method: "PATCH", path: "/newsletters/{id}/paid-tier" },
	idempotent: true,
	example: { enabled: true, monthlyCents: 800, yearlyCents: 8000, trialDays: 7 },
	input: z.object({
		id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug"),
		enabled: z.boolean().optional().describe("Open the paid tier to new subscribers. Needs a price and a Stripe account that can take payments (get_payments_status)."),
		monthlyCents: priceInput.optional(),
		yearlyCents: priceInput.optional().describe(`The yearly price in the currency's smallest unit, e.g. 8000 for $80.00; at least ${MIN_PRICE_CENTS}, or 0 to not offer the plan`),
		currency: z.enum(CURRENCIES).optional().describe(`The currency of both prices: ${CURRENCIES.join(", ")}. Default: usd.`),
		trialDays: z.number().int().min(0).max(MAX_TRIAL_DAYS).optional().describe(`Free trial days before a new subscriber's first charge, ${MAX_TRIAL_DAYS} at most; 0 for none`),
		pitch: z.string().trim().max(300).optional().describe("A line or two on why to subscribe, shown on the subscribe page and the shop. 300 characters at most."),
	}),
	output: PaidTierSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const current = newsletter.paidTier ?? {};
		const next = {
			enabled: input.enabled ?? Boolean(current.enabled),
			currency: input.currency ?? current.currency ?? "usd",
			monthlyCents: input.monthlyCents ?? current.monthlyCents ?? 0,
			yearlyCents: input.yearlyCents ?? current.yearlyCents ?? 0,
			trialDays: input.trialDays ?? current.trialDays ?? 0,
			pitch: input.pitch ?? current.pitch ?? "",
		};
		for (const [name, cents] of [["monthlyCents", next.monthlyCents], ["yearlyCents", next.yearlyCents]]) {
			if (cents > 0 && cents < MIN_PRICE_CENTS) throw actionError("validation_failed", `${name}: at least ${MIN_PRICE_CENTS}, or 0 to not offer the plan`);
		}
		if (next.enabled) {
			if (next.monthlyCents === 0 && next.yearlyCents === 0) throw actionError("validation_failed", "enabled: set a monthly or a yearly price first");
			if (!current.enabled) assertPaymentsReady(account);
		}
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { paidTier: next } });
		revalidateShop();
		return toPaidTier(account, { ...newsletter, paidTier: next });
	},
});

export const paymentActions = [getPaymentsStatus, connectPayments, getPaidTier, setPaidTier];
