import "server-only";
import * as z from "zod";
import { getAccountStatus, hasActiveSubscription, isPaidStatus } from "@/lib/account-state";
import { findOwnerEmail } from "@/lib/accounts";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { UsageSchema, dateOutput, getUsageOutput, toIso } from "@/lib/actions/shared";
import {
	createCheckoutSession,
	createPortalSession,
	findPlansOnSale,
	getBillingProvider,
	getBillingProviderName,
	hasBillingCustomer,
	isBillingConfigured,
} from "@/lib/billing-provider";
import { isCloud } from "@/lib/config";
import { formatNumber, formatUsdCents } from "@/lib/format";
import { canHaveDedicatedIp, wantsDedicatedIp } from "@/lib/dedicated-ip";
import { describeWarmup } from "@/lib/ip-warmup-rules";
import { countExtraEmails } from "@/lib/extra-emails";
import { getLapsedPlan, showsSentWithLink } from "@/lib/free-plan";
import {
	DEDICATED_IP_PRICE,
	EXTRA_EMAILS,
	INTERVALS,
	PLAN_IDS,
	canSendExtraEmails,
	FREE_PLAN,
	getAccountPlan,
	getDedicatedIpPrice,
	getExtraEmailsCost,
	getExtraEmailsLimit,
	getMaxExtraEmailsLimit,
	getPlan,
	getPrice,
	hasActiveFreePlan,
	isOnFreePlan,
	isOnFreeTier,
} from "@/lib/plans";
import { createDedicatedIpCheckout, isDedicatedIpOnSale } from "@/lib/polar";
import { siteExtensions } from "@/lib/site-extensions";
import Account from "@/models/Account";

const GROUP = "Billing";
const OFF_NOTE = " A self-hosted server has no billing and answers billing_off.";

function assertBillingOn() {
	if (!isCloud()) throw actionError("billing_off", "Billing is off on this server: every account has every feature, without plan limits");
}

function assertBillingProvider() {
	if (!isBillingConfigured()) throw actionError("unavailable", "Billing isn't set up on this server");
}

async function openProvider(open) {
	assertBillingProvider();
	const provider = getBillingProviderName();
	try {
		return await open();
	} catch (error) {
		console.error(`[billing] Couldn't open ${provider}:`, error.message);
		throw actionError("unavailable", `${provider} can't be reached right now. Try again in a minute.`);
	}
}

function getFreePlanOutput(account) {
	if (!hasActiveFreePlan(account)) return null;
	const { id, name } = getPlan(account.comp.plan);
	return { id, name, grantedAt: toIso(account.comp.grantedAt), until: toIso(account.comp.until) };
}

export async function getExtraEmailsOutput(account) {
	const sent = await countExtraEmails(account);
	return {
		available: canSendExtraEmails(account),
		pricePerThousand: EXTRA_EMAILS.pricePerThousand,
		sent,
		limit: getExtraEmailsLimit(account),
		maxLimit: canSendExtraEmails(account) ? getMaxExtraEmailsLimit(account) : 0,
		estimatedCost: getExtraEmailsCost(sent),
	};
}

// off: no IP. waiting: paid, and no IP was free yet, so it's being prepared. warming: the IP is set up and a growing share
// of the email goes through it (warmup). active: the warm-up is done, all of it goes through the IP.
function getDedicatedIpState(account, isOn, warmup) {
	if (isOn) return warmup && !warmup.isDone ? "warming" : "active";
	return wantsDedicatedIp(account) ? "waiting" : "off";
}

export async function getDedicatedIpOutput(account) {
	const plan = getAccountPlan(account);
	const addon = account.dedicatedIp?.polarSubscriptionId ? account.dedicatedIp : null;
	const canBuy = getBillingProvider() === "polar" && canHaveDedicatedIp(account) && !(addon && isPaidStatus(addon.status));
	const isOn = Boolean(account.ses?.dedicatedIpAddress);
	const warmup = isOn ? describeWarmup(account.ses.ipWarmup) : null;
	return {
		isOn,
		state: getDedicatedIpState(account, isOn, warmup),
		address: isOn ? account.ses.dedicatedIpAddress : null,
		warmup,
		available: canBuy && (await isDedicatedIpOnSale()),
		price: getDedicatedIpPrice(plan.id),
		interval: "month",
		subscription: addon
			? { status: addon.status, plan: addon.plan ?? null, interval: addon.interval ?? null, cancelAt: toIso(addon.cancelAt), currentPeriodEnd: toIso(addon.currentPeriodEnd) }
			: null,
	};
}

const PLAN_OR_FREE_IDS = [...PLAN_IDS, FREE_PLAN.id];

const ExtraEmailsSchema = z
	.object({
		available: z.boolean().describe("The plan can send past its emails, billed as extra emails: a paid plan billed by Polar, not a free plan"),
		pricePerThousand: z.number().describe("USD per 1,000 extra emails"),
		sent: z.number().int().describe("Extra emails sent this month: campaign, welcome and automation emails past the plan's emails"),
		limit: z.number().int().describe("The most extra emails this month; sending stops there. 0: none"),
		maxLimit: z.number().int().describe("The highest limit set_extra_emails_limit takes: 10 times the plan's emails"),
		estimatedCost: z.number().describe("USD so far this month, billed with the plan at the end of its period"),
	})
	.describe("Extra emails past the plan's, billed by usage");

const DedicatedIpSchema = z
	.object({
		isOn: z.boolean().describe("The account has a dedicated IP of its own in a pool, warming up or warmed up"),
		state: z
			.enum(["off", "waiting", "warming", "active"])
			.describe("off: none. waiting: paid and the IP is being prepared, usually within 2 business days. warming: set up, and a growing share of the email goes through it. active: all of it does"),
		address: z.string().nullable().describe("The IP address; null until one is set up"),
		warmup: z
			.object({
				day: z.number().int().describe("The warm-up's day, 1 to days"),
				days: z.number().int(),
				share: z.number().describe("Percent of the account's email that goes through the IP; the rest goes through shared IPs"),
				isDone: z.boolean(),
				isHeld: z.boolean().describe("The day is held: bounces or complaints are above the watch level, or too little was sent"),
			})
			.nullable()
			.describe("The IP's warm-up; null without an IP"),
		available: z.boolean().describe("add_dedicated_ip can buy the add-on now: Pro, Scale or Max, billed by Polar"),
		price: z.number().nullable().describe("USD a month, at cost and the same on every plan from Pro up, whatever the plan's interval; null below Pro"),
		interval: z.enum(INTERVALS),
		subscription: z
			.object({
				status: z.string(),
				plan: z.enum(PLAN_IDS).nullable(),
				interval: z.enum(INTERVALS).nullable(),
				cancelAt: dateOutput.describe("When it ends: canceled, or the plan dropped below Pro"),
				currentPeriodEnd: dateOutput,
			})
			.nullable()
			.describe("The add-on's subscription; null without one"),
	})
	.describe("The dedicated IP add-on");

export const billingActions = [
	defineAction({
		name: "get_billing",
		title: "Get the plan and usage",
		group: GROUP,
		description: `The account's plan (Free until it pays for one), subscription status and this month's usage against the plan's limits, the extra emails sent past them with their estimated cost, the dedicated IP add-on, and every plan on sale for comparison. Works without an active plan.${OFF_NOTE}`,
		http: { method: "GET", path: "/billing" },
		readOnly: true,
		requiresPlan: false,
		output: z.object({
			plan: z
				.object({
					id: z.enum(PLAN_OR_FREE_IDS),
					name: z.string(),
					interval: z.enum(INTERVALS),
					price: z.number().describe("USD per interval: 0 on the Free plan and on a free plan from FlockStack"),
				})
				.describe("The plan the account is on: Free (id free) until it pays for one, and again when its plan ends or lapses"),
			status: z.string().describe("active, trialing, past_due, canceled… blocked while the account is blocked, free on the Free plan"),
			isActive: z.boolean().describe("The account can use FlockStack: true on every plan, Free included. False only while it waits to be deleted"),
			lapsedPlan: z.enum(PLAN_IDS).nullable().describe("The paid plan that ended, while the account is on Free after it: its data is kept"),
			sentWithLink: z
				.object({
					shown: z.boolean().describe("The account's emails and websites carry the Sent with FlockStack link"),
					required: z.boolean().describe("The Free plan requires it; set_sent_with_link can't turn it off"),
				})
				.describe("The small Sent with FlockStack link"),
			freePlan: z
				.object({
					id: z.enum(PLAN_IDS),
					name: z.string(),
					grantedAt: dateOutput,
					until: dateOutput.describe("When it ends; null: no end date"),
				})
				.nullable()
				.describe("A plan FlockStack gave the account, without Stripe; null without one. A paid plan takes over while there's one"),
			currentPeriodEnd: dateOutput.describe("The paid period's end; null on Free and on a free plan"),
			cancelAt: dateOutput.describe("When a canceled plan stops"),
			usage: UsageSchema,
			extraEmails: ExtraEmailsSchema,
			dedicatedIp: DedicatedIpSchema,
			plans: z.array(
				z.object({
					id: z.enum(PLAN_IDS),
					name: z.string(),
					monthlyPrice: z.number(),
					yearlyPrice: z.number(),
					emailsPerMonth: z.number().int(),
					subscribers: z.number().int(),
				})
			),
		}),
		handler: async ({ account }) => {
			assertBillingOn();
			const isFree = isOnFreePlan(account);
			const plan = getAccountPlan(account);
			const isPaid = isPaidStatus(account.subscriptionStatus) && !isFree && plan.id !== FREE_PLAN.id;
			const interval = isPaid ? (account.interval ?? "month") : "month";
			// Four independent reads, one of them a call to the billing provider: started together so the response waits for the slowest, not the sum.
			const [usage, extraEmails, dedicatedIp, plansOnSale] = await Promise.all([getUsageOutput(account), getExtraEmailsOutput(account), getDedicatedIpOutput(account), findPlansOnSale()]);
			return {
				plan: { id: plan.id, name: plan.name, interval, price: isPaid ? getPrice(plan, interval) : 0 },
				status: getAccountStatus(account),
				isActive: hasActiveSubscription(account),
				lapsedPlan: getLapsedPlan(account)?.id ?? null,
				sentWithLink: { shown: showsSentWithLink(account), required: isOnFreeTier(account) },
				freePlan: getFreePlanOutput(account),
				currentPeriodEnd: isPaid ? toIso(account.currentPeriodEnd) : null,
				cancelAt: isPaid ? toIso(account.cancelAt) : null,
				usage,
				extraEmails,
				dedicatedIp,
				plans: plansOnSale.map(({ id, name, monthlyPrice, emailsPerMonth, subscribers }) => ({
					id,
					name,
					monthlyPrice,
					yearlyPrice: getPrice({ monthlyPrice }, "year"),
					emailsPerMonth,
					subscribers,
				})),
			};
		},
	}),
	defineAction({
		name: "change_plan",
		title: "Change plan",
		group: GROUP,
		description: `Returns a billing page where the account owner picks up the change: Checkout without a paid plan (on the Free plan, after a plan lapsed or on a free plan from FlockStack too: the paid plan takes over), the Customer Portal with one (Stripe confirms the exact change there; Polar's portal lists the plans). Nothing changes until they confirm there. Give the URL to the user.${OFF_NOTE}`,
		http: { method: "POST", path: "/billing/change-plan" },
		requiresPlan: false,
		whileBlocked: true,
		openWorld: true,
		rateLimit: { limit: 30, window: "1 h" },
		example: { plan: "growth", interval: "year" },
		input: z.object({
			plan: z.enum(PLAN_IDS).describe("starter, growth, pro, scale or max"),
			interval: z.enum(INTERVALS).optional().describe("month (default) or year, which costs 10 months"),
		}),
		output: z.object({ url: z.string(), kind: z.enum(["checkout", "portal"]) }),
		handler: async ({ account, user, input, via }) => {
			assertBillingOn();
			if (!(await findPlansOnSale()).some(({ id }) => id === input.plan)) {
				throw actionError("validation_failed", `plan: ${getPlan(input.plan).name} isn't on sale yet. get_billing lists the plans on sale`);
			}
			const interval = input.interval ?? "month";
			if (isPaidStatus(account.subscriptionStatus)) {
				return { url: await openProvider(() => createPortalSession({ account, planId: input.plan, interval })), kind: "portal" };
			}
			const email = user?.email ?? (await findOwnerEmail(account._id));
			const attribution = via === "dashboard" ? await siteExtensions.readCheckoutAttribution() : {};
			return {
				url: await openProvider(() => createCheckoutSession({ account, user: { email }, planId: input.plan, interval, attribution })),
				kind: "checkout",
			};
		},
	}),
	defineAction({
		name: "set_extra_emails_limit",
		title: "Set the extra emails limit",
		group: GROUP,
		description: `Sets the most extra emails the account may send in a month past its plan's emails, at ${formatUsdCents(EXTRA_EMAILS.pricePerThousand)} per 1,000, billed with the plan. Sending stops at the limit; 0 stops at the plan's emails. The owner is emailed at 80% and at 100% of it. Only a paid plan billed by Polar sends extra emails (get_billing's extraEmails.available).${OFF_NOTE}`,
		http: { method: "POST", path: "/billing/extra-emails" },
		requiresPlan: false,
		whileBlocked: true,
		idempotent: true,
		example: { limit: 50_000 },
		input: z.object({
			limit: z.number().int().min(0).describe("Extra emails a month at most; 0 for none. At most 10 times the plan's emails"),
		}),
		output: z.object({ limit: z.number().int(), maxLimit: z.number().int() }),
		handler: async ({ account, input }) => {
			assertBillingOn();
			if (!canSendExtraEmails(account)) {
				throw actionError("conflict", "This plan can't send extra emails: it stops at its own emails. A paid plan billed by Polar can");
			}
			const maxLimit = getMaxExtraEmailsLimit(account);
			if (input.limit > maxLimit) throw actionError("validation_failed", `limit: ${formatNumber(maxLimit)} at most, 10 times the plan's emails`);
			await Account.updateOne({ _id: account._id }, { $set: { "extraEmails.limit": input.limit } });
			return { limit: input.limit, maxLimit };
		},
	}),
	defineAction({
		name: "add_dedicated_ip",
		title: "Buy the dedicated IP add-on",
		group: GROUP,
		description: `Returns a Polar checkout for the dedicated IP add-on: the account's own sending IP, at cost ($${DEDICATED_IP_PRICE} a month, no markup, billed monthly even on a yearly plan), for Pro, Scale and Max. FlockStack warms it up over about 30 days, and email goes through shared IPs until then. It is set up once paid (usually within 2 business days if none is free) and ends when it's canceled or the plan drops below Pro. Give the URL to the user.${OFF_NOTE}`,
		http: { method: "POST", path: "/billing/dedicated-ip" },
		requiresPlan: true,
		openWorld: true,
		rateLimit: { limit: 30, window: "1 h" },
		output: z.object({ url: z.string() }),
		handler: async ({ account, user, via }) => {
			assertBillingOn();
			if (getBillingProvider() !== "polar") throw actionError("unavailable", "The dedicated IP add-on is sold through Polar, which isn't set up on this server");
			if (!canHaveDedicatedIp(account)) throw actionError("conflict", "The dedicated IP add-on is for the Pro, Scale and Max plans. Upgrade first");
			if (account.dedicatedIp?.polarSubscriptionId && isPaidStatus(account.dedicatedIp.status)) {
				throw actionError("conflict", "The account already has the dedicated IP add-on. Manage it from the billing portal");
			}
			const planId = getAccountPlan(account).id;
			if (!(await isDedicatedIpOnSale())) throw actionError("unavailable", "The dedicated IP add-on isn't on sale yet. Try again later");
			const email = user?.email ?? (await findOwnerEmail(account._id));
			const attribution = via === "dashboard" ? await siteExtensions.readCheckoutAttribution() : {};
			return { url: await openProvider(() => createDedicatedIpCheckout({ account, user: { email }, planId, attribution })) };
		},
	}),
	defineAction({
		name: "set_sent_with_link",
		title: "Show or hide the Sent with FlockStack link",
		group: GROUP,
		description: `Shows or hides the small "Sent with FlockStack" link under the footer of the account's emails and on its websites. The Free plan always carries it and answers conflict; a paid plan has it off until it is turned on.${OFF_NOTE}`,
		http: { method: "POST", path: "/billing/sent-with-link" },
		requiresPlan: false,
		idempotent: true,
		example: { enabled: true },
		input: z.object({ enabled: z.boolean().describe("true shows the link, false hides it") }),
		output: z.object({ enabled: z.boolean() }),
		handler: async ({ account, input }) => {
			assertBillingOn();
			if (isOnFreeTier(account)) throw actionError("conflict", "The Free plan always carries the Sent with FlockStack link. Upgrade to a paid plan to take it off");
			await Account.updateOne({ _id: account._id }, { $set: { sentWithLink: input.enabled } });
			return { enabled: input.enabled };
		},
	}),
	defineAction({
		name: "open_billing_portal",
		title: "Open the billing portal",
		group: GROUP,
		description: `Returns a Customer Portal link (Stripe or Polar) for the account owner: payment method, invoices, plan changes and cancellation.${OFF_NOTE}`,
		http: { method: "POST", path: "/billing/portal" },
		requiresPlan: false,
		whileBlocked: true,
		openWorld: true,
		rateLimit: { limit: 30, window: "1 h" },
		output: z.object({ url: z.string() }),
		handler: async ({ account }) => {
			assertBillingOn();
			if (!hasBillingCustomer(account)) throw actionError("conflict", "The account has no billing details yet: they exist once it pays for a plan");
			return { url: await openProvider(() => createPortalSession({ account })) };
		},
	}),
];
