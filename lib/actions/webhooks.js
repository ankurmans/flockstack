import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, toIso } from "@/lib/actions/shared";
import { getWebhookEndpointLimit } from "@/lib/plans";
import { isObjectIdString } from "@/lib/validation";
import { WEBHOOK_EVENT_TYPES } from "@/lib/webhook-events";
import { generateWebhookSecret } from "@/lib/webhook-signing";
import { MAX_WEBHOOK_URL_LENGTH, getWebhookUrlProblem, normalizeWebhookUrl } from "@/lib/webhook-url";
import { MAX_DELIVERIES_PER_ENDPOINT, PREVIOUS_SECRET_MS } from "@/lib/webhook-rules";
import { resendDelivery, sendTestEvent } from "@/lib/webhooks";
import WebhookDelivery, { WEBHOOK_DELIVERY_STATUSES } from "@/models/WebhookDelivery";
import WebhookEndpoint from "@/models/WebhookEndpoint";

const GROUP = "Webhooks";

const urlInput = z.string().trim().min(1).max(MAX_WEBHOOK_URL_LENGTH).describe("Where events are POSTed: https, on the default port, at a public address");
const descriptionInput = z.string().trim().max(200).describe("What it's for, e.g. CRM sync");
const eventsInput = z
	.array(z.enum(WEBHOOK_EVENT_TYPES))
	.max(WEBHOOK_EVENT_TYPES.length)
	.describe(`The events it takes: ${WEBHOOK_EVENT_TYPES.join(", ")}. Empty takes every event, new ones included.`);

const WebhookEndpointSchema = z.object({
	id: z.string(),
	url: z.string(),
	description: z.string(),
	events: z.array(z.string()).describe("The events it takes; empty means every event"),
	newsletterId: z.string().nullable().describe("Only this newsletter's events; null for every newsletter of the account"),
	enabled: z.boolean().describe("false: nothing is sent to it"),
	disabledReason: z.string().nullable().describe("Why FlockStack turned it off, when it did: failing for 5 days, or a 410 Gone"),
	disabledAt: dateOutput,
	failingSince: dateOutput.describe("The first failed attempt since the last success; null while it works"),
	lastSuccessAt: dateOutput,
	lastFailureAt: dateOutput,
	source: z.string().nullable().describe("What made it: dashboard, api, zapier, make…"),
	createdAt: dateOutput,
});

const WebhookDeliverySchema = z.object({
	id: z.string(),
	endpointId: z.string(),
	messageId: z.string().describe("The webhook-id header: the same for every retry and resend of an event"),
	type: z.string(),
	status: z.enum(WEBHOOK_DELIVERY_STATUSES).describe("pending: on its way or waiting for a retry. delivered: answered 2xx. failed: given up."),
	test: z.boolean(),
	attempts: z.number().int(),
	lastAttemptAt: dateOutput,
	nextAttemptAt: dateOutput.describe("When the next retry goes, while pending"),
	deliveredAt: dateOutput,
	responseStatus: z.number().int().nullable().describe("The status code of the last attempt's answer"),
	responseBody: z.string().nullable().describe("The start of the last answer's body, 500 characters at most"),
	error: z.string().nullable(),
	payload: z.string().describe("The JSON body, exactly as sent and signed"),
	createdAt: dateOutput,
});

const SecretOutput = z.string().describe("The signing secret, whsec_ and base64. Store it now: it isn't shown again.");

function toEndpoint(endpoint) {
	return {
		id: String(endpoint._id),
		url: endpoint.url,
		description: endpoint.description ?? "",
		events: endpoint.events ?? [],
		newsletterId: endpoint.newsletterId ? String(endpoint.newsletterId) : null,
		enabled: endpoint.enabled !== false,
		disabledReason: endpoint.disabledReason ?? null,
		disabledAt: toIso(endpoint.disabledAt),
		failingSince: toIso(endpoint.failingSince),
		lastSuccessAt: toIso(endpoint.lastSuccessAt),
		lastFailureAt: toIso(endpoint.lastFailureAt),
		source: endpoint.source ?? null,
		createdAt: toIso(endpoint.createdAt),
	};
}

function toDelivery(delivery) {
	return {
		id: String(delivery._id),
		endpointId: String(delivery.endpointId),
		messageId: delivery.messageId,
		type: delivery.type,
		status: delivery.status,
		test: Boolean(delivery.test),
		attempts: delivery.attempts ?? 0,
		lastAttemptAt: toIso(delivery.lastAttemptAt),
		nextAttemptAt: delivery.status === "pending" ? toIso(delivery.nextAttemptAt) : null,
		deliveredAt: toIso(delivery.deliveredAt),
		responseStatus: delivery.responseStatus ?? null,
		responseBody: delivery.responseBody ?? null,
		error: delivery.error ?? null,
		payload: delivery.payload,
		createdAt: toIso(delivery.createdAt),
	};
}

async function findEndpoint(account, id) {
	const endpoint = isObjectIdString(id) ? await WebhookEndpoint.findOne(scoped(account, { _id: id })).lean() : null;
	if (!endpoint) throw actionError("not_found", "Webhook endpoint not found");
	return endpoint;
}

function readUrl(value) {
	const problem = getWebhookUrlProblem(value);
	if (problem) throw actionError("validation_failed", `url: ${problem}`);
	return normalizeWebhookUrl(value);
}

// Each event once, in the catalog's order.
function readEvents(events) {
	return WEBHOOK_EVENT_TYPES.filter((type) => events.includes(type));
}

const listEndpoints = defineAction({
	name: "list_webhook_endpoints",
	tryWithoutPlan: true,
	title: "List webhook endpoints",
	group: GROUP,
	description: "Lists the account's webhook endpoints, newest first, with whether each is on and when it last worked or failed. Secrets are never shown again.",
	http: { method: "GET", path: "/webhooks" },
	readOnly: true,
	output: z.object({
		endpoints: z.array(WebhookEndpointSchema),
		limit: z.number().int().nullable().describe("How many endpoints the plan allows; null on a self-hosted server: no limit"),
	}),
	handler: async ({ account }) => {
		const endpoints = await WebhookEndpoint.find(scoped(account)).sort({ createdAt: -1, _id: -1 }).lean();
		return { endpoints: endpoints.map(toEndpoint), limit: getWebhookEndpointLimit(account) };
	},
});

const getEndpoint = defineAction({
	name: "get_webhook_endpoint",
	tryWithoutPlan: true,
	title: "Get a webhook endpoint",
	group: GROUP,
	description: "Gets one webhook endpoint by ID: its address, events, newsletter and state. The secret isn't shown: rotate it to get a new one.",
	http: { method: "GET", path: "/webhooks/{id}" },
	readOnly: true,
	input: z.object({ id: idInput("endpoint") }),
	output: WebhookEndpointSchema,
	handler: async ({ account, input }) => toEndpoint(await findEndpoint(account, input.id)),
});

const createEndpoint = defineAction({
	name: "create_webhook_endpoint",
	title: "Create a webhook endpoint",
	group: GROUP,
	description:
		"Adds an address that FlockStack POSTs events to, signed with the Standard Webhooks scheme, and returns its signing secret once. Failed deliveries are retried for about 5 days; an endpoint failing that long is turned off and the owner emailed. Each plan has a number of endpoints, and one more answers conflict. Zapier and Make subscribe with this action and unsubscribe with delete_webhook_endpoint.",
	http: { method: "POST", path: "/webhooks", status: 201 },
	rateLimit: { limit: 30, window: "1 h" },
	example: { url: "https://example.com/flockstack-events", description: "CRM sync", events: ["subscriber.created", "subscriber.unsubscribed"] },
	input: z.object({
		url: urlInput,
		description: descriptionInput.optional(),
		events: eventsInput.optional(),
		newsletter: z.string().trim().min(1).max(100).optional().describe("Only this newsletter's events: its ID or slug. Default: every newsletter."),
		source: z.string().trim().max(40).optional().describe("What is making it, e.g. zapier, shown on the dashboard. Default: api."),
	}),
	output: z.object({ endpoint: WebhookEndpointSchema, secret: SecretOutput }),
	handler: async ({ account, input, via }) => {
		const url = readUrl(input.url);
		const limit = getWebhookEndpointLimit(account);
		if (limit !== null && (await WebhookEndpoint.countDocuments(scoped(account))) >= limit) {
			throw actionError("conflict", `Your plan has up to ${limit} webhook endpoints. Delete one you don't use, or move to a bigger plan.`);
		}
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const secret = generateWebhookSecret();
		const created = await WebhookEndpoint.create({
			accountId: account._id,
			url,
			description: input.description ?? "",
			events: readEvents(input.events ?? []),
			...(newsletter && { newsletterId: newsletter._id }),
			secret,
			enabled: true,
			source: via === "dashboard" ? "dashboard" : input.source || via,
		});
		return { endpoint: toEndpoint(created.toObject()), secret };
	},
});

const updateEndpoint = defineAction({
	name: "update_webhook_endpoint",
	title: "Update a webhook endpoint",
	group: GROUP,
	description:
		"Changes an endpoint's address, description, events or newsletter, or turns it off and on. Turning back on an endpoint FlockStack turned off starts its failure count over; events from while it was off aren't sent on their own, resend them from its deliveries.",
	http: { method: "PATCH", path: "/webhooks/{id}" },
	idempotent: true,
	example: { enabled: true },
	input: z.object({
		id: idInput("endpoint"),
		url: urlInput.optional(),
		description: descriptionInput.optional(),
		events: eventsInput.optional(),
		newsletter: z.string().trim().max(100).nullable().optional().describe("Only this newsletter's events: its ID or slug. null for every newsletter."),
		enabled: z.boolean().optional().describe("false stops sending to it; true sends again"),
	}),
	output: WebhookEndpointSchema,
	handler: async ({ account, input }) => {
		const endpoint = await findEndpoint(account, input.id);
		const set = {};
		const unset = {};
		if (input.url !== undefined) set.url = readUrl(input.url);
		if (input.description !== undefined) set.description = input.description;
		if (input.events !== undefined) set.events = readEvents(input.events);
		if (input.newsletter === null || input.newsletter === "") unset.newsletterId = 1;
		else if (input.newsletter !== undefined) set.newsletterId = (await findNewsletter(account, input.newsletter, { _id: 1 }))._id;
		if (input.enabled === false) set.enabled = false;
		if (input.enabled === true && endpoint.enabled === false) {
			set.enabled = true;
			Object.assign(unset, { disabledReason: 1, disabledAt: 1, failingSince: 1 });
		}
		if (Object.keys(set).length > 0 || Object.keys(unset).length > 0) {
			await WebhookEndpoint.updateOne(scoped(account, { _id: endpoint._id }), {
				...(Object.keys(set).length > 0 && { $set: set }),
				...(Object.keys(unset).length > 0 && { $unset: unset }),
			});
		}
		return toEndpoint(await findEndpoint(account, input.id));
	},
});

const deleteEndpoint = defineAction({
	name: "delete_webhook_endpoint",
	title: "Delete a webhook endpoint",
	group: GROUP,
	description: "Deletes an endpoint and its delivery log. Nothing is sent to it from now on, retries included. It can't be undone.",
	http: { method: "DELETE", path: "/webhooks/{id}" },
	destructive: true,
	idempotent: true,
	whileBlocked: true,
	tryWithoutPlan: true,
	input: z.object({ id: idInput("endpoint") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const endpoint = await findEndpoint(account, input.id);
		await WebhookEndpoint.deleteOne(scoped(account, { _id: endpoint._id }));
		await WebhookDelivery.deleteMany(scoped(account, { endpointId: endpoint._id }));
		return { id: String(endpoint._id), deleted: true };
	},
});

const rotateSecret = defineAction({
	name: "rotate_webhook_secret",
	title: "Rotate a webhook secret",
	group: GROUP,
	description:
		"Makes a new signing secret and returns it once. For the next 24 hours events carry two signatures, one with each secret, so the receiver can switch without rejecting any; after that only the new one signs.",
	http: { method: "POST", path: "/webhooks/{id}/rotate-secret" },
	rateLimit: { limit: 10, window: "1 h" },
	input: z.object({ id: idInput("endpoint") }),
	output: z.object({ endpoint: WebhookEndpointSchema, secret: SecretOutput, previousSecretUntil: z.string().describe("When the old secret stops signing") }),
	handler: async ({ account, input }) => {
		const endpoint = await findEndpoint(account, input.id);
		const secret = generateWebhookSecret();
		const previousSecretUntil = new Date(Date.now() + PREVIOUS_SECRET_MS);
		await WebhookEndpoint.updateOne(scoped(account, { _id: endpoint._id }), { $set: { secret, previousSecret: endpoint.secret, previousSecretUntil } });
		return { endpoint: toEndpoint(await findEndpoint(account, input.id)), secret, previousSecretUntil: previousSecretUntil.toISOString() };
	},
});

const sendTest = defineAction({
	name: "send_test_webhook",
	title: "Send a test event",
	group: GROUP,
	description:
		"Sends a webhook.test event to the endpoint, signed like any other, even while it is turned off. It is tried once, never retried, and doesn't count toward turning the endpoint off. The delivery's result shows in list_webhook_deliveries a few seconds later.",
	http: { method: "POST", path: "/webhooks/{id}/test" },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ id: idInput("endpoint") }),
	output: z.object({ delivery: WebhookDeliverySchema }),
	handler: async ({ account, input }) => {
		const endpoint = await findEndpoint(account, input.id);
		try {
			return { delivery: toDelivery(await sendTestEvent(endpoint)) };
		} catch (error) {
			throw actionError("unavailable", `Could not queue the test event: ${error?.message ?? error}`);
		}
	},
});

const listDeliveries = defineAction({
	name: "list_webhook_deliveries",
	tryWithoutPlan: true,
	title: "List webhook deliveries",
	group: GROUP,
	description: `Lists an endpoint's latest deliveries, newest first, with each one's status, attempts, the last answer and the body sent. Only the latest ${MAX_DELIVERIES_PER_ENDPOINT} of an endpoint are kept.`,
	http: { method: "GET", path: "/webhooks/{id}/deliveries" },
	readOnly: true,
	example: { status: "failed" },
	input: z.object({
		id: idInput("endpoint"),
		status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional().describe("Only deliveries with this status"),
		limit: z.number().int().min(1).max(MAX_DELIVERIES_PER_ENDPOINT).optional().describe(`Deliveries to return, 50 by default, ${MAX_DELIVERIES_PER_ENDPOINT} at most`),
	}),
	output: z.object({ deliveries: z.array(WebhookDeliverySchema) }),
	handler: async ({ account, input }) => {
		const endpoint = await findEndpoint(account, input.id);
		const deliveries = await WebhookDelivery.find(scoped(account, { endpointId: endpoint._id, ...(input.status && { status: input.status }) }))
			.sort({ createdAt: -1, _id: -1 })
			.limit(input.limit ?? 50)
			.lean();
		return { deliveries: deliveries.map(toDelivery) };
	},
});

const resend = defineAction({
	name: "resend_webhook_delivery",
	title: "Resend a webhook delivery",
	group: GROUP,
	description:
		"Sends a delivery's event to its endpoint again, as a new delivery with the same body and webhook-id, retried like any other. For events missed while an endpoint was down or turned off; the endpoint has to be on.",
	http: { method: "POST", path: "/webhooks/{id}/deliveries/{deliveryId}/resend" },
	openWorld: true,
	rateLimit: { limit: 120, window: "1 h" },
	input: z.object({ id: idInput("endpoint"), deliveryId: idInput("delivery") }),
	output: z.object({ delivery: WebhookDeliverySchema }),
	handler: async ({ account, input }) => {
		const endpoint = await findEndpoint(account, input.id);
		const delivery = isObjectIdString(input.deliveryId)
			? await WebhookDelivery.findOne(scoped(account, { _id: input.deliveryId, endpointId: endpoint._id })).lean()
			: null;
		if (!delivery) throw actionError("not_found", "Delivery not found");
		if (!endpoint.enabled && !delivery.test) throw actionError("conflict", "Turn the endpoint on first");
		try {
			return { delivery: toDelivery(await resendDelivery(endpoint, delivery)) };
		} catch (error) {
			throw actionError("unavailable", `Could not queue the delivery: ${error?.message ?? error}`);
		}
	},
});

export const webhookActions = [listEndpoints, getEndpoint, createEndpoint, updateEndpoint, deleteEndpoint, rotateSecret, sendTest, listDeliveries, resend];
