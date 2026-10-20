import { isResend } from "@/lib/resend-rules";
import Contact from "@/models/Contact";
import Message from "@/models/Message";

export { isResend };

// Emails that bounced, were complained about or never went out didn't reach their reader; the audience's own rules
// (active, not suppressed, tier, segment) apply on top.
const REACHED_STATUSES = ["sent", "delivered"];
const CHUNK_SIZE = 500;

function toFilter(campaign) {
	const { of, to } = campaign.resend;
	return {
		accountId: campaign.accountId,
		campaignId: of,
		kind: "campaign",
		status: { $in: REACHED_STATUSES },
		...(to === "unclicked" ? { clickedAt: null } : { openedAt: null }),
	};
}

// At most this many: some of them left or were suppressed since.
export function countResendAudience(campaign) {
	return Message.countDocuments(toFilter(campaign));
}

// The contacts a resend goes to, a chunk at a time: its first send's readers who didn't open (or click), who are still
// in the audience its filter describes (lib/audience.js).
export async function* walkResendContacts(campaign, audienceFilter, select) {
	let after = null;
	for (;;) {
		const messages = await Message.find({ ...toFilter(campaign), ...(after && { _id: { $gt: after } }) })
			.sort({ _id: 1 })
			.limit(CHUNK_SIZE)
			.select({ contactId: 1 })
			.lean();
		if (messages.length === 0) return;
		after = messages.at(-1)._id;
		const ids = messages.map(({ contactId }) => contactId).filter(Boolean);
		if (ids.length > 0) yield await Contact.find({ ...audienceFilter, _id: { $in: ids } }).select(select).lean();
		if (messages.length < CHUNK_SIZE) return;
	}
}
