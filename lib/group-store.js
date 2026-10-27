import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { GROUP_LIMITS } from "@/lib/group-subscription-rules";
import { isObjectIdString } from "@/lib/validation";
import GroupSubscription from "@/models/GroupSubscription";

export async function findGroup(account, id) {
	const group = isObjectIdString(String(id ?? "")) ? await GroupSubscription.findOne(scoped(account, { _id: id })).lean() : null;
	if (!group) throw actionError("not_found", "Group subscription not found");
	return group;
}

// The one bounded row owns seat capacity. Every retry rereads payment, version and current seats before changing them.
export async function changeGroupSeats(account, groupId, change) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const group = await findGroup(account, groupId);
		const seats = change(group);
		if (!seats) return group;
		if (seats.length > GROUP_LIMITS.maxSeats) throw actionError("conflict", "A group supports at most 100 seats");
		const revision = group.revision ?? 0;
		const guard = revision ? { revision } : { $or: [{ revision: 0 }, { revision: { $exists: false } }] };
		const result = await GroupSubscription.updateOne(scoped(account, { _id: group._id, ...guard }), { $set: { seats }, $inc: { revision: 1 } });
		if (result.matchedCount) return { ...group, seats, revision: revision + 1 };
	}
	throw actionError("conflict", "This group changed. Refresh the page and try again.");
}
