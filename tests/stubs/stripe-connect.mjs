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
	const schedules = new Map();
	const invoices = new Map();
	const invoiceItems = new Map();
	const discounts = new Map();
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
			...(headers.has("stripe-version") && { apiVersion: headers.get("stripe-version") }),
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

	function route({ method, path, params, account, apiVersion }) {
		const [, , resource, id, sub] = path.split("/");
		if (resource === "subscription_schedules") {
			if (apiVersion !== "2026-09-30.endive") return stripeError(400, "Pin the current pause schedule API version", "parameter_unknown");
			if (method === "GET" && id) return schedules.has(id) ? structuredClone(schedules.get(id)) : stripeError(404, "No such schedule", "resource_missing");
			if (method === "POST" && !id) {
				const current = subscriptions.get(params.from_subscription);
				if (!current || current.billing_mode?.type !== "flexible" || current.collection_method !== "charge_automatically" || current.schedule) return stripeError(400, "Subscription cannot start a pause schedule", "subscription_schedule_invalid");
				if (Object.keys(params).some(key => !["from_subscription", "pause_schedules"].includes(key))) return stripeError(400, "Only native pause configuration is accepted with from_subscription", "parameter_invalid");
				const pause = params.pause_schedules?.[0];
				if (params.pause_schedules?.length !== 1 || pause?.pause?.pause_at?.type !== "timestamp" || ![1, 3, 6].includes(Number(pause?.resume?.resume_at?.duration?.interval_count))) return stripeError(400, "Use a bounded native future pause", "parameter_invalid");
				const start = Number(pause.pause.pause_at.timestamp), resume = new Date(start * 1000), originalDay = resume.getUTCDate();
				resume.setUTCDate(1); resume.setUTCMonth(resume.getUTCMonth() + Number(pause.resume.resume_at.duration.interval_count));
				resume.setUTCDate(Math.min(originalDay, new Date(Date.UTC(resume.getUTCFullYear(), resume.getUTCMonth() + 1, 0)).getUTCDate()));
				const created = { id: next("sub_sched"), object: "subscription_schedule", customer: current.customer, subscription: current.id, status: "active", metadata: {}, end_behavior: "release", default_settings: { collection_method: current.collection_method }, phases: [{ start_date: current.current_period_start, end_date: Math.floor(+resume / 1000), items: current.items.data.map(item => ({ price: item.price.id, quantity: item.quantity })) }], pause_schedules: [{ key: next("pause"), pause: { pause_at: start, settings: structuredClone(pause.pause.settings) }, resume: { resume_at: Math.floor(+resume / 1000), settings: structuredClone(pause.resume.settings) } }] };
				schedules.set(created.id, created); current.schedule = created.id; return structuredClone(created);
			}
			if (method === "POST" && id) {
				const schedule = schedules.get(id), current = schedule && subscriptions.get(schedule.subscription);
				if (!schedule || !current) return stripeError(404, "No such schedule", "resource_missing");
				if (sub === "release") { schedule.status = "released"; schedule.released_subscription = current.id; schedule.subscription = null; current.schedule = null; return structuredClone(schedule); }
				if (params.metadata) schedule.metadata = { ...schedule.metadata, ...params.metadata };
				if (Object.hasOwn(params, "pause_schedules")) {
					if (params.pause_schedules === "") {
						if (current.status !== "active") return stripeError(400, "An active pause cannot be removed", "subscription_schedule_invalid");
						schedule.pause_schedules = [];
					} else {
						const change = params.pause_schedules[0], entry = schedule.pause_schedules[0];
						if (params.pause_schedules.length !== 1 || !entry || change.key !== entry.key) return stripeError(400, "Pause key changed", "subscription_schedule_invalid");
						if (change.resume?.resume_at?.type === "now") { entry.resume.resume_at = Math.floor(Date.now() / 1000); resumeSubscription(current); }
						if (change.resume?.settings) entry.resume.settings = { ...entry.resume.settings, ...change.resume.settings };
					}
				}
				return structuredClone(schedule);
			}
		}
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
		if (method === "GET" && resource === "coupons" && id) return coupons.get(id) ?? stripeError(404, "No such coupon", "resource_missing");
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
		if (method === "POST" && path === "/v1/invoices") {
			if (!customers.has(params.customer)) return stripeError(404, "No such customer", "resource_missing");
			const created = { id: next("in"), object: "invoice", customer: params.customer, currency: params.currency ?? "usd", status: "draft", paid: false, collection_method: params.collection_method ?? "charge_automatically", auto_advance: params.auto_advance === "true", pending_invoice_items_behavior: params.pending_invoice_items_behavior, days_until_due: Number(params.days_until_due), metadata: params.metadata ?? {}, lines: { data: [], has_more: false }, created: Math.floor(Date.now() / 1000), total: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0, status_transitions: { paid_at: null } };
			invoices.set(created.id, created); return structuredClone(created);
		}
		if (method === "POST" && path === "/v1/invoiceitems") {
			const invoice = invoices.get(params.invoice);
			if (!invoice || invoice.status !== "draft" || invoice.customer !== params.customer) return stripeError(400, "Only an owned draft can receive this line", "invoice_not_editable");
			const item = { id: next("ii"), object: "invoiceitem", invoice: invoice.id, customer: params.customer, amount: Number(params.amount), currency: params.currency, metadata: params.metadata ?? {}, description: params.description };
			invoiceItems.set(item.id, item);
			invoice.lines.data.push({ id: next("il"), parent: { invoice_item_details: { invoice_item: item.id } }, amount: item.amount, currency: item.currency, metadata: item.metadata, proration: false });
			invoice.total += item.amount; invoice.amount_due += item.amount; invoice.amount_remaining += item.amount;
			return structuredClone(item);
		}
		if (method === "GET" && resource === "invoiceitems" && id) return invoiceItems.get(id) ?? stripeError(404, "No such invoice item", "resource_missing");
		if (method === "POST" && resource === "invoices" && sub === "finalize") {
			const invoice = invoices.get(id);
			if (!invoice || invoice.status !== "draft") return stripeError(400, "Only a draft can be finalized", "invoice_not_editable");
			Object.assign(invoice, { status: "open", number: `INV-${invoice.id}`, auto_advance: params.auto_advance === "true", hosted_invoice_url: `https://invoice.stripe.com/i/${invoice.id}`, invoice_pdf: `https://pay.stripe.com/invoice/${invoice.id}/pdf` });
			return structuredClone(invoice);
		}
		if (method === "POST" && resource === "invoices" && sub === "void") {
			const invoice = invoices.get(id);
			if (!invoice || !["open", "uncollectible"].includes(invoice.status)) return stripeError(400, "Only an unpaid finalized invoice can be voided", "invoice_not_editable");
			Object.assign(invoice, { status: "void", amount_remaining: 0 }); return structuredClone(invoice);
		}
		if (method === "GET" && path === "/v1/subscriptions") {
			const data = [...subscriptions.values()].filter((subscription) => !params.customer || subscription.customer === params.customer);
			return { object: "list", data, has_more: false };
		}
		if (method === "POST" && path === "/v1/subscriptions") return createSubscription(params);
		if (method === "POST" && resource === "subscriptions" && id && !sub) {
			const current = subscriptions.get(id);
			if (!current) return stripeError(404, "No such subscription", "resource_missing");
			if (Object.hasOwn(params, "discounts")) {
				const coupon = coupons.get(params.discounts?.[0]?.coupon);
				if (!coupon || coupon.valid === false || coupon.max_redemptions && Number(coupon.times_redeemed) >= Number(coupon.max_redemptions)) return stripeError(400, "Coupon isn't available", "coupon_invalid");
				const discount = { id: next("di"), object: "discount", source: { type: "coupon", coupon: coupon.id }, start: Math.floor(Date.now() / 1000), end: null };
				discounts.set(discount.id, discount); current.discounts = [discount.id]; coupon.times_redeemed = Number(coupon.times_redeemed ?? 0) + 1;
			}
			if (Object.hasOwn(params, "cancel_at_period_end")) {
				current.cancel_at_period_end = params.cancel_at_period_end === "true";
				current.cancel_at = current.cancel_at_period_end ? current.items?.data?.[0]?.current_period_end ?? current.current_period_end : null;
			}
			return structuredClone(current);
		}
		if (method === "DELETE" && resource === "subscriptions" && id && !sub) {
			const current = subscriptions.get(id);
			if (!current) return stripeError(404, "No such subscription", "resource_missing");
			if (current.schedule || params.invoice_now !== "false" || params.prorate !== "false") return stripeError(400, "Cancel without a schedule, new invoice or proration", "subscription_cancel_invalid");
			current.status = "canceled"; current.canceled_at = Math.floor(Date.now() / 1000); current.cancel_at_period_end = false;
			return structuredClone(current);
		}
		if (method === "POST" && resource === "subscriptions" && sub === "resume") {
			const current = subscriptions.get(id);
			if (apiVersion !== "2026-09-30.endive" || !current || current.status !== "paused" || current.schedule || params.payment_behavior !== "resume_on_payment_success") return stripeError(400, "Subscription cannot resume", "subscription_resume_invalid");
			resumeSubscription(current); return structuredClone(current);
		}
		if (method === "GET" && resource === "setup_intents" && id) return setupIntents.get(id) ?? stripeError(404, "No such setup_intent", "resource_missing");
		if (method === "POST" && resource === "payment_methods" && sub === "detach") {
			const detached = paymentMethods.get(id);
			if (!detached) return stripeError(404, "No such payment method", "resource_missing");
			detached.customer = null;
			return detached;
		}
		if (method === "GET" && path === "/v1/invoices") {
			const values = [...invoices.values()].filter(invoice => (!params.customer || invoice.customer === params.customer) && (!params.subscription || (invoice.subscription ?? invoice.parent?.subscription_details?.subscription) === params.subscription));
			const start = params.starting_after ? values.findIndex(invoice => invoice.id === params.starting_after) + 1 : 0;
			const limit = Number(params.limit ?? 10);
			return { object: "list", data: values.slice(start, start + limit), has_more: values.length > start + limit };
		}
		if (method === "GET" && resource === "invoices" && id) return invoices.get(id) ?? stripeError(404, "No such invoice", "resource_missing");
		if (method === "GET" && resource === "subscriptions" && id) {
			const original = subscriptions.get(id);
			if (!original) return stripeError(404, "No such subscription", "resource_missing");
			const copy = JSON.parse(JSON.stringify(original));
			if ((params.expand?.includes("discounts") || params.expand?.includes("discounts.source.coupon")) && Array.isArray(copy.discounts)) copy.discounts = copy.discounts.map((discount) => typeof discount === "string" ? structuredClone(discounts.get(discount) ?? discount) : discount);
			if (params.expand?.includes("items.data.discounts") || params.expand?.includes("items.data.discounts.source.coupon")) for (const item of copy.items?.data ?? []) if (Array.isArray(item.discounts)) item.discounts = item.discounts.map((discount) => typeof discount === "string" ? structuredClone(discounts.get(discount) ?? discount) : discount);
			if (params.expand?.some(value => value.endsWith("discounts.source.coupon"))) {
				for (const discount of [...(copy.discounts ?? []), ...(copy.items?.data ?? []).flatMap(item => item.discounts ?? [])]) {
					if (typeof discount?.source?.coupon === "string" && coupons.has(discount.source.coupon)) discount.source.coupon = structuredClone(coupons.get(discount.source.coupon));
				}
			}
			if (params.expand?.includes("latest_invoice") && typeof copy.latest_invoice === "string") copy.latest_invoice = structuredClone(invoices.get(copy.latest_invoice) ?? copy.latest_invoice);
			return copy;
		}
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
		if (method === "GET" && resource === "billing_portal" && id === "configurations" && sub) return portalConfigurations.find(configuration => configuration.id === sub) ?? stripeError(404, "No such configuration", "resource_missing");
		if (method === "POST" && path === "/v1/billing_portal/configurations") {
			const created = { id: next("bpc"), object: "billing_portal.configuration", active: true, is_default: false, ...params };
			if (created.metadata?.kind === "group_subscription") for (const feature of Object.values(created.features ?? {})) if (feature.enabled !== undefined) feature.enabled = feature.enabled === "true";
			if (created.login_page?.enabled !== undefined) created.login_page.enabled = created.login_page.enabled === "true";
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
	function resumeSubscription(current) {
		const at = Math.floor(Date.now() / 1000);
		if (current.resumeRequiresPayment) {
			const invoice = { id: next("in"), object: "invoice", customer: current.customer, subscription: current.id, currency: current.currency, total: current.items.data[0].price.unit_amount, amount_paid: 0, amount_due: current.items.data[0].price.unit_amount, status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/synthetic-resume", lines: { data: [], has_more: false } };
			invoices.set(invoice.id, invoice); current.latest_invoice = invoice.id; return;
		}
		current.status = "active"; current.current_period_start = at; current.current_period_end = at + 30 * 86400;
		for (const item of current.items?.data ?? []) { item.current_period_start = current.current_period_start; item.current_period_end = current.current_period_end; }
	}

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
		schedules,
		invoices,
		invoiceItems,
		discounts,
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
