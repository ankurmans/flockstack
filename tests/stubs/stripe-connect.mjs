// A small Stripe for the creator payments code (lib/payments): connected accounts, onboarding links, Checkout Sessions,
// subscriptions, customers and the billing portal, kept in memory. Install it with mockStripe(fake.handler) from
// tests/helpers/app.mjs; every request it gets is in `fake.requests`, with the Stripe-Account header it carried.

// "line_items[0][price_data][currency]=usd" -> { line_items: [{ price_data: { currency: "usd" } }] }
export function parseForm(pairs) {
	const root = {};
	for (const [name, value] of pairs) {
		const keys = [...name.matchAll(/[^[\]]+/g)].map(([key]) => key);
		let node = root;
		keys.forEach((key, index) => {
			const isLast = index === keys.length - 1;
			const next = keys[index + 1];
			if (isLast) node[key] = value;
			else node = node[key] ??= /^\d+$/.test(next) ? [] : {};
		});
	}
	return root;
}

function stripeError(status, message, code) {
	return { status, error: { message, code, type: "invalid_request_error" } };
}

// Ids keep counting across fakes, so two tests never see the same event id.
let counter = 0;
const next = (prefix) => `${prefix}_test_${++counter}`;

export function createFakeStripe() {
	const requests = [];
	const accounts = new Map();
	const sessions = new Map();
	const customers = new Map();
	const subscriptions = new Map();
	const portalConfigurations = [];
	const products = new Map();
	const prices = new Map();
	const coupons = new Map();
	const setupIntents = new Map();
	const paymentMethods = new Map();
	const declined = new Map();
	const idempotent = new Map();
	const failures = new Map();

	async function handler({ method, path, query, body, headers }) {
		const params = parseForm(method === "GET" ? query : body);
		const request = {
			method,
			path,
			params,
			account: headers.get("stripe-account"),
			authorization: headers.get("authorization"),
			idempotencyKey: headers.get("idempotency-key"),
		};
		requests.push(request);
		const failure = failures.get(`${method} ${path}`);
		if (failure) return failure;
		const key = request.idempotencyKey;
		if (key && idempotent.has(key)) return idempotent.get(key);
		const answer = route(request);
		if (key && !answer?.error) idempotent.set(key, answer);
		return answer;
	}

	function route({ method, path, params, account }) {
		const [, , resource, id, sub] = path.split("/");
		if (method === "POST" && path === "/v1/accounts") {
			const created = {
				id: next("acct"),
				object: "account",
				type: params.type,
				email: params.email,
				metadata: params.metadata ?? {},
				country: "US",
				charges_enabled: false,
				payouts_enabled: false,
				details_submitted: false,
			};
			accounts.set(created.id, created);
			return created;
		}
		if (method === "POST" && path === "/v1/account_links") {
			return accounts.has(params.account)
				? { object: "account_link", url: `https://connect.stripe.test/onboard/${params.account}`, ...params }
				: stripeError(404, "No such account", "resource_missing");
		}
		if (method === "GET" && resource === "accounts" && id) return accounts.get(id) ?? stripeError(404, "No such account", "resource_missing");
		if (method === "POST" && path === "/v1/coupons") {
			if (!params.percent_off && !(params.amount_off && params.currency)) return stripeError(400, "Specify either percent_off or amount_off and currency", "parameter_missing");
			if (params.duration === "repeating" && !params.duration_in_months) return stripeError(400, "Missing required param: duration_in_months", "parameter_missing");
			const created = { id: next("coupon"), object: "coupon", valid: true, times_redeemed: 0, connectedAccount: account, ...params, metadata: params.metadata ?? {} };
			coupons.set(created.id, created);
			return created;
		}
		if (method === "DELETE" && resource === "coupons" && id) {
			if (!coupons.has(id)) return stripeError(404, "No such coupon", "resource_missing");
			coupons.delete(id);
			return { id, object: "coupon", deleted: true };
		}
		if (method === "POST" && path === "/v1/checkout/sessions") {
			if (account && !accounts.has(account)) return stripeError(403, "The provided key does not have access to account", "account_invalid");
			const couponId = params.discounts?.[0]?.coupon;
			if (couponId && !coupons.has(couponId)) return stripeError(400, `No such coupon: '${couponId}'`, "resource_missing");
			if (couponId && coupons.get(couponId).max_redemptions && coupons.get(couponId).times_redeemed >= Number(coupons.get(couponId).max_redemptions)) return stripeError(400, "This coupon has reached its maximum redemptions", "coupon_max_redemptions");
			if (couponId && coupons.get(couponId).redeem_by && Number(coupons.get(couponId).redeem_by) * 1000 < Date.now()) return stripeError(400, "This coupon has expired", "coupon_expired");
			const created = {
				id: next("cs"),
				object: "checkout.session",
				url: `https://checkout.stripe.test/c/pay/${counter}`,
				status: "open",
				payment_status: "unpaid",
				connectedAccount: account,
				...params,
				metadata: params.metadata ?? {},
			};
			sessions.set(created.id, created);
			return created;
		}
		if (method === "GET" && resource === "checkout" && sub) return sessions.get(sub) ?? stripeError(404, "No such session", "resource_missing");
		if (method === "POST" && path === "/v1/customers") {
			const created = { id: next("cus"), object: "customer", name: null, ...params, metadata: params.metadata ?? {} };
			customers.set(created.id, created);
			return created;
		}
		if (method === "GET" && path === "/v1/subscriptions") {
			const data = [...subscriptions.values()].filter((subscription) => !params.customer || subscription.customer === params.customer);
			return { object: "list", data, has_more: false };
		}
		if (method === "POST" && path === "/v1/subscriptions") return createSubscription(params);
		if (method === "GET" && resource === "setup_intents" && id) return setupIntents.get(id) ?? stripeError(404, "No such setup_intent", "resource_missing");
		if (method === "POST" && resource === "payment_methods" && sub === "detach") {
			const detached = paymentMethods.get(id);
			if (!detached) return stripeError(404, "No such payment method", "resource_missing");
			detached.customer = null;
			return detached;
		}
		if (method === "GET" && resource === "subscriptions" && id) return subscriptions.get(id) ?? stripeError(404, "No such subscription", "resource_missing");
		if (method === "GET" && resource === "customers" && id) return customers.get(id) ?? stripeError(404, "No such customer", "resource_missing");
		if (method === "POST" && path === "/v1/products") {
			const created = { id: next("prod"), object: "product", active: true, ...params, metadata: params.metadata ?? {} };
			products.set(created.id, created);
			return created;
		}
		if (method === "POST" && resource === "products" && id) {
			if (!products.has(id)) return stripeError(404, "No such product", "resource_missing");
			Object.assign(products.get(id), params, params.active === undefined ? {} : { active: params.active !== "false" });
			return products.get(id);
		}
		if (method === "POST" && path === "/v1/prices") {
			if (!products.has(params.product)) return stripeError(404, "No such product", "resource_missing");
			const created = { id: next("price"), object: "price", active: true, ...params, metadata: params.metadata ?? {} };
			prices.set(created.id, created);
			return created;
		}
		if (method === "POST" && resource === "prices" && id) {
			if (!prices.has(id)) return stripeError(404, "No such price", "resource_missing");
			Object.assign(prices.get(id), params, params.active === undefined ? {} : { active: params.active !== "false" });
			return prices.get(id);
		}
		if (method === "GET" && path === "/v1/billing_portal/configurations") return { object: "list", data: portalConfigurations };
		if (method === "POST" && path === "/v1/billing_portal/configurations") {
			const created = { id: next("bpc"), object: "billing_portal.configuration", is_default: false, ...params };
			portalConfigurations.push(created);
			return created;
		}
		if (method === "POST" && path === "/v1/billing_portal/sessions") {
			if (portalConfigurations.length === 0) {
				return stripeError(400, "You can’t create a portal session in test mode until you save your customer portal settings", "invalid_request_error");
			}
			return { object: "billing_portal.session", url: `https://billing.stripe.test/p/session/${params.customer}`, customer: params.customer, return_url: params.return_url };
		}
		return stripeError(404, `Unrecognized request URL: ${method} ${path}`, "resource_missing");
	}

	// A subscription as Stripe makes it from POST /v1/subscriptions: off-session on a saved card, or refused with the bank's words.
	function createSubscription(params) {
		const item = params.items?.[0] ?? {};
		const price = item.price ? prices.get(item.price) : null;
		const recurring = item.price_data?.recurring ?? price?.recurring ?? { interval: "month" };
		if (declined.has(params.default_payment_method)) return { status: 402, error: { message: declined.get(params.default_payment_method), code: "card_declined", type: "card_error" } };
		const method = paymentMethods.get(params.default_payment_method);
		if (!method || method.customer !== params.customer) return stripeError(400, "That payment method isn't attached to the customer", "resource_missing");
		const now = Math.floor(Date.now() / 1000);
		const created = {
			id: next("sub"),
			object: "subscription",
			status: "active",
			customer: params.customer,
			metadata: params.metadata ?? {},
			cancel_at_period_end: false,
			current_period_start: now,
			current_period_end: now + (recurring.interval === "year" ? 365 : 30) * 86_400,
			default_payment_method: params.default_payment_method,
			off_session: params.off_session,
			payment_behavior: params.payment_behavior,
			items: { data: [{ id: next("si"), price: { id: item.price ?? null, unit_amount: item.price_data?.unit_amount ?? price?.unit_amount, product: item.price_data?.product ?? price?.product, recurring } }] },
		};
		subscriptions.set(created.id, created);
		return created;
	}

	return {
		handler,
		requests,
		setupIntents,
		paymentMethods,
		accounts,
		sessions,
		customers,
		subscriptions,
		portalConfigurations,
		products,
		prices,
		coupons,
		// The next call to this route answers this instead.
		failNext(routeKey, answer = stripeError(500, "Stripe is having a bad day", "api_error")) {
			failures.set(routeKey, answer);
		},
		recover(routeKey) {
			failures.delete(routeKey);
		},
		// The pledger gave a card in a setup-mode Checkout Session: Stripe saves it on the customer and the session completes.
		completeSetup(sessionId, { card = true } = {}) {
			const session = sessions.get(sessionId);
			const method = { id: next("pm"), object: "payment_method", type: "card", customer: session.customer };
			paymentMethods.set(method.id, method);
			const intent = { id: next("seti"), object: "setup_intent", status: card ? "succeeded" : "requires_payment_method", customer: session.customer, payment_method: card ? method.id : null, metadata: session.setup_intent_data?.metadata ?? {} };
			setupIntents.set(intent.id, intent);
			Object.assign(session, { status: "complete", mode: "setup", setup_intent: intent.id, customer_details: { email: customers.get(session.customer)?.email ?? "pledger@example.net" } });
			return { session, method, intent };
		},
		// The bank refuses this card when it is charged.
		declineCard(paymentMethodId, message = "Your card was declined.") {
			declined.set(paymentMethodId, message);
		},
		completeOnboarding(accountId) {
			Object.assign(accounts.get(accountId), { charges_enabled: true, payouts_enabled: true, details_submitted: true });
			return accounts.get(accountId);
		},
		addCustomer(fields = {}) {
			const customer = { id: next("cus"), object: "customer", email: "buyer@example.com", name: null, ...fields };
			customers.set(customer.id, customer);
			return customer;
		},
		addSubscription(fields = {}) {
			const now = Math.floor(Date.now() / 1000);
			const subscription = {
				id: next("sub"),
				object: "subscription",
				status: "active",
				customer: null,
				metadata: {},
				cancel_at_period_end: false,
				current_period_start: now,
				current_period_end: now + 30 * 86_400,
				items: { data: [{ id: next("si"), price: { recurring: { interval: "month" } } }] },
				...fields,
			};
			subscriptions.set(subscription.id, subscription);
			return subscription;
		},
		// A Checkout Session as Stripe sends it once the buyer has paid.
		paidSession(sessionId, fields = {}) {
			const session = sessions.get(sessionId);
			Object.assign(session, { status: "complete", payment_status: "paid", payment_intent: session.mode === "payment" ? next("pi") : null, ...fields });
			return session;
		},
		event(type, object, { account } = {}) {
			return { id: next("evt"), object: "event", type, ...(account && { account }), livemode: false, created: Math.floor(Date.now() / 1000), data: { object } };
		},
	};
}
