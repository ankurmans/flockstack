import { toFieldValues } from "@/lib/custom-fields";
import { getAccessEnd } from "@/lib/grants";
import { getContactTierId } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";

// Every event an endpoint can take, in the order the docs and the dashboard list them. A new event is a type here with its
// example, and one emitWebhookEvent call where it happens (lib/webhooks.js): the actions' enum, the docs, the Zapier and
// Make apps' lists and the tests read this list.
const SUBSCRIBER_EXAMPLE = {
	id: "6650f1c2e9b1d4a012345678",
	newsletterId: "6650f1c2e9b1d4a0123456aa",
	email: "jane@example.com",
	status: "active",
	source: "website",
	tier: "free",
	paidTierId: null,
	paidUntil: null,
	tags: ["podcast"],
	fields: { first_name: "Jane" },
	subscribedAt: "2026-10-20T09:30:00.000Z",
	confirmedAt: null,
	unsubscribedAt: null,
};

export const WEBHOOK_EVENTS = [
	{
		type: "subscriber.created",
		title: "New subscriber",
		description: "Someone signed up, was added or came back after unsubscribing. status is pending until they confirm, on a newsletter that asks.",
		example: { subscriber: SUBSCRIBER_EXAMPLE, resubscribed: false },
	},
	{
		type: "subscriber.confirmed",
		title: "Subscriber confirmed",
		description: "A pending subscriber clicked the link in the confirmation email.",
		example: { subscriber: { ...SUBSCRIBER_EXAMPLE, confirmedAt: "2026-10-20T09:32:00.000Z" } },
	},
	{
		type: "subscriber.unsubscribed",
		title: "Subscriber unsubscribed",
		description: "A subscriber unsubscribed: from a link in an email, their mail app's button, or on the dashboard or API.",
		example: { subscriber: { ...SUBSCRIBER_EXAMPLE, status: "unsubscribed", unsubscribedAt: "2026-10-21T08:00:00.000Z" } },
	},
	{
		type: "subscriber.updated",
		title: "Subscriber updated",
		description: "A subscriber's tags or custom fields changed. changes says which.",
		example: {
			subscriber: { ...SUBSCRIBER_EXAMPLE, tags: ["podcast", "vip"] },
			changes: { tagsAdded: ["vip"], tagsRemoved: [], fields: [] },
		},
	},
	{
		type: "subscriber.upgraded",
		title: "Subscriber upgraded to paid",
		description:
			"A reader started a paid subscription, or their trial began, or was given paid access (a comp or a gift). tier is the paid tier they hold; interval is month, quarter, year or lifetime, and null for a comp or a gift; source is stripe, pledge (a converted pledge), comp or gift.",
		example: {
			subscriber: { ...SUBSCRIBER_EXAMPLE, tier: "paid", paidTierId: "t_k3m9x2ab", paidUntil: "2026-11-20T09:30:00.000Z" },
			interval: "month",
			tier: { id: "t_k3m9x2ab", name: "Supporter" },
			source: "stripe",
		},
	},
	{
		type: "subscriber.downgraded",
		title: "Subscriber downgraded to free",
		description: "A paid reader's subscription ended or stopped paying, or a comp or a gift ran out or was taken away: they get free issues from now on. tier is the paid tier they held.",
		example: { subscriber: SUBSCRIBER_EXAMPLE, subscriptionStatus: "canceled", tier: { id: "t_k3m9x2ab", name: "Supporter" }, source: "stripe" },
	},
	{
		type: "campaign.sent",
		title: "Campaign sent",
		description: "A campaign finished going out. A campaign sent in steps sends this after each step.",
		example: {
			campaign: {
				id: "6650f1c2e9b1d4a0123456bb",
				newsletterId: "6650f1c2e9b1d4a0123456aa",
				subject: "Issue 12: the long weekend",
				previewText: "Three things worth your time",
				audience: "all",
				archiveUrl: "https://your-slug.example.com/p/issue-12",
				sentAt: "2026-10-20T07:00:00.000Z",
				finishedAt: "2026-10-20T07:12:00.000Z",
				stats: { recipients: 4210, sent: 4208 },
			},
		},
	},
	{
		type: "order.paid",
		title: "Order paid",
		description: "A reader paid for a digital product.",
		example: {
			order: {
				id: "6650f1c2e9b1d4a0123456cc",
				newsletterId: "6650f1c2e9b1d4a0123456aa",
				productId: "6650f1c2e9b1d4a0123456dd",
				productTitle: "The freelancer's pricing workbook",
				buyerEmail: "sam@example.com",
				buyerName: "Sam Rivera",
				amountCents: 1900,
				currency: "usd",
				paidAt: "2026-10-20T10:05:00.000Z",
			},
		},
	},
];

export const WEBHOOK_EVENT_TYPES = WEBHOOK_EVENTS.map(({ type }) => type);
// Sent by "Send a test event": never by FlockStack on its own, and an endpoint takes it whatever its events.
export const TEST_EVENT_TYPE = "webhook.test";

export function getWebhookEvent(type) {
	return WEBHOOK_EVENTS.find((event) => event.type === type) ?? null;
}

// The body of every delivery: what happened, when, and its data.
export function buildWebhookBody({ type, data, timestamp = new Date() }) {
	return JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), data });
}

// What a change did to a contact's tags and custom fields: before and after as stored.
export function getContactChanges(before, after) {
	const had = new Set(before?.tags ?? []);
	const has = new Set(after?.tags ?? []);
	const oldFields = before?.fields ?? {};
	const newFields = after?.fields ?? {};
	return {
		tagsAdded: [...has].filter((tag) => !had.has(tag)),
		tagsRemoved: [...had].filter((tag) => !has.has(tag)),
		fields: [...new Set([...Object.keys(oldFields), ...Object.keys(newFields)])].filter((key) => oldFields[key] !== newFields[key]).sort(),
	};
}

function toIso(value) {
	return value ? new Date(value).toISOString() : null;
}

// The same fields, by the same names, as the API's contacts (lib/actions/contacts.js), without the engagement numbers.
export function toSubscriberData(contact) {
	const isPaid = isPaidContact(contact);
	return {
		id: String(contact._id),
		newsletterId: String(contact.newsletterId),
		email: contact.email,
		status: contact.status,
		source: contact.source ?? null,
		tier: isPaid ? "paid" : "free",
		paidTierId: isPaid ? getContactTierId(contact) : null,
		paidUntil: isPaid ? toIso(getAccessEnd(contact)) : null,
		tags: contact.tags ?? [],
		fields: toFieldValues(contact),
		subscribedAt: toIso(contact.subscribedAt),
		confirmedAt: toIso(contact.confirmedAt),
		unsubscribedAt: toIso(contact.unsubscribedAt),
	};
}

export function toCampaignData(campaign, archiveUrl = null) {
	return {
		id: String(campaign._id),
		newsletterId: String(campaign.newsletterId),
		subject: campaign.subject ?? "",
		previewText: campaign.previewText ?? "",
		audience: campaign.audience ?? "all",
		archiveUrl,
		sentAt: toIso(campaign.sentAt),
		finishedAt: toIso(campaign.finishedAt),
		stats: { recipients: campaign.stats?.recipients ?? 0, sent: campaign.stats?.sent ?? 0 },
	};
}

export function toOrderData(order) {
	return {
		id: String(order._id),
		newsletterId: String(order.newsletterId),
		productId: String(order.productId),
		productTitle: order.productTitle,
		buyerEmail: order.buyerEmail,
		buyerName: order.buyerName ?? null,
		amountCents: order.amountCents,
		currency: order.currency,
		paidAt: toIso(order.paidAt),
	};
}
