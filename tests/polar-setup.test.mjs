import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getCatalog, getProductKey, hasExtraEmailsPrice, isLegacyAddon, isPricedRight } from "../lib/polar-catalog.js";
import { DEDICATED_IP_AT_COST, DEDICATED_IP_PRICE, PLANS, getPrice } from "../lib/plans.js";
import { setupPolar } from "../scripts/polar-setup.mjs";

// scripts/polar-setup.mjs against a stub of Polar's API that keeps products and meters like Polar: archived products stay,
// with is_archived set. The organization is the one with old prices, before the new pricing.
function createPolar({ products = [], meters = [], allowMultiple = false } = {}) {
	const state = { products: structuredClone(products), meters: structuredClone(meters), writes: [], next: 0 };
	const page = (items) => ({ items, pagination: { total_count: items.length, max_page: 1 } });
	async function request(path, { method = "GET", body, query } = {}) {
		if (method !== "GET") state.writes.push({ method, path, body });
		if (method === "GET" && path === "/v1/meters/") return page(state.meters.filter((meter) => !meter.archived_at));
		if (method === "POST" && path === "/v1/meters/") {
			const meter = { ...body, id: `meter_${++state.next}`, organization_id: "org_1", archived_at: null };
			state.meters.push(meter);
			return meter;
		}
		if (method === "GET" && path === "/v1/products/") {
			assert.equal(query.is_archived, "false");
			return page(state.products.filter((product) => !product.is_archived).toReversed());
		}
		if (method === "POST" && path === "/v1/products/") {
			const product = {
				...body,
				id: `prod_${++state.next}`,
				organization_id: "org_1",
				is_archived: false,
				prices: body.prices.map((price, index) => ({ ...price, id: `price_${state.next}_${index}`, is_archived: false, ...(price.meter_id && { meter: state.meters.find(({ id }) => id === price.meter_id) }) })),
			};
			state.products.push(product);
			return product;
		}
		if (method === "PATCH" && path.startsWith("/v1/products/")) {
			const product = state.products.find(({ id }) => id === path.split("/").at(-1));
			if (body.is_archived) product.is_archived = true;
			if (body.name) product.name = body.name;
			if (body.description) product.description = body.description;
			// Prices left out of the list are archived, never deleted.
			if (body.prices) {
				const kept = new Set(body.prices.map(({ id }) => id).filter(Boolean));
				for (const price of product.prices) if (!kept.has(price.id)) price.is_archived = true;
				for (const price of body.prices.filter(({ id }) => !id)) {
					product.prices.push({ ...price, id: `price_${++state.next}`, is_archived: false, meter: state.meters.find(({ id }) => id === price.meter_id) });
				}
			}
			return product;
		}
		if (method === "GET" && path === "/v1/organizations/org_1") return { id: "org_1", subscription_settings: { allow_multiple_subscriptions: allowMultiple } };
		throw new Error(`No stub for ${method} ${path}`);
	}
	return { state, request };
}

function oldProduct(id, planId, interval, amount) {
	return {
		id,
		name: `FlockStack ${planId}`,
		organization_id: "org_1",
		is_archived: false,
		recurring_interval: interval,
		recurring_interval_count: 1,
		prices: [{ id: `${id}_price`, amount_type: "fixed", price_amount: amount, price_currency: "usd", is_archived: false }],
		metadata: { flockstack_plan: planId, interval },
	};
}

// The dedicated IP add-ons from before the at-cost price: one per plan and interval, and a yearly one without a plan.
function oldAddon(id, planId, interval, amount) {
	const product = oldProduct(id, planId ?? "none", interval, amount);
	return { ...product, name: planId ? `FlockStack dedicated IP for ${planId}` : "FlockStack dedicated IP (yearly)", metadata: { ...(planId && { flockstack_plan: planId }), interval, flockstack_addon: "dedicated_ip" } };
}

// What FlockStack sold before: Starter at $12 and Pro at $55, with Scale and Max at today's prices and no extra emails.
const OLD_PRODUCTS = [
	oldProduct("prod_starter_m", "starter", "month", 1200),
	oldProduct("prod_starter_y", "starter", "year", 12_000),
	oldProduct("prod_pro_m", "pro", "month", 5500),
	oldProduct("prod_scale_m", "scale", "month", 10_900),
	oldProduct("prod_max_y", "max", "year", 299_000),
	oldAddon("prod_ip_pro_m", "pro", "month", 3500),
	oldAddon("prod_ip_scale_y", "scale", "year", 69_000),
	oldAddon("prod_ip_yearly", null, "year", 32_400),
	{ id: "prod_other", name: "Something else", is_archived: false, recurring_interval: "month", prices: [], metadata: {} },
];

describe("the catalog", () => {
	test("5 plans monthly and yearly and one monthly add-on, at lib/plans.js's prices, the plans with extra emails at 0.015 cents an email", () => {
		const catalog = getCatalog();
		assert.equal(catalog.length, 11);
		for (const item of catalog) {
			const body = item.getBody("meter_1");
			assert.equal(getProductKey(body), item.key, item.key);
			assert.equal(body.prices[0].price_amount, item.kind === "plan" ? getPrice(item.plan, item.interval) * 100 : DEDICATED_IP_PRICE * 100);
			assert.equal(body.recurring_interval, item.interval);
			if (item.kind === "plan") {
				assert.deepEqual(body.prices[1], {
					amount_type: "metered_unit",
					meter_id: "meter_1",
					unit_amount: "0.015",
					cap_amount: Math.round(item.plan.emailsPerMonth * 10 * 0.015),
					price_currency: "usd",
				});
				assert.equal(body.meter_interval, item.interval === "year" ? "month" : undefined, "yearly plans settle extra emails monthly");
			} else {
				assert.equal(body.prices.length, 1);
				assert.equal(body.metadata.flockstack_addon, "dedicated_ip");
				assert.equal(body.metadata.flockstack_plan, undefined, "no plan: one product for every plan from Pro up");
				assert.ok(body.description.startsWith(DEDICATED_IP_AT_COST), "the product says it is at cost");
			}
		}
		assert.deepEqual(
			catalog.filter(({ kind }) => kind === "addon").map(({ plan, interval, amount }) => [plan, interval, amount]),
			[[null, "month", 2700]],
			"one add-on, $27 a month, no yearly one"
		);
		assert.equal(PLANS.length * 2 + 1, catalog.length);
	});

	test("a product is ours by its metadata, and priced right by its one fixed price; metered prices may sit next to it", () => {
		assert.equal(getProductKey({ metadata: { flockstack_plan: "growth", interval: "year" } }), "growth:year");
		assert.equal(getProductKey({ metadata: { interval: "month", flockstack_addon: "dedicated_ip" } }), "dedicated_ip:month");
		assert.equal(getProductKey({ metadata: { interval: "year", flockstack_addon: "dedicated_ip" } }), null, "no yearly add-on");
		assert.equal(getProductKey({ metadata: { flockstack_plan: "max", interval: "month", flockstack_addon: "dedicated_ip" } }), null, "no per-plan add-on");
		assert.equal(isLegacyAddon({ metadata: { flockstack_plan: "max", interval: "month", flockstack_addon: "dedicated_ip" } }), true);
		assert.equal(isLegacyAddon({ metadata: { interval: "year", flockstack_addon: "dedicated_ip" } }), true);
		assert.equal(isLegacyAddon({ metadata: { interval: "month", flockstack_addon: "dedicated_ip" } }), false, "the one on sale");
		assert.equal(isLegacyAddon({ metadata: { flockstack_plan: "pro", interval: "month" } }), false, "a plan");
		assert.equal(getProductKey({ metadata: { flockstack_plan: "enterprise", interval: "month" } }), null);
		const product = oldProduct("p", "growth", "month", 2900);
		assert.equal(isPricedRight(product, 2900, "month"), true);
		assert.equal(isPricedRight(product, 2700, "month"), false);
		assert.equal(isPricedRight(product, 2900, "year"), false);
		const metered = { amount_type: "metered_unit", unit_amount: "0.015", meter: { name: "Extra emails" }, is_archived: false };
		assert.equal(isPricedRight({ ...product, prices: [...product.prices, metered] }, 2900, "month"), true);
		assert.equal(hasExtraEmailsPrice([metered]), true);
		assert.equal(hasExtraEmailsPrice([{ ...metered, unit_amount: "0.02" }]), false, "another price per email");
		assert.equal(hasExtraEmailsPrice([{ ...metered, is_archived: true }]), false);
	});
});

describe("scripts/polar-setup.mjs", () => {
	test("--dry-run reads Polar and says what it would update and create, without changing anything", async () => {
		const polar = createPolar({ products: OLD_PRODUCTS });
		const { steps, warning } = await setupPolar({ request: polar.request, isDryRun: true });
		assert.deepEqual(polar.state.writes, []);
		const by = (action) => steps.filter((step) => step.action === action).map(({ name }) => name);
		assert.deepEqual(by("update"), [
			"FlockStack Starter (monthly)",
			"FlockStack Starter (yearly)",
			"FlockStack Pro (monthly)",
			"FlockStack Scale (monthly)",
			"FlockStack Max (yearly)",
		]);
		assert.match(steps.find(({ action }) => action === "update").detail, /^prod_starter_m: \$12 a month -> \$9 a month \+ extra emails, renamed "FlockStack Starter \(monthly\)"$/);
		assert.deepEqual(by("create"), [
			"Meter: Extra emails",
			"FlockStack Growth (monthly)",
			"FlockStack Growth (yearly)",
			"FlockStack Pro (yearly)",
			"FlockStack Scale (yearly)",
			"FlockStack Max (monthly)",
			"FlockStack dedicated IP (monthly)",
		]);
		assert.deepEqual(by("archive").toSorted(), ["Old add-on: FlockStack dedicated IP (yearly)", "Old add-on: FlockStack dedicated IP for pro", "Old add-on: FlockStack dedicated IP for scale"], "a line for each old add-on");
		assert.match(steps.find(({ name }) => name.endsWith("for pro")).detail, /^prod_ip_pro_m, metadata pro \/ month: stops being sold, subscriptions on it go on$/);
		assert.match(warning, /Allow multiple subscriptions/);
	});

	test("a run updates the existing products in place, keeping their ids, creates the missing ones, and a second run changes nothing", async () => {
		const polar = createPolar({ products: OLD_PRODUCTS, allowMultiple: true });
		const first = await setupPolar({ request: polar.request, isDryRun: false });
		assert.equal(first.warning, null);
		assert.deepEqual(
			polar.state.products.filter(({ is_archived }) => is_archived).map(({ id }) => id).toSorted(),
			["prod_ip_pro_m", "prod_ip_scale_y", "prod_ip_yearly"],
			"only the old add-ons are archived"
		);
		assert.equal(polar.state.writes.some(({ method }) => method === "DELETE"), false);
		const [meter] = polar.state.meters;
		assert.deepEqual([meter.name, meter.aggregation, meter.filter.clauses[0]], ["Extra emails", { func: "sum", property: "count" }, { property: "name", operator: "eq", value: "flockstack_extra_emails" }]);

		const starter = polar.state.products.find(({ id }) => id === "prod_starter_m");
		assert.equal(starter.name, "FlockStack Starter (monthly)");
		assert.match(starter.description, /25,000 emails a month and 5,000 subscribers/);
		assert.deepEqual(
			starter.prices.map(({ amount_type, price_amount, unit_amount, is_archived }) => [amount_type, price_amount ?? unit_amount, is_archived]),
			[
				["fixed", 1200, true],
				["fixed", 900, false],
				["metered_unit", "0.015", false],
			],
			"the old price archived, the new ones next to it"
		);
		const scale = polar.state.products.find(({ id }) => id === "prod_scale_m");
		assert.equal(scale.prices[0].is_archived, false, "a fixed price already right is kept");
		// An existing yearly product settles extra emails once a year (Polar can't change its meter cycle): a year's cap.
		const maxYearly = polar.state.products.find(({ id }) => id === "prod_max_y").prices.find(({ amount_type }) => amount_type === "metered_unit");
		assert.equal(maxYearly.cap_amount, 2_000_000 * 10 * 12 * 0.015);

		const live = polar.state.products.filter((product) => !product.is_archived && getProductKey(product));
		assert.equal(live.length, 11);
		for (const item of getCatalog()) {
			const product = live.find((candidate) => getProductKey(candidate) === item.key);
			assert.ok(isPricedRight(product, item.amount, item.interval), item.key);
			assert.equal(hasExtraEmailsPrice(product.prices), item.kind === "plan", item.key);
		}

		const writes = polar.state.writes.length;
		const second = await setupPolar({ request: polar.request, isDryRun: false });
		assert.equal(polar.state.writes.length, writes, "nothing to do the second time");
		assert.equal(second.steps.every(({ action }) => action === "exists"), true);
		assert.equal(second.steps.length, 12);
	});

	test("a product on the wrong interval can't be updated into another: it's reported, never replaced", async () => {
		const polar = createPolar({ products: [{ ...oldProduct("prod_odd", "growth", "month", 2900), recurring_interval: "year" }] });
		const { steps } = await setupPolar({ request: polar.request, isDryRun: true });
		assert.match(steps.find(({ action }) => action === "problem").detail, /prod_odd bills every 1 year, not every month: fix it by hand/);
	});
});

