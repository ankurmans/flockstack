// The Stripe events the payments webhook (/api/webhooks/payments) handles, for the pages that tell an owner which to turn on:
// the README, the selling guide and the release QA page. No imports, so a public docs page can read it.
// tests/webhook-event-docs.test.mjs fails when this list, the handlers in lib/payments/events.js and those pages drift apart.
export const PAYMENT_EVENT_TYPES = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"charge.refunded",
	"charge.dispute.created",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"customer.subscription.paused",
	"customer.subscription.resumed",
	"invoice.paid",
	"invoice.payment_failed",
	"invoice.finalized",
	"invoice.voided",
	"invoice.marked_uncollectible",
	"invoice.updated",
	"account.updated",
	"account.application.deauthorized",
];

// Only a Stripe Connect platform (FlockStack Cloud) receives these; a self-hosted server's own Stripe account has no connected accounts.
export const CONNECT_EVENT_TYPES = ["account.updated", "account.application.deauthorized"];

export const SELF_HOSTED_EVENT_TYPES = PAYMENT_EVENT_TYPES.filter((type) => !CONNECT_EVENT_TYPES.includes(type));
