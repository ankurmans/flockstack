import "server-only";
import { scoped } from "@/lib/account-scope";
import { changeGroupSeats } from "@/lib/group-store";
import GroupSubscription from "@/models/GroupSubscription";

export async function removeGroupReader(contact) {
	let after;
	for (;;) {
		const groups = await GroupSubscription.find(scoped(contact.accountId, { newsletterId: contact.newsletterId, $or: [{ "seats.contactId": contact._id }, { "seats.email": contact.email }], ...(after && { _id: { $gt: after } }) })).sort({ _id: 1 }).limit(20).lean();
		for (const group of groups) await changeGroupSeats(contact.accountId, group._id, fresh => fresh.seats.map(seat => String(seat.contactId) === String(contact._id) || seat.email === contact.email ? { id: seat.id, status: "revoked", invitationVersion: (seat.invitationVersion ?? 0) + 1 } : seat));
		if (groups.length < 20) break;
		after = groups.at(-1)._id;
	}
}
