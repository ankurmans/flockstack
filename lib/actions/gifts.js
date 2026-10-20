import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, toIso } from "@/lib/actions/shared";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { GIFT_REDEEM_MONTHS, getGiftState } from "@/lib/gift-rules";
import { areGiftsOpen, resendGift } from "@/lib/gifts";
import { assertPaymentsReady } from "@/lib/payments/connect";
import { revalidateShop } from "@/lib/products";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { isObjectIdString } from "@/lib/validation";
import Gift, { GIFT_STATUSES } from "@/models/Gift";
import Newsletter from "@/models/Newsletter";

const GROUP = "Gifts";
const NO_CUT = "FlockStack takes no cut of what you earn: readers pay your own Stripe account, and only Stripe's own processing fee comes off.";
const newsletterId = z.string().trim().min(1).max(100).describe("The newsletter's ID or slug");
const GIFT_STATES = [...GIFT_STATUSES];
const HOW_IT_WORKS = `A gift is one Stripe payment on your account for 1, 3, 6 or 12 months of a paid tier. The buyer picks the recipient, a message and the day it is sent; the recipient gets an email from the newsletter with the message and a link, and the months start the day they redeem it. An unredeemed gift expires ${GIFT_REDEEM_MONTHS} months after it was bought: the payment is kept (refund it in Stripe if you wish) and the link says it expired.`;

const SettingsSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean().describe("Readers can buy gifts"),
	open: z.boolean().describe("The gift page is open now: gifts are on and so is the paid tier"),
	giveUrl: z.string().nullable().describe("The page where a gift is bought, once the archive is on"),
});

const GiftSchema = z.object({
	id: z.string(),
	status: z.enum(GIFT_STATES).describe("paid: bought, waiting for its delivery day. sent: the recipient has the email. redeemed. expired: not redeemed in time. refunded."),
	tierId: z.string(),
	tierName: z.string(),
	months: z.number().int(),
	amountCents: z.number().int(),
	currency: z.string(),
	buyerEmail: z.string(),
	buyerName: z.string().nullable(),
	recipientEmail: z.string(),
	message: z.string().nullable().describe("The buyer's message, as plain text"),
	deliverOn: z.string().describe("The day the recipient gets the email"),
	paidAt: dateOutput,
	sentAt: dateOutput,
	redeemedAt: dateOutput,
	expiresAt: dateOutput.describe("The last moment it can be redeemed"),
	accessUntil: dateOutput.describe("When the recipient's paid access from it ends, once redeemed"),
	deliveryError: z.string().nullable().describe("Why the email didn't go out, if it didn't: resend_gift to another address"),
});

function toSettings(newsletter) {
	return {
		newsletterId: String(newsletter._id),
		enabled: Boolean(newsletter.paidTier?.gifts?.enabled),
		open: areGiftsOpen(newsletter),
		giveUrl: newsletter.paidTier?.gifts?.enabled && newsletter.archiveEnabled ? getArchiveUrls(newsletter).absoluteGive : null,
	};
}

function toGift(gift, tiers) {
	return {
		id: String(gift._id),
		status: getGiftState(gift),
		tierId: gift.tierId,
		tierName: findTier(tiers, gift.tierId)?.name ?? gift.tierId,
		months: gift.months,
		amountCents: gift.amountCents,
		currency: gift.currency,
		buyerEmail: gift.buyerEmail,
		buyerName: gift.buyerName ?? null,
		recipientEmail: gift.recipientEmail,
		message: gift.message ?? null,
		deliverOn: new Date(gift.deliverOn).toISOString(),
		paidAt: toIso(gift.paidAt),
		sentAt: toIso(gift.sentAt),
		redeemedAt: toIso(gift.redeemedAt),
		expiresAt: toIso(gift.expiresAt),
		accessUntil: toIso(gift.accessUntil),
		deliveryError: gift.deliveryError ?? null,
	};
}

const setGifts = defineAction({
	name: "set_gifts",
	title: "Set a newsletter's gifts",
	group: GROUP,
	description: `Turns gift subscriptions on or off for a newsletter. ${HOW_IT_WORKS} The gift page is /give on the newsletter's site, linked from the subscribe page; it needs the paid tier open and a Stripe account that can take payments. ${NO_CUT}`,
	http: { method: "PATCH", path: "/newsletters/{id}/gifts" },
	idempotent: true,
	example: { enabled: true },
	input: z.object({ id: newsletterId, enabled: z.boolean().describe("Let readers buy gifts") }),
	output: SettingsSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		if (input.enabled) assertPaymentsReady(account);
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { "paidTier.gifts.enabled": input.enabled } });
		revalidateShop();
		return toSettings({ ...newsletter, paidTier: { ...newsletter.paidTier, gifts: { enabled: input.enabled } } });
	},
});

const listGifts = defineAction({
	name: "list_gifts",
	title: "List gifts",
	group: GROUP,
	description: `Lists the gifts bought for a newsletter, newest first, 50 a page: who bought, who it is for, the message, when it is sent, and whether it was redeemed. Unredeemed gifts show when they expire. ${HOW_IT_WORKS} Pass nextCursor back as cursor for the next page.`,
	http: { method: "GET", path: "/newsletters/{id}/gifts" },
	readOnly: true,
	example: { status: "sent" },
	input: z.object({
		id: newsletterId,
		status: z.enum(GIFT_STATES).optional().describe("Only gifts in this state"),
		limit: z.number().int().min(1).max(100).optional().describe("Gifts per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({ settings: SettingsSchema, gifts: z.array(GiftSchema), nextCursor: z.string().nullable().describe("null on the last page") }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const limit = input.limit ?? 50;
		const filter = scoped(account, {
			newsletterId: newsletter._id,
			status: input.status ?? { $ne: "awaiting_payment" },
			...(input.cursor && afterCursor(input.cursor, "createdAt")),
		});
		const gifts = await Gift.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
		const page = gifts.slice(0, limit);
		const last = page.at(-1);
		const tiers = getNewsletterTiers(newsletter);
		return { settings: toSettings(newsletter), gifts: page.map((gift) => toGift(gift, tiers)), nextCursor: gifts.length > limit ? encodeCursor(last.createdAt, last._id) : null };
	},
});

const resendGiftAction = defineAction({
	name: "resend_gift",
	title: "Resend a gift's email",
	group: GROUP,
	description: "Sends a gift's email to its recipient again, or to another address when the first didn't reach them. Only a gift that hasn't been redeemed, refunded or expired can be sent; it goes out now, whatever its delivery day was.",
	http: { method: "POST", path: "/gifts/{id}/resend" },
	openWorld: true,
	input: z.object({
		id: z.string().trim().min(1).max(100).describe("The gift's ID"),
		recipientEmail: z.string().trim().max(254).optional().describe("Send it to this address instead, which then is the gift's recipient"),
	}),
	output: GiftSchema,
	handler: async ({ account, input }) => {
		const gift = isObjectIdString(input.id) ? await Gift.findOne(scoped(account, { _id: input.id })).lean() : null;
		if (!gift || gift.status === "awaiting_payment") throw actionError("not_found", "Gift not found");
		if (!["paid", "sent"].includes(getGiftState(gift))) throw actionError("conflict", "This gift can't be sent again: it was redeemed, refunded or has expired");
		const result = await resendGift({ account, gift, recipientEmail: input.recipientEmail });
		if (result.sent === false) throw actionError("send_check_failed", `The email wasn't sent: ${result.reason}`);
		const fresh = await Gift.findOne(scoped(account, { _id: gift._id })).lean();
		const newsletter = await Newsletter.findOne(scoped(account, { _id: gift.newsletterId })).lean();
		return toGift(fresh, getNewsletterTiers(newsletter));
	},
});

export const giftActions = [setGifts, listGifts, resendGiftAction];
