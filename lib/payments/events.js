import "server-only";
import { scoped } from "@/lib/account-scope";
import { getPaymentsMode } from "@/lib/payments/config";
import { saveStripeAccountStatus } from "@/lib/payments/connect";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";
import PaymentEvent from "@/models/PaymentEvent";

// Which FlockStack account an event belongs to. With Stripe Connect, the connected account that sent it says so. On a
// self-hosted server every event is from the owner's own Stripe account, so the account FlockStack put on the object
// (metadata.accountId) says so; events about a charge or a subscription come without it, and `lookups` find theirs.
// Events nobody here made have no account and are ignored.
async function resolveEventAccount(event, lookups) {
	const mode = getPaymentsMode();
	const object = event.data?.object ?? {};
	if (mode === "connect") {
		const stripeAccountId = event.account ?? (event.type.startsWith("account.") ? object.id : null);
		if (!stripeAccountId) return null;
		return Account.findOne({ "payments.stripeAccountId": stripeAccountId }).setOptions({ crossAccount: true }).lean();
	}
	if (mode !== "direct") return null;
	let accountId = object.metadata?.accountId;
	for (const lookup of lookups) {
		if (isObjectIdString(accountId ?? "")) break;
		accountId = await lookup(object);
	}
	return isObjectIdString(String(accountId ?? "")) ? Account.findById(String(accountId)).lean() : null;
}

async function handleAccountUpdated({ account, object }) {
	if (object.id !== account.payments?.stripeAccountId) return { ignored: "not the connected account" };
	await saveStripeAccountStatus(account._id, object);
}

// The creator disconnected FlockStack in their Stripe dashboard: nothing can be charged on that account any more.
async function handleDeauthorized({ account }) {
	await Account.updateOne({ _id: account._id }, { $set: { "payments.chargesEnabled": false, "payments.deauthorizedAt": new Date() } });
}

const HANDLERS = {
	"account.updated": handleAccountUpdated,
	"account.application.deauthorized": handleDeauthorized,
};
// Each finds the account of an object that carries no metadata, by what FlockStack stored about it.
const LOOKUPS = [];

// Runs one verified Stripe event. Safe to run again: a finished event is skipped by its id, and an unfinished one (the
// handler threw, Stripe sent it again) runs again, so every handler has to cope with a repeat.
export async function handlePaymentEvent(event) {
	const handler = HANDLERS[event.type];
	if (!handler) return { ignored: event.type };
	const account = await resolveEventAccount(event, LOOKUPS);
	if (!account) return { ignored: "unknown account" };

	const done = await PaymentEvent.findOne(scoped(account, { eventId: event.id })).select({ processedAt: 1 }).lean();
	if (done?.processedAt) return { duplicate: true };

	const result = (await handler({ event, account, object: event.data.object })) ?? {};
	try {
		await PaymentEvent.updateOne(scoped(account, { eventId: event.id }), { $set: { type: event.type, processedAt: new Date() } }, { upsert: true });
	} catch (error) {
		// The same event delivered twice at once: the other delivery recorded it.
		if (error?.code !== 11000) throw error;
	}
	return { handled: event.type, ...result };
}
