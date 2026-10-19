// Delivery rules for outgoing webhooks (lib/webhooks.js), apart so the docs and the dashboard read them without the
// delivery code.

// The log keeps this many deliveries per endpoint, newest first; older ones go as new ones come.
export const MAX_DELIVERIES_PER_ENDPOINT = 100;
// Seconds to wait before each retry: about 4 days and 21 hours from the first try to the last, then the delivery fails.
export const RETRY_DELAYS_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 12 * 3600, 24 * 3600, 24 * 3600, 24 * 3600, 24 * 3600];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
// An endpoint that hasn't answered 2xx for this long is turned off, and its owner emailed: a little less than a delivery's
// retries, so the last attempt of an event that never got through turns it off.
export const WEBHOOK_DISABLE_AFTER_MS = 4.5 * 24 * 3600_000;
// A rotated secret keeps signing next to the new one for a day.
export const PREVIOUS_SECRET_MS = 24 * 3600_000;
// An attempt waits this long for an answer.
export const TIMEOUT_MS = 15_000;
