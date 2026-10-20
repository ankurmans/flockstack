import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, toIso } from "@/lib/actions/shared";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { assertPaymentsReady } from "@/lib/payments/connect";
import { cancelConversion, findRunningConversion, startConversion, toConversionOutput } from "@/lib/pledge-conversion";
import { NOTICE_DAYS, cancelPledgeForOwner, getPledgeReport, getPledgeSettings, isPledgeOpen } from "@/lib/pledges";
import { findTier, getNewsletterTiers, getOfferedTiers } from "@/lib/tier-rules";
import { isObjectIdString } from "@/lib/validation";
import { revalidateShop } from "@/lib/products";
import Newsletter from "@/models/Newsletter";
import Pledge, { PLEDGE_STATUSES } from "@/models/Pledge";
import PledgeConversion from "@/models/PledgeConversion";

const GROUP = "Pledges";
const NO_CUT = "FlockStack takes no cut of what you earn: readers pay your own Stripe account, and only Stripe's own processing fee comes off.";
const newsletterId = z.string().trim().min(1).max(100).describe("The newsletter's ID or slug");
const WHAT_IT_IS =
	"A pledge is a reader's promise to pay a monthly or yearly price once the writer takes payments: they enter a card, which is saved on your Stripe account with a SetupIntent and not charged. Pledgers get no paid access until they are charged.";

const SettingsSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean().describe("Readers can pledge on the subscribe page"),
	open: z.boolean().describe("Pledging is open now: enabled, and the paid tier is not open yet (once it is, readers subscribe instead)"),
	noticeDays: z.number().int().describe("Days before the first charge that each pledger is emailed, 7 by default"),
	subscribeUrl: z.string().nullable().describe("The page where readers pledge, once the archive is on"),
});

const PledgeSchema = z.object({
	id: z.string(),
	email: z.string(),
	tierId: z.string(),
	tierName: z.string(),
	option: z.enum(["month", "year"]),
	amountCents: z.number().int().describe("What they pledged, in the currency's smallest unit"),
	currency: z.string(),
	status: z.enum(PLEDGE_STATUSES).describe("active: card saved, nothing charged. scheduled: told the day of the first charge. converted: now a paid subscriber. failed: the card was refused or the notice couldn't be emailed. canceled."),
	pledgedAt: dateOutput,
	noticeSentAt: dateOutput,
	chargeAt: dateOutput.describe("The day of their first charge, once they were told"),
	failure: z.string().nullable(),
});

const ConversionSchema = z.object({
	id: z.string(),
	status: z.enum(["notifying", "waiting", "charging", "done", "canceled", "failed"]).describe("notifying: emailing each pledger. waiting: until the charge day. charging: making the subscriptions. done."),
	tierId: z.string().nullable().describe("Only this tier's pledges, or null for every tier's"),
	noticeDays: z.number().int(),
	chargeAt: z.string().describe("The day the first charges are made"),
	honorPledgedPrice: z.boolean().describe("Each pledger is charged what they pledged, not the tier's price now"),
	total: z.number().int().describe("Pledges it started with"),
	notified: z.number().int(),
	converted: z.number().int().describe("Pledgers now subscribed"),
	failed: z.number().int(),
	error: z.string().nullable(),
	finishedAt: dateOutput,
});

function toSettings(newsletter) {
	const settings = getPledgeSettings(newsletter);
	return {
		newsletterId: String(newsletter._id),
		enabled: settings.enabled,
		open: isPledgeOpen(newsletter),
		noticeDays: settings.noticeDays,
		subscribeUrl: settings.enabled && newsletter.archiveEnabled ? getArchiveUrls(newsletter).absoluteSubscribe : null,
	};
}

function toPledge(pledge, tiers) {
	return {
		id: String(pledge._id),
		email: pledge.email,
		tierId: pledge.tierId,
		tierName: findTier(tiers, pledge.tierId)?.name ?? pledge.tierId,
		option: pledge.option,
		amountCents: pledge.amountCents,
		currency: pledge.currency,
		status: pledge.status,
		pledgedAt: toIso(pledge.pledgedAt),
		noticeSentAt: toIso(pledge.noticeSentAt),
		chargeAt: toIso(pledge.chargeAt),
		failure: pledge.failure ?? null,
	};
}

const setPledges = defineAction({
	name: "set_pledges",
	title: "Set a newsletter's pledges",
	group: GROUP,
	description: `Turns pledges on or off for a newsletter and sets how many days before the first charge each pledger is emailed. ${WHAT_IT_IS} Pledging is for a newsletter that hasn't opened its paid tier yet, or wants to see who would pay: the subscribe page then says clearly that nothing is charged now. It needs a paid tier with a price (create_paid_tier or set_paid_tier) and a Stripe account that can take payments. ${NO_CUT}`,
	http: { method: "PATCH", path: "/newsletters/{id}/pledges" },
	idempotent: true,
	example: { enabled: true, noticeDays: 7 },
	input: z.object({
		id: newsletterId,
		enabled: z.boolean().optional().describe("Let readers pledge on the subscribe page"),
		noticeDays: z.number().int().min(NOTICE_DAYS.min).max(NOTICE_DAYS.max).optional().describe(`Days before the first charge that each pledger is emailed, ${NOTICE_DAYS.min} to ${NOTICE_DAYS.max}. Default: ${NOTICE_DAYS.default}.`),
	}),
	output: SettingsSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const current = getPledgeSettings(newsletter);
		const next = { enabled: input.enabled ?? current.enabled, noticeDays: input.noticeDays ?? current.noticeDays };
		if (next.enabled && !current.enabled) {
			assertPaymentsReady(account);
			if (getOfferedTiers(getNewsletterTiers(newsletter)).length === 0) throw actionError("validation_failed", "enabled: give the newsletter a paid tier with a price first (create_paid_tier)");
		}
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { "paidTier.pledges": next } });
		revalidateShop();
		return toSettings({ ...newsletter, paidTier: { ...newsletter.paidTier, pledges: next } });
	},
});

const getPledgeReportAction = defineAction({
	name: "get_pledge_report",
	title: "Get the pledge report",
	group: GROUP,
	description: `Counts a newsletter's pledges and totals what is pledged, per tier: how many pledgers, the monthly and the yearly pledges apart, and everything as a monthly total. Only pledges that stand count (not canceled or failed). ${WHAT_IT_IS}`,
	http: { method: "GET", path: "/newsletters/{id}/pledges/report" },
	readOnly: true,
	input: z.object({ id: newsletterId }),
	output: z.object({
		settings: SettingsSchema,
		pledges: z.number().int().describe("Pledges that stand"),
		perMonthCents: z.number().int().describe("Everything pledged as a monthly amount, a yearly pledge counted as a twelfth"),
		currency: z.string(),
		tiers: z.array(
			z.object({
				tierId: z.string(),
				name: z.string(),
				pledges: z.number().int(),
				monthlyCents: z.number().int().describe("The sum of the monthly pledges"),
				yearlyCents: z.number().int().describe("The sum of the yearly pledges"),
				perMonthCents: z.number().int(),
			})
		),
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		return { settings: toSettings(newsletter), ...(await getPledgeReport(account, newsletter)) };
	},
});

const listPledges = defineAction({
	name: "list_pledges",
	title: "List pledges",
	group: GROUP,
	description: "Lists a newsletter's pledges, newest first, 50 a page: who pledged what, and whether they were told the day of their first charge, were charged or canceled. Pass nextCursor back as cursor for the next page.",
	http: { method: "GET", path: "/newsletters/{id}/pledges" },
	readOnly: true,
	example: { status: "active" },
	input: z.object({
		id: newsletterId,
		status: z.enum(PLEDGE_STATUSES).optional().describe("Only pledges with this status"),
		limit: z.number().int().min(1).max(100).optional().describe("Pledges per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({ pledges: z.array(PledgeSchema), nextCursor: z.string().nullable().describe("null on the last page") }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const limit = input.limit ?? 50;
		const filter = scoped(account, {
			newsletterId: newsletter._id,
			// A pledge that never got its card saved isn't a pledge.
			status: input.status ?? { $ne: "pending" },
			...(input.cursor && afterCursor(input.cursor, "createdAt")),
		});
		const pledges = await Pledge.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
		const page = pledges.slice(0, limit);
		const last = page.at(-1);
		const tiers = getNewsletterTiers(newsletter);
		return { pledges: page.map((pledge) => toPledge(pledge, tiers)), nextCursor: pledges.length > limit ? encodeCursor(last.createdAt, last._id) : null };
	},
});

const cancelPledge = defineAction({
	name: "cancel_pledge",
	title: "Cancel a pledge",
	group: GROUP,
	description: "Cancels a pledge before its charge starts and removes the saved card. The pledger isn't emailed. A pledge being charged, or already a subscription, answers conflict: end a subscription in Stripe.",
	http: { method: "DELETE", path: "/pledges/{id}" },
	destructive: true,
	idempotent: true,
	openWorld: true,
	input: z.object({ id: z.string().trim().min(1).max(100).describe("The pledge's ID") }),
	output: PledgeSchema,
	handler: async ({ account, input }) => {
		const pledge = isObjectIdString(input.id) ? await Pledge.findOne(scoped(account, { _id: input.id })).lean() : null;
		if (!pledge || pledge.status === "pending") throw actionError("not_found", "Pledge not found");
		if (pledge.status !== "canceled" && !(await cancelPledgeForOwner(account, pledge))) throw actionError("conflict", "This pledge is being charged or already is a subscription");
		const newsletter = await Newsletter.findOne(scoped(account, { _id: pledge.newsletterId })).lean();
		return toPledge({ ...pledge, status: "canceled" }, getNewsletterTiers(newsletter));
	},
});

const startPledgeCharging = defineAction({
	name: "start_pledge_charging",
	title: "Start charging pledges",
	group: GROUP,
	description: `Converts a newsletter's pledges into paid subscriptions, in steps that can be resumed and never charge a pledger twice. First every pledger gets an email with the day of their first charge (noticeDays from now) and a link to cancel; on that day each card is charged off-session by creating a subscription on your Stripe account, and the reader becomes a paid subscriber. A pledger who canceled in between is not charged; a card that is refused is marked failed and the pledger is told. Needs the paid tier turned on (set_paid_tier). stop_pledge_charging cancels it until the charge day. ${NO_CUT}`,
	http: { method: "POST", path: "/newsletters/{id}/pledges/charge" },
	destructive: true,
	openWorld: true,
	example: { noticeDays: 7 },
	input: z.object({
		id: newsletterId,
		tier: z.string().trim().max(100).optional().describe("Only this tier's pledges: its ID or name. Default: every tier's."),
		noticeDays: z.number().int().min(NOTICE_DAYS.min).max(NOTICE_DAYS.max).optional().describe(`Days before the first charge that each pledger is emailed. Default: the newsletter's setting (set_pledges), ${NOTICE_DAYS.default} to start.`),
		honorPledgedPrice: z.boolean().optional().describe("Charge each pledger what they pledged (the default), or the tier's price now"),
	}),
	output: ConversionSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const tiers = getNewsletterTiers(newsletter);
		let tierId;
		if (input.tier) {
			const wanted = input.tier.toLowerCase();
			const tier = tiers.find((candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted);
			if (!tier) throw actionError("validation_failed", `tier: the newsletter has no paid tier ${JSON.stringify(input.tier)}`);
			tierId = tier.id;
		}
		return toConversionOutput(await startConversion({ account, newsletter, tierId, noticeDays: input.noticeDays, honorPledgedPrice: input.honorPledgedPrice }));
	},
});

const getPledgeCharging = defineAction({
	name: "get_pledge_charging",
	title: "Get the pledge charging",
	group: GROUP,
	description: "Gets where start_pledge_charging is for a newsletter: the one running, or the last one, with how many pledgers were told, subscribed or failed. null when pledges were never charged.",
	http: { method: "GET", path: "/newsletters/{id}/pledges/charging" },
	readOnly: true,
	input: z.object({ id: newsletterId }),
	output: z.object({ charging: ConversionSchema.nullable() }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const conversion = (await findRunningConversion(account, newsletter._id)) ?? (await PledgeConversion.findOne(scoped(account, { newsletterId: newsletter._id })).sort({ createdAt: -1, _id: -1 }).lean());
		return { charging: conversion ? toConversionOutput(conversion) : null };
	},
});

const stopPledgeCharging = defineAction({
	name: "stop_pledge_charging",
	title: "Stop charging pledges",
	group: GROUP,
	description: "Stops the pledge charging before the charge day: pledgers who were told go back to pledged and nobody is charged. Once the charging has started it can't be stopped; cancel a pledge with cancel_pledge instead.",
	http: { method: "POST", path: "/newsletters/{id}/pledges/charging/stop" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: newsletterId }),
	output: ConversionSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const conversion = await findRunningConversion(account, newsletter._id);
		if (!conversion) throw actionError("conflict", "No pledge charging is running");
		await cancelConversion({ account, conversion });
		return toConversionOutput({ ...conversion, status: "canceled" });
	},
});

export const pledgeActions = [setPledges, getPledgeReportAction, listPledges, cancelPledge, startPledgeCharging, getPledgeCharging, stopPledgeCharging];
