import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, idInput, newsletterInput } from "@/lib/actions/shared";
import { getAppUrl } from "@/lib/config";
import { createGroupPortal, listGroupInvoices, refreshGroupBilling } from "@/lib/group-billing";
import { groupOutput, groupSettingsOutput } from "@/lib/group-output";
import { inviteGroupSeat, revokeGroupSeat, sendGroupManagerLink } from "@/lib/group-seats";
import { createGroupCheckout, groupSettings, saveGroupSettings } from "@/lib/group-subscriptions";
import { findGroup } from "@/lib/group-store";
import GroupSubscription from "@/models/GroupSubscription";

const group = "Group subscriptions";
const id = idInput("group subscription");
const email = z.email().max(320).describe("The buyer or invited recipient email address");
const option = z.enum(["month", "quarter", "year"]).describe("The regular recurring billing interval: monthly, every three months, or yearly");
const settingsSchema = z.object({ newsletterId: z.string(), enabled: z.boolean(), available: z.boolean(), problem: z.string().nullable(), minSeats: z.number().int(), maxSeats: z.number().int(), buyUrl: z.string(), plans: z.array(z.object({ tierId: z.string(), name: z.string(), option, unitAmountCents: z.number().int(), currency: z.string() })) });
const groupSchema = z.object({ id: z.string(), newsletterId: z.string(), tierId: z.string(), option, buyerEmail: z.string(), status: z.enum(["checkout", "active", "canceled"]), subscriptionStatus: z.string().nullable(), requestedSeats: z.number().int(), capacity: z.number().int(), paidUntil: dateOutput, observedAt: dateOutput, billingProblem: z.string().nullable(), createdAt: dateOutput, seats: z.array(z.object({ id: z.string(), email: z.string().nullable(), status: z.enum(["invited", "accepting", "active", "revoked"]), withinPaidCapacity: z.boolean(), invitedAt: dateOutput, invitationSentAt: dateOutput, acceptedAt: dateOutput })) });

const getSettings = defineAction({
	name: "get_group_settings", title: "Get group settings", group,
	description: "Reads whether group subscriptions are open and their regular per-seat recurring plans. Group buying does not enroll readers or change individual billing. Each recipient must accept their own emailed invitation. FlockStack takes no application fee.",
	http: { method: "GET", path: "/newsletters/{id}/groups/settings" }, readOnly: true,
	input: z.object({ id: idInput("newsletter") }), output: settingsSchema,
	handler: async ({ account, input }) => { const newsletter = await findNewsletter(account, input.id); return groupSettingsOutput(groupSettings(account, newsletter), newsletter); },
});
const setSettings = defineAction({
	name: "set_group_subscriptions", title: "Set group subscriptions", group,
	description: "Explicitly opens or closes new group purchases at the newsletter's existing regular recurring per-seat prices. Supports 2 to 100 seats, with no inherited individual trials, offers, founding caps or lifetime plan. Closing buying leaves existing group billing and seat management available.",
	http: { method: "PATCH", path: "/newsletters/{id}/groups/settings" }, idempotent: true,
	input: z.object({ id: idInput("newsletter"), enabled: z.boolean().describe("Whether to accept new group purchases") }), output: settingsSchema,
	handler: async ({ account, input }) => { const newsletter = await findNewsletter(account, input.id); return groupSettingsOutput(await saveGroupSettings(account, newsletter, input.enabled), newsletter); },
});
const list = defineAction({
	name: "list_group_subscriptions", title: "List group subscriptions", group,
	description: "Lists this newsletter's group buyers and current seat records, newest first. Capacity is from last observed funded billing, subject to paidUntil. Reads local records only; use refresh_group_subscription to read Stripe. No private manager or invitation capability is returned.",
	http: { method: "GET", path: "/groups" }, readOnly: true,
	input: z.object({ newsletter: newsletterInput, cursor: z.string().max(250).optional().describe("The next cursor from the previous page"), limit: z.number().int().min(1).max(50).default(20).describe("Groups per page, up to 50") }), output: z.object({ groups: z.array(groupSchema), nextCursor: z.string().nullable() }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const rows = await GroupSubscription.find(scoped(account, { newsletterId: newsletter._id, ...(input.cursor && afterCursor(input.cursor, "createdAt")) })).sort({ createdAt: -1, _id: -1 }).limit(input.limit + 1).lean();
		const page = rows.slice(0, input.limit);
		return { groups: page.map(groupOutput), nextCursor: rows.length > input.limit ? encodeCursor(page.at(-1).createdAt, page.at(-1)._id) : null };
	},
});
const get = defineAction({
	name: "get_group_subscription", title: "Get group subscription", group,
	description: "Reads one local group buyer, billing observation and current seat records. A funded position does not imply the recipient is an active subscriber; paid access is checked against current reader status and parent billing. No private signed capability is returned.",
	http: { method: "GET", path: "/groups/{id}" }, readOnly: true, input: z.object({ id }), output: groupSchema,
	handler: async ({ account, input }) => groupOutput(await findGroup(account, input.id)),
});
const refresh = defineAction({
	name: "refresh_group_subscription", title: "Refresh group billing", group,
	description: "Reads current group subscription, customer and latest invoice from your Stripe account, validates ownership, and updates funded seats and reader access. Only a paid matching recurring invoice extends access; an unpaid quantity increase cannot add seats. Does not charge, cancel or enroll readers. Stores financial observations. Provider reads can fail; last funded expiry remains finite.",
	http: { method: "POST", path: "/groups/{id}/refresh" }, openWorld: true, idempotent: true, whileBlocked: true, rateLimit: { limit: 60, window: "1 h" }, input: z.object({ id }), output: groupSchema,
	handler: async ({ account, input }) => groupOutput(await refreshGroupBilling({ account, groupId: input.id })),
});
const checkout = defineAction({
	name: "create_group_checkout", title: "Create group checkout", group,
	description: "Creates a Stripe Checkout link for one newsletter group, billed at a fixed recurring creator price times 2 to 100 licensed seats. The buyer still confirms payment in Stripe. Use a stable UUID externalId for retries; changing its buyer, plan or quantity is refused. No automatic newsletter signup, individual subscription cancellation or application fee. Unknown outcomes older than 23 hours require review.",
	http: { method: "POST", path: "/groups/checkout" }, openWorld: true, idempotent: true, rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ newsletter: newsletterInput, tierId: z.string().min(1).max(80).describe("The existing recurring tier ID"), option, email, seats: z.number().int().min(2).max(100).describe("Licensed seat quantity, from 2 to 100"), externalId: z.uuid().describe("A stable UUID for this checkout and every retry") }), output: z.object({ id: z.string(), checkoutUrl: z.string() }),
	handler: async ({ account, input }) => createGroupCheckout({ account, newsletter: await findNewsletter(account, input.newsletter), input }),
});
const invite = defineAction({
	name: "invite_group_seat", title: "Invite group reader", group,
	description: "Reserves one currently funded seat with a revision check and emails only that recipient their private 7-day acceptance link. Invitation does not subscribe anyone. A repeat for an invited reader reissues its link after a minute; an accepted seat must be revoked first. Provider delivery is best effort, not an exactly-once guarantee. Reports sent only when the provider accepts the email.",
	http: { method: "POST", path: "/groups/{id}/seats" }, openWorld: true, rateLimit: { limit: 100, window: "1 h" }, input: z.object({ id, email }), output: z.object({ id: z.string(), email: z.string(), status: z.literal("invited"), sent: z.boolean() }),
	handler: async ({ account, input }) => inviteGroupSeat({ account, groupId: input.id, email: input.email }),
});
const revoke = defineAction({
	name: "revoke_group_seat", title: "Revoke group seat", group,
	description: "Revokes this reader's group seat and old invitation capability, then recomputes their access from remaining group, personal and gift sources. Does not unsubscribe them or cancel individual billing. Repeating a revocation changes nothing.",
	http: { method: "POST", path: "/groups/{id}/seats/revoke" }, destructive: true, idempotent: true, whileBlocked: true,
	input: z.object({ id, seatId: z.uuid().describe("The current group seat ID") }), output: z.object({ id: z.string(), revoked: z.boolean() }),
	handler: async ({ account, input }) => revokeGroupSeat({ account, groupId: input.id, seatId: input.seatId }),
});
const managerLink = defineAction({
	name: "send_group_manager_link", title: "Email group manager link", group,
	description: "Emails a private 7-day management capability only to the group's verified Stripe buyer. Never returns the capability to an agent. rotate=true revokes every older management link first. Does not transfer the buyer identity when a Stripe customer's email changes later.",
	http: { method: "POST", path: "/groups/{id}/manager-email" }, openWorld: true, rateLimit: { limit: 30, window: "1 h" }, input: z.object({ id, rotate: z.boolean().default(false).describe("Revoke every older manager link before emailing a new one") }), output: z.object({ sent: z.boolean(), alreadySent: z.boolean().optional() }),
	handler: async ({ account, input }) => sendGroupManagerLink({ account, groupId: input.id, rotate: input.rotate }),
});
const invoices = defineAction({
	name: "list_group_invoices", title: "List group invoices", group,
	description: "Reads up to 25 actual invoices from the group's separate Stripe customer and subscription. Returns observed currency, status, amounts in minor units and invoice links. Missing amounts stay null; an invoice marked paid is not a payout or net cash report. The next cursor continues this group's invoices only.",
	http: { method: "GET", path: "/groups/{id}/invoices" }, readOnly: true, openWorld: true, rateLimit: { limit: 60, window: "1 h" },
	input: z.object({ id, after: z.string().max(180).optional().describe("The invoice cursor from the previous page") }), output: z.object({ invoices: z.array(z.object({ id: z.string(), number: z.string().nullable(), status: z.string().nullable(), currency: z.string().nullable(), totalMinor: z.number().nullable(), amountPaidMinor: z.number().nullable(), amountDueMinor: z.number().nullable(), createdAt: dateOutput, paidAt: dateOutput, hostedUrl: z.string().nullable(), pdfUrl: z.string().nullable() })), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
	handler: async ({ account, input }) => listGroupInvoices({ account, groupId: input.id, after: input.after }),
});
const portal = defineAction({
	name: "open_group_billing_portal", title: "Open group billing", group,
	description: "Explicitly opens the group's separate Stripe customer portal for invoices, card updates and cancellation at period end. Creates its own restrictive configuration; never changes your default portal. Group plan/quantity and customer email changes are disabled. Does not charge or cancel by itself.",
	http: { method: "POST", path: "/groups/{id}/billing" }, openWorld: true, whileBlocked: true, rateLimit: { limit: 30, window: "1 h" }, input: z.object({ id }), output: z.object({ url: z.string() }),
	handler: async ({ account, input }) => createGroupPortal({ account, groupId: input.id, returnUrl: `${getAppUrl()}/group-subscriptions/${encodeURIComponent(input.id)}` }),
});
export const groupSubscriptionActions = [getSettings, setSettings, list, get, refresh, checkout, invite, revoke, managerLink, invoices, portal];
