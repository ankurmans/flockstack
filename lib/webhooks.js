import "server-only";
import { scoped } from "@/lib/account-scope";
import { hasActiveSubscription } from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { getIssuePageUrl } from "@/lib/archive-data";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { ObjectId } from "@/lib/docdb";
import { publishJob } from "@/lib/sending";
import { TEST_EVENT_TYPE, buildWebhookBody, toCampaignData, toOrderData, toSubscriberData } from "@/lib/webhook-events";
import { getWebhookHeaders } from "@/lib/webhook-signing";
import { MAX_ATTEMPTS, MAX_DELIVERIES_PER_ENDPOINT, RETRY_DELAYS_SECONDS, TIMEOUT_MS, WEBHOOK_DISABLE_AFTER_MS } from "@/lib/webhook-rules";
import { getWebhookUrlProblem } from "@/lib/webhook-url";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import WebhookDelivery from "@/models/WebhookDelivery";
import WebhookEndpoint from "@/models/WebhookEndpoint";

const RESPONSE_BODY_CHARS = 500;
// An attempt claimed this long ago that never finished (the Worker was cut off) can be taken again by QStash's retry.
const STALE_CLAIM_MS = 2 * 60_000;
const USER_AGENT = "FlockStack-Webhooks/1.0 (+https://flockstack.io/docs/webhooks)";

function getJobUrl() {
	return `${getAppUrl()}/api/jobs/deliver-webhook`;
}

export function newMessageId() {
	return `msg_${new ObjectId().toString()}`;
}

// An endpoint takes an event when it lists the type (or lists none) and the event is of its newsletter (or it has none).
export function wantsEvent(endpoint, { type, newsletterId }) {
	if (endpoint.events?.length > 0 && !endpoint.events.includes(type)) return false;
	return !endpoint.newsletterId || !newsletterId || String(endpoint.newsletterId) === String(newsletterId);
}

export function getSigningSecrets(endpoint, now = Date.now()) {
	const hasPrevious = endpoint.previousSecret && new Date(endpoint.previousSecretUntil ?? 0).getTime() > now;
	return hasPrevious ? [endpoint.secret, endpoint.previousSecret] : [endpoint.secret];
}

// The next attempt's job; attempt counts from 1. now: the time of the attempt that failed, in milliseconds.
function publishAttempt(delivery, attempt, { delaySeconds = 0, now = Date.now() } = {}) {
	return publishJob({
		url: getJobUrl(),
		body: { accountId: String(delivery.accountId), deliveryId: String(delivery._id), attempt },
		...(delaySeconds > 0 && { notBefore: Math.floor(now / 1000) + delaySeconds }),
	});
}

// Only the newest deliveries of an endpoint stay.
async function pruneDeliveries(accountId, endpointId) {
	const [oldest] = await WebhookDelivery.find(scoped(accountId, { endpointId }))
		.sort({ createdAt: -1, _id: -1 })
		.skip(MAX_DELIVERIES_PER_ENDPOINT - 1)
		.limit(1)
		.select({ createdAt: 1 })
		.lean();
	if (oldest) await WebhookDelivery.deleteMany(scoped(accountId, { endpointId, createdAt: { $lt: oldest.createdAt } }));
}

// Records one delivery and queues its first attempt.
async function queueDelivery({ endpoint, messageId, type, payload, test = false }) {
	const delivery = await WebhookDelivery.create({
		accountId: endpoint.accountId,
		endpointId: endpoint._id,
		messageId,
		type,
		payload,
		...(test && { test: true }),
		nextAttemptAt: new Date(),
	});
	await pruneDeliveries(endpoint.accountId, endpoint._id);
	try {
		await publishAttempt(delivery, 1);
	} catch (error) {
		await WebhookDelivery.updateOne(scoped(endpoint.accountId, { _id: delivery._id }), {
			$set: { status: "failed", error: `Could not queue the delivery: ${String(error?.message ?? error).slice(0, 200)}` },
			$unset: { nextAttemptAt: 1 },
		});
		throw error;
	}
	return delivery.toObject();
}

// The account's endpoints that are on, while it has a plan: an account that stopped paying keeps its endpoints, but
// nothing goes out until it has one again.
async function findEnabledEndpoints(accountId) {
	await connectDb();
	const endpoints = await WebhookEndpoint.find(scoped(accountId, { enabled: true })).select({ events: 1, newsletterId: 1 }).lean();
	if (endpoints.length === 0) return [];
	const account = await Account.findById(accountId).select({ subscriptionStatus: 1, comp: 1, deletion: 1 }).lean();
	return hasActiveSubscription(account) ? endpoints.map((endpoint) => ({ ...endpoint, accountId })) : [];
}

async function queueEvent(endpoints, { newsletterId, type, data }) {
	const targets = endpoints.filter((endpoint) => wantsEvent(endpoint, { type, newsletterId }));
	if (targets.length === 0) return 0;
	const messageId = newMessageId();
	const payload = buildWebhookBody({ type, data });
	let queued = 0;
	for (const endpoint of targets) {
		try {
			await queueDelivery({ endpoint, messageId, type, payload });
			queued++;
		} catch (error) {
			console.error(`[webhooks] ${type} for endpoint ${endpoint._id} not queued:`, error?.message);
		}
	}
	return queued;
}

// The one way an event leaves FlockStack: every enabled endpoint of the account that takes it gets a delivery. data is
// the event's data, or a function that loads it, called only when an endpoint takes the event, so an account without
// endpoints pays one query. Never throws: a webhook can't break a signup, a send or a payment. Returns the deliveries queued.
export async function emitWebhookEvent({ accountId, newsletterId = null, type, data }) {
	if (!accountId) return 0;
	try {
		const endpoints = (await findEnabledEndpoints(accountId)).filter((endpoint) => wantsEvent(endpoint, { type, newsletterId }));
		if (endpoints.length === 0) return 0;
		const resolved = typeof data === "function" ? await data() : data;
		return resolved ? await queueEvent(endpoints, { newsletterId, type, data: resolved }) : 0;
	} catch (error) {
		console.error(`[webhooks] ${type} for account ${accountId} not sent:`, error?.message);
		return 0;
	}
}

// What the flows call, each with its own data. contact, campaign and order are documents as stored.
export function emitSubscriberEvent(type, contact, extra = {}) {
	return emitWebhookEvent({ accountId: contact.accountId, newsletterId: contact.newsletterId, type, data: { subscriber: toSubscriberData(contact), ...extra } });
}

// Tags or fields changed: the contact is read again, as it is now, only when an endpoint takes the event.
export function emitSubscriberUpdated(contact, { tagsAdded = [], tagsRemoved = [], fields = [] }) {
	if (tagsAdded.length + tagsRemoved.length + fields.length === 0) return 0;
	return emitWebhookEvent({
		accountId: contact.accountId,
		newsletterId: contact.newsletterId,
		type: "subscriber.updated",
		data: async () => {
			const current = await Contact.findOne(scoped(contact.accountId, { _id: contact._id })).lean();
			return current && { subscriber: toSubscriberData(current), changes: { tagsAdded, tagsRemoved, fields } };
		},
	});
}

// One event per contact a change reached at once (an address unsubscribing from every newsletter of the account): the
// contacts are loaded only when an endpoint takes the event.
export async function emitSubscriberEvents(accountId, type, loadContacts) {
	try {
		const endpoints = await findEnabledEndpoints(accountId);
		if (!endpoints.some((endpoint) => wantsEvent(endpoint, { type }))) return 0;
		let queued = 0;
		for (const contact of await loadContacts()) {
			queued += await queueEvent(endpoints, { newsletterId: contact.newsletterId, type, data: { subscriber: toSubscriberData(contact) } });
		}
		return queued;
	} catch (error) {
		console.error(`[webhooks] ${type} for account ${accountId} not sent:`, error?.message);
		return 0;
	}
}

// campaign: as it is once marked sent.
export function emitCampaignSent(campaign) {
	return emitWebhookEvent({
		accountId: campaign.accountId,
		newsletterId: campaign.newsletterId,
		type: "campaign.sent",
		data: async () => {
			const newsletter = await Newsletter.findOne(scoped(campaign.accountId, { _id: campaign.newsletterId })).lean();
			return { campaign: toCampaignData(campaign, getIssuePageUrl({ campaign, newsletter })) };
		},
	});
}

export function emitOrderPaid(order) {
	return emitWebhookEvent({ accountId: order.accountId, newsletterId: order.newsletterId, type: "order.paid", data: { order: toOrderData(order) } });
}

// "Send a test event": one attempt, whatever the endpoint's events, even while it's off, so its owner can check a fix.
export async function sendTestEvent(endpoint) {
	const data = { message: "A test event from FlockStack. Your endpoint received it.", endpointId: String(endpoint._id) };
	return queueDelivery({ endpoint, messageId: newMessageId(), type: TEST_EVENT_TYPE, payload: buildWebhookBody({ type: TEST_EVENT_TYPE, data }), test: true });
}

// The same event again, as a new delivery with the same webhook-id: receivers that saw it already can skip it.
export async function resendDelivery(endpoint, delivery) {
	return queueDelivery({ endpoint, messageId: delivery.messageId, type: delivery.type, payload: delivery.payload, test: Boolean(delivery.test) });
}

// The attempt is this job's only if no other run has it: QStash can deliver a job twice.
async function claimAttempt({ accountId, deliveryId, attempt, now }) {
	return WebhookDelivery.findOneAndUpdate(
		scoped(accountId, {
			_id: deliveryId,
			status: "pending",
			$or: [{ attempts: attempt - 1 }, { attempts: attempt, lastAttemptAt: { $lt: new Date(now - STALE_CLAIM_MS) } }],
		}),
		{ $set: { attempts: attempt, lastAttemptAt: new Date(now) } },
		{ returnDocument: "after" }
	).lean();
}

// One POST, never following a redirect: an address that redirects could lead anywhere.
async function post({ url, headers, body, fetchImpl }) {
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...headers },
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const text = await response.text().catch(() => "");
		return { status: response.status, body: text.slice(0, RESPONSE_BODY_CHARS) };
	} catch (error) {
		const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
		return { error: isTimeout ? `No answer within ${TIMEOUT_MS / 1000} seconds` : `Could not connect: ${String(error?.message ?? error).slice(0, 200)}` };
	}
}

function describeFailure(result) {
	if (result.error) return result.error;
	if (result.status >= 300 && result.status < 400) return `Answered ${result.status}: redirects aren't followed, use the final address`;
	return `Answered ${result.status}`;
}

async function finishDelivery({ accountId, delivery, set, unset = {} }) {
	await WebhookDelivery.updateOne(scoped(accountId, { _id: delivery._id }), { $set: set, $unset: { nextAttemptAt: 1, ...unset } });
}

// Off for good until its owner turns it back on, who hears of it once.
export async function disableEndpoint({ accountId, endpoint, reason }) {
	const { modifiedCount } = await WebhookEndpoint.updateOne(scoped(accountId, { _id: endpoint._id, enabled: true }), {
		$set: { enabled: false, disabledReason: reason, disabledAt: new Date() },
	});
	if (!modifiedCount) return;
	await sendAlert({
		accountId,
		key: `webhook-disabled:${endpoint._id}`,
		title: "A webhook endpoint was turned off",
		detail: `FlockStack stopped sending events to ${endpoint.url}: ${reason}.`,
		action: "Fix the endpoint, send it a test event, then turn it back on. Events in between aren't sent again on their own; resend the ones you need from its log.",
		path: `/webhooks/${endpoint._id}`,
	});
}

// After a failed attempt: retry later, or give up; an endpoint failing for days, or gone (410), is turned off.
async function handleFailure({ accountId, endpoint, delivery, attempt, result, now }) {
	const error = describeFailure(result);
	const response = { responseStatus: result.status, responseBody: result.body, error };
	if (delivery.test) {
		await finishDelivery({ accountId, delivery, set: { status: "failed", ...response } });
		return { failed: true, error };
	}
	const failingSince = endpoint.failingSince ?? new Date(now);
	await WebhookEndpoint.updateOne(scoped(accountId, { _id: endpoint._id }), { $set: { lastFailureAt: new Date(now), failingSince } });
	const isGone = result.status === 410;
	const isFailingTooLong = now - new Date(failingSince).getTime() >= WEBHOOK_DISABLE_AFTER_MS;
	if (isGone || isFailingTooLong) {
		await finishDelivery({ accountId, delivery, set: { status: "failed", ...response } });
		await disableEndpoint({
			accountId,
			endpoint,
			reason: isGone ? "it answered 410 Gone, which means it was removed" : "it hasn't accepted an event in about 5 days of retries",
		});
		return { failed: true, disabled: true, error };
	}
	if (attempt >= MAX_ATTEMPTS) {
		await finishDelivery({ accountId, delivery, set: { status: "failed", ...response } });
		return { failed: true, error };
	}
	const delay = RETRY_DELAYS_SECONDS[attempt - 1];
	await WebhookDelivery.updateOne(scoped(accountId, { _id: delivery._id }), {
		$set: { ...response, nextAttemptAt: new Date(now + delay * 1000) },
	});
	await publishAttempt(delivery, attempt + 1, { delaySeconds: delay, now });
	return { retryIn: delay, error };
}

// The job: one attempt of one delivery. Handled outcomes return normally; only the database failing throws, and then
// QStash runs the same attempt again.
export async function deliverWebhook({ accountId, deliveryId, attempt }, { fetchImpl = fetch, now = Date.now() } = {}) {
	if (!ObjectId.isValid(String(accountId ?? "")) || !ObjectId.isValid(String(deliveryId ?? "")) || !Number.isInteger(attempt) || attempt < 1) {
		return { ignored: "invalid job" };
	}
	await connectDb();
	const delivery = await claimAttempt({ accountId, deliveryId, attempt, now });
	if (!delivery) return { ignored: "not pending, or attempted already" };
	const endpoint = await WebhookEndpoint.findOne(scoped(accountId, { _id: delivery.endpointId })).lean();
	if (!endpoint) {
		await finishDelivery({ accountId, delivery, set: { status: "failed", error: "The endpoint was deleted" } });
		return { failed: true, error: "endpoint deleted" };
	}
	if (!endpoint.enabled && !delivery.test) {
		await finishDelivery({ accountId, delivery, set: { status: "failed", error: "The endpoint is turned off" } });
		return { failed: true, error: "endpoint off" };
	}
	const urlProblem = getWebhookUrlProblem(endpoint.url);
	if (urlProblem) {
		await finishDelivery({ accountId, delivery, set: { status: "failed", error: urlProblem } });
		return { failed: true, error: urlProblem };
	}

	const headers = await getWebhookHeaders({ secrets: getSigningSecrets(endpoint, now), id: delivery.messageId, body: delivery.payload, now });
	const result = await post({ url: endpoint.url, headers, body: delivery.payload, fetchImpl });
	if (result.status >= 200 && result.status < 300) {
		await finishDelivery({ accountId, delivery, set: { status: "delivered", deliveredAt: new Date(now), responseStatus: result.status, responseBody: result.body }, unset: { error: 1 } });
		if (!delivery.test) {
			await WebhookEndpoint.updateOne(scoped(accountId, { _id: endpoint._id }), { $set: { lastSuccessAt: new Date(now) }, $unset: { failingSince: 1 } });
		}
		return { delivered: true, status: result.status };
	}
	return handleFailure({ accountId, endpoint, delivery, attempt, result, now });
}
