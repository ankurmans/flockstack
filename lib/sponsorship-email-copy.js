import { getReaderText } from "./reader-languages.js";

const plain = value => String(value ?? "").replace(/[\r\n\[\]()*_`<>!\\{}]/g, " ").trim();
export function getSponsorshipEmailCopy(newsletter, booking, kind, url) {
	const t = getReaderText(newsletter);
	const reason = t("This email concerns your newsletter sponsorship request. It does not subscribe you.");
	if (kind === "verify") return {
		subject: t("Confirm your sponsorship request for {name}", { name: plain(newsletter.name) }), reason,
		markdown: `${t("Confirm the sponsorship request for {placement} on {day} ({zone}). The creator will review it. This reserves no date, creates no invoice and schedules no issue.", { placement: plain(booking.placementName), day: booking.day, zone: booking.timeZone })}\n\n[${t("Confirm my sponsorship request")}](${url})\n\n${t("This private link expires in 24 hours. Ignore this email if you did not request it. You will not be subscribed.")}`,
	};
	if (kind === "manager") return {
		subject: t("Your sponsorship request for {name}", { name: plain(newsletter.name) }), reason,
		markdown: `${t("Review your request, creative, invoice and observed delivery report. A planned day does not schedule or publish an issue.")}\n\n[${t("Manage my sponsorship")}](${url})\n\n${t("Booking ID")}: ${booking._id}\n\n${t("This private link expires in 7 days. Do not forward it.")}`,
	};
	if (kind === "invoice") return {
		subject: t("Your sponsorship invoice"), reason,
		markdown: `${t("The creator accepted your request for {day} ({zone}). Review and pay the agreed invoice in Stripe. Payment does not send or schedule an issue.", { day: booking.day, zone: booking.timeZone })}\n\n[${t("Review invoice in Stripe")}](${url})\n\n${t("The creator handles any cancellation or refund. This email takes no payment.")}`,
	};
	throw new Error("Unknown sponsorship email kind");
}
