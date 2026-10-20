import "server-only";
import { enrollOnTierChange } from "@/lib/automation-triggers";
import { emitSubscriberEvent } from "@/lib/webhooks";

// A reader started or stopped having paid access, however it came: a subscription, a lifetime payment, a converted pledge, a
// comp or a gift. Webhook endpoints hear of it, and the automations that start on it start (extra: tier and source).
export async function announceTierChange(type, contact, extra) {
	await emitSubscriberEvent(type === "upgraded" ? "subscriber.upgraded" : "subscriber.downgraded", contact, extra);
	await enrollOnTierChange(contact, type);
}
