// FlockStack's webhook events, as lib/webhook-events.js in the app lists them (tests/webhooks.test.mjs checks they match).
// key: the trigger's key in Zapier. noun: what the trigger hands to the Zap's next steps.
module.exports = [
	{ type: "subscriber.created", key: "subscriber_created", noun: "Subscriber", label: "New subscriber", description: "Triggers when someone subscribes, is added, or comes back after unsubscribing." },
	{ type: "subscriber.confirmed", key: "subscriber_confirmed", noun: "Subscriber", label: "Subscriber confirmed", description: "Triggers when a subscriber clicks the link in the confirmation email." },
	{ type: "subscriber.unsubscribed", key: "subscriber_unsubscribed", noun: "Subscriber", label: "Subscriber unsubscribed", description: "Triggers when a subscriber unsubscribes." },
	{ type: "subscriber.updated", key: "subscriber_updated", noun: "Subscriber", label: "Subscriber updated", description: "Triggers when a subscriber's tags or custom fields change." },
	{ type: "subscriber.upgraded", key: "subscriber_upgraded", noun: "Subscriber", label: "Subscriber upgraded to paid", description: "Triggers when a reader starts a paid subscription." },
	{ type: "subscriber.downgraded", key: "subscriber_downgraded", noun: "Subscriber", label: "Subscriber downgraded to free", description: "Triggers when a paid reader's subscription ends." },
	{ type: "campaign.sent", key: "campaign_sent", noun: "Campaign", label: "Campaign sent", description: "Triggers when a campaign finishes going out." },
	{ type: "audio.ready", key: "audio_ready", noun: "Audio version", label: "Audio version ready", description: "Triggers when the audio version of an issue is made." },
	{ type: "order.paid", key: "order_paid", noun: "Order", label: "Order paid", description: "Triggers when a reader pays for a digital product." },
	{ type: "approval.decided", key: "approval_decided", noun: "Approval", label: "Approval decided", description: "Triggers when you approve or reject something an AI agent asked to do, or it expires." },
	{ type: "automation.step", key: "automation_step", noun: "Automation step", label: "Automation step", description: "Triggers when a contact reaches a webhook step of an automation." },
];
