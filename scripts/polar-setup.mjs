// Creates FlockStack's Polar products: 5 plans x month/year, at lib/plans.js's prices, with the metadata lib/polar.js finds
// them by (flockstack_plan, interval). It only creates what's missing, so it can run again.
//   POLAR_ACCESS_TOKEN=... node scripts/polar-setup.mjs [--dry-run]
// POLAR_SERVER=sandbox sets up the sandbox (sandbox.polar.sh) instead of production. An organization token needs nothing
// else; a personal token also needs POLAR_ORGANIZATION_ID. --dry-run prints what it would create and changes nothing;
// without a token it doesn't read Polar either, so it lists all 10.
import { INTERVALS, PLANS, getPrice } from "../lib/plans.js";

const isDryRun = process.argv.includes("--dry-run");
const token = process.env.POLAR_ACCESS_TOKEN;
const base = process.env.POLAR_SERVER === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

if (!token && !isDryRun) {
	console.error("Set POLAR_ACCESS_TOKEN (an organization access token), or run with --dry-run.");
	process.exit(1);
}

const formatNumber = (value) => value.toLocaleString("en-US");

function wanted() {
	return PLANS.flatMap((plan) =>
		INTERVALS.map((interval) => ({
			key: `${plan.id}:${interval}`,
			plan,
			interval,
			amount: getPrice(plan, interval) * 100,
			body: {
				name: `FlockStack ${plan.name} (${interval === "year" ? "yearly" : "monthly"})`,
				description: `${formatNumber(plan.emailsPerMonth)} emails a month and ${formatNumber(plan.subscribers)} subscribers, with every feature.`,
				recurring_interval: interval,
				recurring_interval_count: 1,
				prices: [{ amount_type: "fixed", price_amount: getPrice(plan, interval) * 100, price_currency: "usd" }],
				metadata: { flockstack_plan: plan.id, interval },
				...(process.env.POLAR_ORGANIZATION_ID && { organization_id: process.env.POLAR_ORGANIZATION_ID }),
			},
		}))
	);
}

async function request(path, { method = "GET", body, query } = {}) {
	const response = await fetch(`${base}${path}${query ? `?${new URLSearchParams(query)}` : ""}`, {
		method,
		headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body && { "content-type": "application/json" }) },
		...(body && { body: JSON.stringify(body) }),
	});
	if (!response.ok) throw new Error(`Polar answered ${response.status} to ${method} ${path}: ${(await response.text()).slice(0, 400)}`);
	return response.json();
}

async function listExisting() {
	const existing = new Map();
	for (let page = 1; ; page++) {
		const list = await request("/v1/products/", { query: { is_archived: "false", is_recurring: "true", limit: "100", page: String(page), sorting: "-created_at" } });
		for (const product of list.items ?? []) {
			const { flockstack_plan: plan, interval } = product.metadata ?? {};
			if (plan && interval && !existing.has(`${plan}:${interval}`)) existing.set(`${plan}:${interval}`, product);
		}
		if (page >= (list.pagination?.max_page ?? 1)) return existing;
	}
}

function describeMismatch(product, { amount, interval }) {
	const [price] = (product.prices ?? []).filter((candidate) => !candidate.is_archived);
	const found = price ? `${price.price_amount} ${String(price.price_currency).toUpperCase()} cents every ${product.recurring_interval}` : "no price";
	return `${product.id} has ${found}, should be ${amount} USD cents every ${interval}`;
}

function isRight(product, { amount, interval }) {
	const prices = (product.prices ?? []).filter((price) => !price.is_archived);
	return (
		product.recurring_interval === interval &&
		prices.length === 1 &&
		prices[0].amount_type === "fixed" &&
		prices[0].price_currency === "usd" &&
		prices[0].price_amount === amount
	);
}

const existing = token ? await listExisting() : new Map();
console.log(`${isDryRun ? "Dry run" : "Setting up"} on ${base}${token ? "" : " (no token: nothing is read from Polar)"}`);

const rows = [];
let hasProblem = false;
for (const item of wanted()) {
	const found = existing.get(item.key);
	const dollars = `$${item.amount / 100} ${item.interval === "year" ? "a year" : "a month"}`;
	if (found && isRight(found, item)) {
		rows.push([item.body.name, dollars, "exists", found.id]);
	} else if (found) {
		hasProblem = true;
		rows.push([item.body.name, dollars, "MISMATCH, not offered until fixed", describeMismatch(found, item)]);
	} else if (isDryRun) {
		rows.push([item.body.name, dollars, "would create", ""]);
	} else {
		const created = await request("/v1/products/", { method: "POST", body: item.body });
		rows.push([item.body.name, dollars, "created", created.id]);
	}
}

for (const row of rows) console.log(row.filter(Boolean).join("  |  "));
const count = (label) => rows.filter(([, , status]) => status === label).length;
console.log(`\n${count("created")} created, ${count("would create")} would be created, ${count("exists")} already right, ${rows.length - count("created") - count("would create") - count("exists")} to fix by hand in Polar.`);
if (hasProblem) process.exitCode = 1;
