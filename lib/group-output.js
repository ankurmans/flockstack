import { getGroupBuyLink } from "./group-links.js";

const iso = value => value && Number.isFinite(+new Date(value)) ? new Date(value).toISOString() : null;
export function groupOutput(group) {
	let position = 0;
	const funded = group.status === "active" && group.subscriptionStatus === "active" && +new Date(group.paidUntil) > Date.now();
	return {
		id: String(group._id), newsletterId: String(group.newsletterId), tierId: group.tierId, option: group.option, buyerEmail: group.buyerEmail,
		status: group.status, subscriptionStatus: group.subscriptionStatus ?? null, requestedSeats: group.requestedSeats, capacity: funded ? group.capacity : 0,
		paidUntil: iso(group.paidUntil), observedAt: iso(group.billingObservedAt), billingProblem: group.billingProblem ?? null,
		createdAt: iso(group.createdAt),
		seats: (group.seats ?? []).map(seat => ({ id: seat.id, email: seat.email ?? null, status: seat.status, withinPaidCapacity: seat.status !== "revoked" && ++position <= (funded ? group.capacity : 0), invitedAt: iso(seat.invitedAt), invitationSentAt: iso(seat.invitationSentAt), acceptedAt: iso(seat.acceptedAt) })),
	};
}

export function groupSettingsOutput(settings, newsletter) {
	return { ...settings, problem: settings.problem ?? null, buyUrl: getGroupBuyLink(newsletter) };
}
