import "server-only";
import { scoped } from "@/lib/account-scope";
import { sendAlert } from "@/lib/alerts";
import { actionError } from "@/lib/actions/errors";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { assertPaymentsReady, getChargeAccount } from "@/lib/payments/connect";
import { StripeError, stripeRequest } from "@/lib/payments/stripe-api";
import { getTierPriceId, getTierProductId } from "@/lib/payments/tier-prices";
import { clean, describePledgeAmount, formatDay, getPledgeCancelUrl, getPledgeSettings } from "@/lib/pledges";
import { publishJob, sendTransactionalEmail } from "@/lib/sending";
import { STRIPE_INTERVALS, findTier, getContactInterval, getNewsletterTiers } from "@/lib/tier-rules";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";
import Newsletter from "@/models/Newsletter";
import Pledge from "@/models/Pledge";
import PledgeConversion from "@/models/PledgeConversion";

// "Start charging" for a newsletter's pledges, in QStash steps that each save their place (models/PledgeConversion.js).
//   notifying: every pledger gets an email with the day of their first charge and a link to cancel.
//   waiting:   until that day (noticeDays after the start), a step republishing itself.
//   charging:  one subscription per pledger, off-session, on the card they saved.
// A pledger who canceled in between is never charged, a subscription is made once per pledge (a Stripe idempotency key, and a
// search for one before making another), and a step that dies or runs twice picks up from the pledges' own statuses.
const RUNNING = ["notifying", "waiting", "charging"];
const LOCK_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
const CHUNK = 20;
// QStash holds a delayed job for a limited time: a longer wait is several steps.
const MAX_WAIT_MS = 6 * 86_400_000;
const STALE_MS = 15 * 60_000;
const CHARGE_FAILED = "failed";

function getStepMs() {
	return process.env.PLEDGE_STEP_MS ? Number(process.env.PLEDGE_STEP_MS) : 20_000;
}

export function getConversionJobUrl() {
	return `${getAppUrl()}/api/jobs/convert-pledges`;
}

function publishStep(accountId, conversionId, notBeforeMs) {
	return publishJob({
		url: getConversionJobUrl(),
		body: { accountId: String(accountId), conversionId: String(conversionId) },
		...(notBeforeMs && { notBefore: Math.floor(notBeforeMs / 1000) }),
	});
}

export function findRunningConversion(account, newsletterId) {
	return PledgeConversion.findOne(scoped(account, { newsletterId, status: { $in: RUNNING } })).lean();
}

function tierFilter(tierId) {
	return tierId ? { tierId } : {};
}

export function countActivePledges(account, newsletterId, tierId) {
	return Pledge.countDocuments(scoped(account, { newsletterId, status: "active", ...tierFilter(tierId) }));
}

// One click on the dashboard or one call: starts telling the pledgers. noticeDays: how long before the first charge, the
// newsletter's setting by default. honorPledgedPrice: charge what each pledged (the default) or the tier's price now.
export async function startConversion({ account, newsletter, tierId, noticeDays, honorPledgedPrice = true }) {
	assertPaymentsReady(account);
	if (!newsletter.paidTier?.enabled) throw actionError("conflict", "Turn on the paid tier first (set_paid_tier): pledgers are charged for it");
	if (await findRunningConversion(account, newsletter._id)) throw actionError("conflict", "Pledges are already being charged: see get_pledge_charging");
	const resumed = await resumeFailedConversion({ account, newsletter });
	if (resumed) return resumed;
	const total = await countActivePledges(account, newsletter._id, tierId);
	if (total === 0) throw actionError("conflict", "There are no pledges to charge");
	const days = noticeDays ?? getPledgeSettings(newsletter).noticeDays;
	const conversion = (
		await PledgeConversion.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			...(tierId && { tierId }),
			noticeDays: days,
			chargeAt: new Date(Date.now() + days * 86_400_000),
			honorPledgedPrice,
			total,
		})
	).toObject();
	try {
		await publishStep(account._id, conversion._id);
	} catch (error) {
		await PledgeConversion.updateOne(scoped(account, { _id: conversion._id }), { $set: { status: "failed", error: "The job queue didn't take it", finishedAt: new Date() } });
		throw error;
	}
	return conversion;
}

// A conversion that failed (a step failed three times in a row) carries on where it stopped: its pledgers were told, some are
// charged, and none is charged twice. Starting again is how the writer retries.
async function resumeFailedConversion({ account, newsletter }) {
	const failed = await PledgeConversion.findOne(scoped(account, { newsletterId: newsletter._id, status: "failed" })).sort({ createdAt: -1, _id: -1 }).lean();
	if (!failed) return null;
	const left = await Pledge.exists(scoped(account, { conversionId: failed._id, status: { $in: ["notifying", "scheduled", "charging"] } }));
	if (!left) return null;
	await PledgeConversion.updateOne(scoped(account, { _id: failed._id }), {
		$set: { status: "notifying", attempts: 0 },
		$unset: { error: 1, finishedAt: 1, lockedUntil: 1, cursor: 1 },
	});
	await publishStep(account._id, failed._id);
	return { ...failed, status: "notifying", error: undefined, finishedAt: undefined };
}

// Stops it before the charge: pledgers who were told go back to pledged, and nobody is charged. A pledge being charged
// right now is charged.
export async function cancelConversion({ account, conversion }) {
	const { matchedCount } = await PledgeConversion.updateOne(scoped(account, { _id: conversion._id, status: { $in: ["notifying", "waiting"] } }), {
		$set: { status: "canceled", finishedAt: new Date() },
		$unset: { lockedUntil: 1 },
	});
	if (!matchedCount) throw actionError("conflict", "The charging has started or is over: it can't be stopped");
	await Pledge.updateMany(scoped(account, { conversionId: conversion._id, status: { $in: ["notifying", "scheduled"] } }), {
		$set: { status: "active" },
		$unset: { conversionId: 1, noticeSentAt: 1, chargeAt: 1 },
	});
}

function buildNoticeEmail({ pledge, newsletter, tier, conversion }) {
	const name = clean(newsletter.name);
	const day = formatDay(conversion.chargeAt);
	return {
		subject: `Your pledge to ${name} will be charged on ${day}`,
		reason: `You're receiving this because you pledged support for ${name}.`,
		markdown: [
			`${name} is now taking payments. You pledged **${describePledgeAmount(pledge)}** for the ${clean(tier?.name ?? "paid")} tier, so your card will be charged on **${day}**, and then every ${pledge.option === "year" ? "year" : "month"}, and you get every paid issue.`,
			"You don't have to do anything. If you've changed your mind, cancel before then and you won't be charged.",
			`[Cancel your pledge](${getPledgeCancelUrl(pledge, newsletter)})`,
		].join("\n\n"),
	};
}

async function notifyPledge({ pledge, conversion, newsletter, tiers }) {
	const accountId = conversion.accountId;
	const claim = await Pledge.updateOne(scoped(accountId, { _id: pledge._id, status: { $in: ["active", "notifying"] } }), { $set: { status: "notifying", conversionId: conversion._id } });
	if (!claim.matchedCount) return "skipped";
	const result = await sendTransactionalEmail({
		accountId,
		newsletterId: newsletter._id,
		to: pledge.email,
		...buildNoticeEmail({ pledge, newsletter, tier: findTier(tiers, pledge.tierId), conversion }),
	});
	if (result.sent) {
		await Pledge.updateOne(scoped(accountId, { _id: pledge._id, status: "notifying" }), { $set: { status: "scheduled", noticeSentAt: new Date(), chargeAt: conversion.chargeAt } });
		return "notified";
	}
	await Pledge.updateOne(scoped(accountId, { _id: pledge._id, status: "notifying" }), { $set: { status: "failed", failure: `The notice couldn't be emailed (${result.reason}), so the card wasn't charged` } });
	return CHARGE_FAILED;
}

// A subscription made for this pledge before: a step that died after Stripe made it must not make a second one.
async function findPledgeSubscription({ pledge, stripeAccount }) {
	const { data } = await stripeRequest("/v1/subscriptions", { account: stripeAccount, params: { customer: pledge.stripeCustomerId, status: "all", limit: 20 } });
	return data.find((subscription) => subscription.metadata?.pledgeId === String(pledge._id)) ?? null;
}

async function createPledgeSubscription({ account, newsletter, pledge, tier, conversion }) {
	const stripeAccount = getChargeAccount(account);
	const existing = await findPledgeSubscription({ pledge, stripeAccount });
	if (existing) return existing;
	const currentPrice = tier.prices[pledge.option] ?? 0;
	const useCurrentPrice = !conversion.honorPledgedPrice || currentPrice === pledge.amountCents;
	const interval = pledge.option === "year" ? STRIPE_INTERVALS.year : STRIPE_INTERVALS.month;
	let item;
	if (useCurrentPrice && currentPrice > 0) {
		item = { price: await getTierPriceId({ account, newsletter, tier, option: pledge.option }), quantity: 1 };
	} else {
		item = { quantity: 1, price_data: { currency: pledge.currency, product: await getTierProductId({ account, newsletter, tier }), unit_amount: pledge.amountCents, recurring: interval } };
	}
	const metadata = {
		flockstack: "1",
		kind: "paid_tier",
		accountId: String(account._id),
		newsletterId: String(newsletter._id),
		tierId: tier.id,
		option: pledge.option,
		interval: getContactInterval(tier, pledge.option),
		pledgeId: String(pledge._id),
	};
	return stripeRequest("/v1/subscriptions", {
		method: "POST",
		account: stripeAccount,
		idempotencyKey: `flockstack-pledge-subscription-${pledge._id}`,
		params: { customer: pledge.stripeCustomerId, default_payment_method: pledge.paymentMethodId, off_session: true, payment_behavior: "error_if_incomplete", items: [item], metadata },
	});
}

async function sendChargeFailedEmail({ pledge, newsletter, reason }) {
	const name = clean(newsletter.name);
	await sendTransactionalEmail({
		accountId: pledge.accountId,
		newsletterId: newsletter._id,
		to: pledge.email,
		subject: `Your pledge to ${name} couldn't be charged`,
		reason: `You're receiving this because you pledged support for ${name}.`,
		markdown: [`Your card was declined when we tried to charge your pledge of ${describePledgeAmount(pledge)}${reason ? `: ${clean(reason)}` : ""}.`, `You haven't been charged. To become a paid subscriber anyway, [subscribe here](${getArchiveUrls(newsletter).absoluteSubscribe}).`].join("\n\n"),
	}).catch((error) => console.error(`[pledges] The failure email for pledge ${pledge._id} failed:`, error.message));
}

async function chargePledge({ pledge, conversion, account, newsletter, tiers }) {
	const claim = await Pledge.updateOne(scoped(account, { _id: pledge._id, status: { $in: ["scheduled", "charging"] } }), { $set: { status: "charging", chargingAt: new Date() } });
	if (!claim.matchedCount) return "skipped";
	const tier = findTier(tiers, pledge.tierId);
	try {
		if (!tier) throw Object.assign(new Error("The tier was deleted"), { isFinal: true });
		const subscription = await createPledgeSubscription({ account, newsletter, pledge, tier, conversion });
		await Pledge.updateOne(scoped(account, { _id: pledge._id }), { $set: { status: "converted", subscriptionId: subscription.id, convertedAt: new Date() } });
		return "converted";
	} catch (error) {
		// A card that is refused is final; Stripe being down or a timeout is tried again by the next step.
		const isCardProblem = error instanceof StripeError && error.type === "card_error";
		if (!isCardProblem && !error.isFinal) throw error;
		await Pledge.updateOne(scoped(account, { _id: pledge._id }), { $set: { status: "failed", failure: String(error.message).slice(0, 300) } });
		await sendChargeFailedEmail({ pledge, newsletter, reason: isCardProblem ? "the bank refused it" : "" });
		return CHARGE_FAILED;
	}
}

// Runs the pledges of a phase in chunks after the saved cursor until none is left or the time is up.
async function walkPledges({ conversion, filter, work, until }) {
	let cursor = conversion.cursor ?? null;
	let isDone = false;
	const counts = {};
	for (;;) {
		const page = await Pledge.find({ ...filter, ...(cursor && { _id: { $gt: cursor } }) })
			.sort({ _id: 1 })
			.limit(CHUNK)
			.lean();
		if (page.length === 0) {
			isDone = true;
			break;
		}
		for (const pledge of page) {
			const outcome = await work(pledge);
			counts[outcome] = (counts[outcome] ?? 0) + 1;
			cursor = String(pledge._id);
		}
		await PledgeConversion.updateOne(scoped(conversion.accountId, { _id: conversion._id }), { $set: { cursor } });
		if (Date.now() >= until) break;
	}
	return { isDone, counts, cursor };
}

async function finish({ conversion }) {
	const accountId = conversion.accountId;
	const count = (status) => Pledge.countDocuments(scoped(accountId, { conversionId: conversion._id, status }));
	const [converted, failed] = await Promise.all([count("converted"), count("failed")]);
	await PledgeConversion.updateOne(scoped(accountId, { _id: conversion._id }), {
		$set: { status: "done", finishedAt: new Date(), attempts: 0, "counts.converted": converted, "counts.failed": failed },
		$unset: { lockedUntil: 1, cursor: 1 },
	});
	await sendAlert({
		accountId,
		key: `pledge-conversion:${conversion._id}`,
		title: "Your pledges were charged",
		detail: `${converted} ${converted === 1 ? "pledge is" : "pledges are"} now ${converted === 1 ? "a paid subscription" : "paid subscriptions"}${failed > 0 ? `, and ${failed} couldn't be charged` : ""}.`,
		path: "/payments",
	});
	return { done: true, converted, failed };
}

// One job of a conversion. Claims it, does the phase it is in for a while, and publishes the next step. A step that throws is
// tried again by QStash from the saved place; the third time in a row, the conversion fails.
export async function runConversionStep({ accountId, conversionId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(conversionId))) return { skipped: "invalid job" };
	await connectDb();
	const now = new Date();
	const claimed = await PledgeConversion.findOneAndUpdate(
		scoped(accountId, { _id: conversionId, status: { $in: RUNNING }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }),
		{ $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
		{ returnDocument: "after" }
	).lean();
	if (!claimed) {
		const current = await PledgeConversion.findOne(scoped(accountId, { _id: conversionId })).lean();
		return current && RUNNING.includes(current.status) ? { busy: true } : { skipped: current?.status ?? "not found" };
	}

	const until = Date.now() + getStepMs();
	try {
		const [account, newsletter] = await Promise.all([Account.findById(accountId).lean(), Newsletter.findOne(scoped(accountId, { _id: claimed.newsletterId })).lean()]);
		if (!account || !newsletter) {
			await PledgeConversion.updateOne(scoped(accountId, { _id: conversionId }), { $set: { status: "failed", error: "The newsletter is gone", finishedAt: new Date() }, $unset: { lockedUntil: 1 } });
			return { failed: "The newsletter is gone" };
		}
		const tiers = getNewsletterTiers(newsletter);
		let conversion = claimed;
		const unlockAndContinue = async (notBefore) => {
			await PledgeConversion.updateOne(scoped(accountId, { _id: conversionId }), { $set: { attempts: 0 }, $unset: { lockedUntil: 1 } });
			await publishStep(accountId, conversionId, notBefore);
		};

		if (conversion.status === "notifying") {
			const { isDone, counts } = await walkPledges({
				conversion,
				filter: scoped(accountId, { newsletterId: conversion.newsletterId, status: { $in: ["active", "notifying"] }, ...tierFilter(conversion.tierId) }),
				work: (pledge) => notifyPledge({ pledge, conversion, newsletter, tiers }),
				until,
			});
			const notified = (conversion.counts?.notified ?? 0) + (counts.notified ?? 0);
			if (!isDone) {
				await PledgeConversion.updateOne(scoped(accountId, { _id: conversionId }), { $set: { "counts.notified": notified } });
				await unlockAndContinue();
				return { continued: true, notified };
			}
			await PledgeConversion.updateOne(scoped(accountId, { _id: conversionId }), { $set: { status: "waiting", "counts.notified": notified }, $unset: { cursor: 1 } });
			conversion = { ...conversion, status: "waiting", cursor: null };
		}

		if (conversion.status === "waiting") {
			const wait = new Date(conversion.chargeAt).getTime() - Date.now();
			if (wait > 0) {
				await unlockAndContinue(Date.now() + Math.min(wait, MAX_WAIT_MS));
				return { waiting: true, chargeAt: conversion.chargeAt };
			}
			await PledgeConversion.updateOne(scoped(accountId, { _id: conversionId }), { $set: { status: "charging" }, $unset: { cursor: 1 } });
			conversion = { ...conversion, status: "charging", cursor: null };
		}

		const { isDone } = await walkPledges({
			conversion,
			filter: scoped(accountId, { conversionId: conversion._id, status: { $in: ["scheduled", "charging"] } }),
			work: (pledge) => chargePledge({ pledge, conversion, account, newsletter, tiers }),
			until,
		});
		if (!isDone) {
			await unlockAndContinue();
			return { continued: true };
		}
		return await finish({ conversion });
	} catch (error) {
		const attempts = (claimed.attempts ?? 0) + 1;
		if (attempts >= MAX_ATTEMPTS) {
			await PledgeConversion.updateOne(scoped(accountId, { _id: conversionId }), {
				$set: { status: "failed", attempts, error: String(error?.message ?? error).slice(0, 300), finishedAt: new Date() },
				$unset: { lockedUntil: 1 },
			});
			await sendAlert({ accountId, key: `pledge-conversion:${conversionId}`, title: "Charging your pledges stopped", detail: String(error?.message ?? error).slice(0, 200), action: "Nobody was charged twice. Start charging again to carry on with the rest.", path: "/payments" });
			return { failed: String(error?.message ?? error) };
		}
		await PledgeConversion.updateOne(scoped(accountId, { _id: conversionId }), { $set: { attempts }, $unset: { lockedUntil: 1 } });
		throw error;
	}
}

// A conversion whose job went quiet (a Worker cut off, a lost delivery) gets another. Run from the hourly cron.
export async function resumeConversions({ now = Date.now() } = {}) {
	await connectDb();
	const quiet = await PledgeConversion.find({ status: { $in: RUNNING }, updatedAt: { $lt: new Date(now - STALE_MS) } })
		.setOptions({ crossAccount: true })
		.limit(50)
		.lean();
	let resumed = 0;
	for (const conversion of quiet) {
		if (conversion.lockedUntil && new Date(conversion.lockedUntil).getTime() > now) continue;
		const wait = new Date(conversion.chargeAt).getTime() - now;
		const isWaiting = conversion.status === "waiting" && wait > MAX_WAIT_MS;
		if (isWaiting) continue;
		await publishStep(conversion.accountId, conversion._id);
		await PledgeConversion.updateOne(scoped(conversion.accountId, { _id: conversion._id }), { $set: { attempts: conversion.attempts ?? 0 } });
		resumed++;
	}
	return { resumed };
}

export function toConversionOutput(conversion) {
	return {
		id: String(conversion._id),
		status: conversion.status,
		tierId: conversion.tierId ?? null,
		noticeDays: conversion.noticeDays,
		chargeAt: new Date(conversion.chargeAt).toISOString(),
		honorPledgedPrice: Boolean(conversion.honorPledgedPrice),
		total: conversion.total ?? 0,
		notified: conversion.counts?.notified ?? 0,
		converted: conversion.counts?.converted ?? 0,
		failed: conversion.counts?.failed ?? 0,
		error: conversion.error ?? null,
		finishedAt: conversion.finishedAt ? new Date(conversion.finishedAt).toISOString() : null,
	};
}

