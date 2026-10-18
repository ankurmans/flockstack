import "server-only";
import { codedError } from "@/lib/account-state";
import { getAppUrl } from "@/lib/config";
import { getPaymentsMode } from "@/lib/payments/config";
import { stripeRequest } from "@/lib/payments/stripe-api";
import Account from "@/models/Account";

const NOT_SET_UP = "Payments aren't set up on this server";

// What the dashboard, the API and the checkout code need to know about where an account is paid. ready: a sale can be
// charged now. On FlockStack Cloud that takes a connected Stripe account that can take charges; a self-hosted server
// only needs its key.
export function getPaymentsState(account) {
	const mode = getPaymentsMode();
	const payments = account?.payments ?? {};
	if (mode === "none") return { mode, ready: false, connected: false, stripeAccountId: null, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, problem: NOT_SET_UP };
	if (mode === "direct") return { mode, ready: true, connected: true, stripeAccountId: null, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, problem: null };
	const stripeAccountId = payments.stripeAccountId ?? null;
	const chargesEnabled = Boolean(payments.chargesEnabled) && !payments.deauthorizedAt;
	let problem = null;
	if (!stripeAccountId) problem = "Connect your Stripe account to take payments";
	else if (payments.deauthorizedAt) problem = "Your Stripe account was disconnected. Connect it again to take payments";
	else if (!chargesEnabled) problem = "Finish setting up your Stripe account to take payments";
	return {
		mode,
		ready: Boolean(stripeAccountId) && chargesEnabled,
		connected: Boolean(stripeAccountId) && !payments.deauthorizedAt,
		stripeAccountId,
		chargesEnabled,
		payoutsEnabled: Boolean(payments.payoutsEnabled),
		detailsSubmitted: Boolean(payments.detailsSubmitted),
		problem,
	};
}

// The Stripe-Account header value for a call that charges on the creator's behalf: their connected account on
// FlockStack Cloud, nothing on a self-hosted server, whose key is the account.
export function getChargeAccount(account) {
	return getPaymentsMode() === "connect" ? (account.payments?.stripeAccountId ?? undefined) : undefined;
}

export function assertPaymentsReady(account) {
	const state = getPaymentsState(account);
	if (!state.ready) throw codedError({ code: "payments_not_ready", message: state.problem });
	return state;
}

// Stripe's word on a connected account, kept on the FlockStack account.
export async function saveStripeAccountStatus(accountId, stripeAccount) {
	const now = new Date();
	await Account.updateOne(
		{ _id: accountId },
		{
			$set: {
				"payments.chargesEnabled": Boolean(stripeAccount.charges_enabled),
				"payments.payoutsEnabled": Boolean(stripeAccount.payouts_enabled),
				"payments.detailsSubmitted": Boolean(stripeAccount.details_submitted),
				"payments.country": stripeAccount.country ?? undefined,
				"payments.checkedAt": now,
			},
			$unset: { "payments.deauthorizedAt": 1 },
		}
	);
}

// Creates the creator's Standard account on first use, then returns Stripe's hosted onboarding link: it takes them through
// the account's details, or back to the dashboard if it's done, and its status comes back through account.updated.
// Standard accounts have their own Stripe dashboard and login, so the creator keeps their money, refunds and disputes there.
export async function createConnectOnboarding({ account, email }) {
	if (getPaymentsMode() !== "connect") throw codedError({ code: "conflict", message: "This server charges with its own Stripe key: there is nothing to connect" });
	let stripeAccountId = account.payments?.stripeAccountId;
	if (!stripeAccountId || account.payments?.deauthorizedAt) {
		// One Stripe account per FlockStack account, even if two clicks race.
		const created = await stripeRequest("/v1/accounts", {
			method: "POST",
			idempotencyKey: `flockstack-connect-${account._id}${account.payments?.deauthorizedAt ? `-${account.payments.deauthorizedAt.getTime()}` : ""}`,
			params: { type: "standard", email, metadata: { accountId: String(account._id) } },
		});
		stripeAccountId = created.id;
		await Account.updateOne(
			{ _id: account._id },
			{ $set: { "payments.stripeAccountId": stripeAccountId, "payments.connectedAt": new Date() }, $unset: { "payments.deauthorizedAt": 1 } }
		);
	}
	const base = `${getAppUrl()}/payments`;
	const link = await stripeRequest("/v1/account_links", {
		method: "POST",
		params: { account: stripeAccountId, type: "account_onboarding", refresh_url: `${base}?connect=refresh`, return_url: `${base}?connect=return` },
	});
	return { url: link.url, stripeAccountId };
}

// Asks Stripe again, for the status check and when the creator comes back from onboarding before account.updated landed.
export async function refreshPaymentsStatus(account) {
	const stripeAccountId = account.payments?.stripeAccountId;
	if (getPaymentsMode() !== "connect" || !stripeAccountId) return account;
	await saveStripeAccountStatus(account._id, await stripeRequest(`/v1/accounts/${stripeAccountId}`));
	return Account.findById(account._id).lean();
}
