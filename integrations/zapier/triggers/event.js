const { apiUrl } = require("../lib/api");

// One REST hook trigger per FlockStack event. Turning the Zap on adds a webhook endpoint for that one event
// (create_webhook_endpoint), turning it off deletes it (delete_webhook_endpoint). Each Zap uses one of the plan's endpoints.
const SAMPLES = {
	Subscriber: {
		id: "6650f1c2e9b1d4a012345678",
		newsletterId: "6650f1c2e9b1d4a0123456aa",
		email: "jane@example.com",
		status: "active",
		source: "website",
		tier: "free",
		paidUntil: null,
		tags: ["podcast"],
		fields: { first_name: "Jane" },
		subscribedAt: "2026-10-20T09:30:00.000Z",
		confirmedAt: null,
		unsubscribedAt: null,
	},
	Campaign: {
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
	Order: {
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
};

// What a Zap's next steps see: the subscriber, campaign or order at the top level, with the event's type, time and extras
// (changes, interval…). id is unique per event, so Zapier never runs the Zap twice for one.
function flatten(event) {
	const { type, timestamp, data = {} } = event;
	const { subscriber, campaign, order, ...extras } = data;
	const item = subscriber || campaign || order || data;
	return { ...item, ...extras, id: `${type}:${item.id || ""}:${timestamp}`, objectId: item.id, event: type, eventAt: timestamp };
}

// Zapier's editor asks for samples: the latest real items of the account, shaped like the event.
async function listRecent(z, bundle, { type, noun }) {
	const newsletter = bundle.inputData.newsletter;
	const query = (params) => new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== "")).toString();
	const timestamp = new Date().toISOString();
	if (noun === "Campaign") {
		const response = await z.request({ url: apiUrl(bundle, `/campaigns?${query({ status: "sent", limit: 3, newsletter })}`) });
		return response.data.campaigns.map((campaign) => flatten({ type, timestamp, data: { campaign } }));
	}
	if (noun === "Order") {
		const response = await z.request({ url: apiUrl(bundle, `/orders?${query({ status: "paid", limit: 3 })}`) });
		return response.data.orders.map((order) => flatten({ type, timestamp, data: { order } }));
	}
	const response = await z.request({ url: apiUrl(bundle, `/contacts?${query({ limit: 3, newsletter })}`) });
	return response.data.contacts.map((subscriber) => flatten({ type, timestamp, data: { subscriber } }));
}

function makeEventTrigger({ type, key, noun, label, description }) {
	return {
		key,
		noun,
		display: { label, description },
		operation: {
			type: "hook",
			inputFields: [
				{
					key: "newsletter",
					label: "Newsletter",
					required: false,
					dynamic: "newsletter_list.id.name",
					helpText: "Only this newsletter's events. Leave empty for every newsletter of the account.",
				},
			],
			performSubscribe: async (z, bundle) => {
				const response = await z.request({
					url: apiUrl(bundle, "/webhooks"),
					method: "POST",
					json: {
						url: bundle.targetUrl,
						events: [type],
						description: `Zapier: ${label}`,
						source: "zapier",
						...(bundle.inputData.newsletter && { newsletter: bundle.inputData.newsletter }),
					},
				});
				return response.data.endpoint;
			},
			performUnsubscribe: async (z, bundle) => {
				const response = await z.request({
					url: apiUrl(bundle, `/webhooks/${encodeURIComponent(bundle.subscribeData.id)}`),
					method: "DELETE",
					skipThrowForStatus: true,
				});
				// Already gone (deleted on the dashboard) is what unsubscribing wants.
				if (response.status !== 404 && response.status >= 400) throw new z.errors.Error(`FlockStack answered ${response.status}`);
				return response.status === 404 ? { deleted: true } : response.data;
			},
			perform: (z, bundle) => {
				const event = bundle.cleanedRequest || {};
				return event.type === type ? [flatten(event)] : [];
			},
			performList: (z, bundle) => listRecent(z, bundle, { type, noun }),
			sample: flatten({ type, timestamp: "2026-10-20T09:30:00.000Z", data: { [noun.toLowerCase()]: SAMPLES[noun] } }),
		},
	};
}

module.exports = { makeEventTrigger, flatten };
