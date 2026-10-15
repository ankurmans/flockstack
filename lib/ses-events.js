import "server-only";
import { handleEmailEvent } from "@/lib/email-events";
import { normalizeSesEvent } from "@/lib/ses-event-mapping";

export { getSesEventPlan } from "@/lib/ses-event-mapping";

// SES events from every account's configuration set (/api/webhooks/ses). Each names its account in the
// account_id tag; one that matches no message of that account only shows in the logs.
export function handleSesEvent(sesEvent) {
	return handleEmailEvent(normalizeSesEvent(sesEvent));
}
