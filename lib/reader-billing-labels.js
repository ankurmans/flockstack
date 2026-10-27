export const READER_BILLING_LABELS = Object.freeze({
	active: "Subscription active", paused: "Subscription paused", scheduled: "Pause scheduled", resume_pending: "Resume awaiting payment", ended: "Pause ended", not_paused: "No confirmed pause", canceled: "Subscription canceled", past_due: "Payment overdue", unpaid: "Unpaid", trialing: "In trial", incomplete: "Payment incomplete", incomplete_expired: "Initial payment expired",
	cost: "Price", not_reading: "Not reading", content: "Content", temporary: "Temporary break", other: "Other",
});

export function readerBillingLabel(value) { return typeof value === "string" && Object.hasOwn(READER_BILLING_LABELS, value) ? READER_BILLING_LABELS[value] : "Unknown"; }
