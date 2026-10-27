import "server-only";
import { getPaymentsSecretKey } from "./config.js";

const STRIPE_BASE = "https://api.stripe.com";
const REQUEST_TIMEOUT_MS = 10_000;

export class StripeError extends Error {
	constructor(message, { status, code, type, param } = {}) {
		super(message);
		this.name = "StripeError";
		this.status = status;
		this.stripeCode = code;
		this.type = type;
		this.param = param;
	}
}

// Stripe's form encoding: nested objects and arrays become key[sub] and key[0].
export function encodeParams(params, prefix = "") {
	const pairs = [];
	for (const [name, value] of Object.entries(params ?? {})) {
		if (value === undefined || value === null) continue;
		const key = prefix ? `${prefix}[${name}]` : name;
		if (Array.isArray(value)) {
			value.forEach((item, index) => {
				if (item !== null && typeof item === "object") pairs.push(...encodeParams(item, `${key}[${index}]`));
				else pairs.push([`${key}[${index}]`, String(item)]);
			});
		} else if (typeof value === "object") {
			pairs.push(...encodeParams(value, key));
		} else {
			pairs.push([key, String(value)]);
		}
	}
	return pairs;
}

// FlockStack takes no cut of what creators earn (0% platform fee): only Stripe's own processing fee comes off a sale.
// Stripe would take a platform fee from a direct charge when one of these is set, so none ever goes out.
export function assertNoApplicationFee(pairs) {
	if (pairs.some(([key]) => /application_fee/i.test(key))) {
		throw new Error("FlockStack never takes an application fee on a creator's sales");
	}
}

export function hasUnsupportedCreatorFee(object) {
	return object?.application_fee_amount != null && object.application_fee_amount !== 0;
}

// account: a connected account's id, sent as the Stripe-Account header so the call (a Checkout Session, a subscription)
// happens on the creator's own Stripe account.
export async function stripeRequest(path, { method = "GET", params, account, idempotencyKey, apiVersion, timeout = REQUEST_TIMEOUT_MS } = {}) {
	if (apiVersion !== undefined && !/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(apiVersion)) throw new Error("Invalid Stripe API version");
	const secretKey = getPaymentsSecretKey();
	if (!secretKey) throw new Error("Payments aren't set up (STRIPE_SECRET_KEY)");
	const pairs = encodeParams(params);
	assertNoApplicationFee(pairs);
	const query = pairs.length > 0 ? new URLSearchParams(pairs).toString() : "";
	const isRead = method === "GET";
	const response = await fetch(`${STRIPE_BASE}${path}${isRead && query ? `?${query}` : ""}`, {
		method,
		headers: {
			authorization: `Bearer ${secretKey}`,
			accept: "application/json",
			...(account && { "stripe-account": account }),
			...(idempotencyKey && { "idempotency-key": idempotencyKey }),
			...(apiVersion && { "stripe-version": apiVersion }),
			...(!isRead && { "content-type": "application/x-www-form-urlencoded" }),
		},
		...(!isRead && { body: query }),
		signal: AbortSignal.timeout(timeout),
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		const error = payload?.error ?? {};
		throw new StripeError(`Stripe answered ${response.status} to ${method} ${path}: ${error.message ?? "no details"}`.slice(0, 400), {
			status: response.status,
			code: error.code,
			type: error.type,
			param: error.param,
		});
	}
	return payload;
}
