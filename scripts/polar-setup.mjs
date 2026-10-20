// Sets up FlockStack's Polar catalog from lib/plans.js (through lib/polar-catalog.js), changing only what differs, so it
// can run again:
//   1. The "Extra emails" meter: the sum of `count` on flockstack_extra_emails events, which lib/extra-emails.js sends.
//   2. Each plan, monthly and yearly: its fixed price and the extra emails metered price ($0.15 per 1,000, 0.015 cents an
//      email). Yearly plans settle extra emails every month.
//   3. The dedicated IP add-on, sold at cost: one monthly product ($27, no yearly one) for every plan from Pro up, with no
//      plan in its metadata.
//   4. Every other dedicated IP add-on product (one per plan, and any yearly one: metadata flockstack_addon) is archived, so
//      nothing sells it any more; a subscription on one goes on until it ends.
// A product that exists (found by its metadata: flockstack_plan, interval, flockstack_addon) is updated in place, so its
// id stays: its name and description, and its prices replaced by the new fixed price and the extra emails price. Polar
// archives the prices left out; subscriptions on them go on until they're changed. Only a missing product is created.
//   POLAR_ACCESS_TOKEN=... node scripts/polar-setup.mjs [--dry-run]
// POLAR_SERVER=sandbox sets up the sandbox (sandbox.polar.sh) instead of production. An organization token needs nothing
// else (scopes: products, meters, organizations:read); a personal token also needs POLAR_ORGANIZATION_ID. --dry-run reads
// Polar and prints every step without changing anything; without a token it doesn't read Polar either, and prints what
// an empty organization would get.
import { pathToFileURL } from "node:url";
import {
	DEDICATED_IP_ADDON,
	METER_METADATA,
	POLAR_API_VERSION,
	getCatalog,
	getExtraEmailsPrice,
	getMeterBody,
	getProductKey,
	hasExtraEmailsPrice,
	isLegacyAddon,
} from "../lib/polar-catalog.js";

function getBase(env) {
	return env.POLAR_SERVER === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
}

export function createRequest({ token, base, fetchImpl = fetch }) {
	return async function request(path, { method = "GET", body, query } = {}) {
		const response = await fetchImpl(`${base}${path}${query ? `?${new URLSearchParams(query)}` : ""}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
				"polar-version": POLAR_API_VERSION,
				...(body && { "content-type": "application/json" }),
			},
			...(body && { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`Polar answered ${response.status} to ${method} ${path}: ${(await response.text()).slice(0, 400)}`);
		return response.json();
	};
}

async function listAll(request, path, query) {
	const items = [];
	for (let page = 1; ; page++) {
		const list = await request(path, { query: { ...query, limit: "100", page: String(page) } });
		items.push(...(list.items ?? []));
		if (page >= (list.pagination?.max_page ?? 1)) return items;
	}
}

function isOurMeter(meter) {
	return !meter.archived_at && meter.metadata?.flockstack_meter === METER_METADATA.flockstack_meter;
}

function dollars(cents, interval) {
	return `$${(cents / 100).toLocaleString("en-US")} ${interval === "year" ? "a year" : "a month"}`;
}

function describePrices(product) {
	const prices = (product.prices ?? []).filter((price) => !price.is_archived);
	const fixed = prices.find((price) => price.amount_type === "fixed");
	const found = fixed ? `${dollars(fixed.price_amount, product.recurring_interval)}` : "no fixed price";
	return `${found}${hasExtraEmailsPrice(prices) ? " + extra emails" : ""}`;
}

function isSameFixed(price, amount) {
	return !price.is_archived && price.amount_type === "fixed" && price.price_currency === "usd" && price.price_amount === amount;
}

// The PATCH that brings a product to the catalog item, or null when it's there already. Polar replaces a product's
// prices with the list it's given: a price kept is named by its id, the others are archived (subscriptions on them go
// on), and new ones are created. Polar can't change a product's meter cycle once it's made, so an existing yearly product
// settles extra emails once a year: its cap covers 12 months.
function getUpdate(product, item, meterId) {
	const body = item.getBody(meterId);
	const prices = (product.prices ?? []).filter((price) => !price.is_archived);
	const fixed = prices.find((price) => isSameFixed(price, item.amount));
	const wanted = [fixed ? { id: fixed.id } : body.prices[0]];
	if (item.kind === "plan") {
		const months = item.interval === "year" && product.meter_interval !== "month" ? 12 : 1;
		const metered = getExtraEmailsPrice(item.plan, meterId, months);
		const kept = prices.find((price) => hasExtraEmailsPrice([price]) && price.meter_id === meterId && price.cap_amount === metered.cap_amount);
		wanted.push(kept ? { id: kept.id } : metered);
	}
	const isPricesRight = wanted.every(({ id }) => id) && prices.length === wanted.length;
	const update = {
		...(product.name !== body.name && { name: body.name }),
		...(product.description !== body.description && { description: body.description }),
		...(!isPricesRight && { prices: wanted }),
	};
	return Object.keys(update).length > 0 ? update : null;
}

// The whole run, against any `request` (tests give a stub). Returns the steps, each { action, name, detail }, where
// action is one of exists, create, created, update, updated, archive, archived, ignored, problem; and a warning when the organization can't
// hold an add-on next to a plan.
export async function setupPolar({ request, isDryRun, organizationId, hasToken = true }) {
	const steps = [];
	const step = (action, name, detail = "") => steps.push({ action, name, detail });
	const organization = organizationId ? { organization_id: organizationId } : {};

	// 1. The meter.
	const meters = hasToken ? await listAll(request, "/v1/meters/", { is_archived: "false" }) : [];
	let meter = meters.find(isOurMeter);
	if (meter) step("exists", "Meter: Extra emails", meter.id);
	else if (isDryRun) step("create", "Meter: Extra emails", "sum of count on flockstack_extra_emails events");
	else {
		meter = await request("/v1/meters/", { method: "POST", body: { ...getMeterBody(), ...organization } });
		step("created", "Meter: Extra emails", meter.id);
	}
	const meterId = meter?.id ?? "<meter id>";

	// 2 and 3. The products, newest first: the newest product of a key is the one the app sells, so that one is updated.
	const products = hasToken ? await listAll(request, "/v1/products/", { is_archived: "false", is_recurring: "true", sorting: "-created_at" }) : [];
	const byKey = new Map();
	for (const product of products) {
		const key = getProductKey(product);
		if (key) byKey.set(key, [...(byKey.get(key) ?? []), product]);
	}

	for (const item of getCatalog()) {
		const body = item.getBody(meterId);
		const price = dollars(item.amount, item.interval);
		const [current, ...older] = byKey.get(item.key) ?? [];
		for (const product of older) step("ignored", body.name, `${product.id}: an older product with the same metadata, never sold by the app; archive it by hand if you like`);
		if (!current) {
			if (isDryRun) step("create", body.name, `${price}${item.kind === "plan" ? " + extra emails at $0.15 per 1,000" : ""}`);
			else {
				const created = await request("/v1/products/", { method: "POST", body: { ...body, ...organization } });
				step("created", body.name, `${created.id}, ${price}`);
			}
			continue;
		}
		// Polar fixes a product's interval once it's set, so a product on another one can't be updated into this one.
		if (current.recurring_interval !== item.interval || (current.recurring_interval_count ?? 1) !== 1) {
			step("problem", body.name, `${current.id} bills every ${current.recurring_interval_count ?? 1} ${current.recurring_interval}, not every ${item.interval}: fix it by hand in Polar`);
			continue;
		}
		const update = getUpdate(current, item, meterId);
		if (!update) {
			step("exists", body.name, `${current.id}, ${describePrices(current)}`);
			continue;
		}
		const detail = `${current.id}: ${describePrices(current)} -> ${price}${item.kind === "plan" ? " + extra emails" : ""}${update.name ? `, renamed "${update.name}"` : ""}`;
		if (isDryRun) step("update", body.name, detail);
		else {
			await request(`/v1/products/${current.id}`, { method: "PATCH", body: update });
			step("updated", body.name, detail);
		}
	}

	// 4. The per-plan add-ons that were sold before the one price stop being sold. Archiving keeps their subscriptions.
	for (const product of products.filter(isLegacyAddon)) {
		const name = `Old add-on: ${product.name}`;
		const detail = `${product.id}, metadata ${product.metadata.flockstack_plan ?? "no plan"} / ${product.metadata.interval}: stops being sold, subscriptions on it go on`;
		if (isDryRun) step("archive", name, detail);
		else {
			await request(`/v1/products/${product.id}`, { method: "PATCH", body: { is_archived: true } });
			step("archived", name, detail);
		}
	}

	// An add-on is a second subscription next to the plan's, which Polar only allows once the organization says so.
	let warning = null;
	const orgId = organizationId ?? meter?.organization_id ?? products[0]?.organization_id;
	if (hasToken && orgId) {
		const org = await request(`/v1/organizations/${orgId}`).catch(() => null);
		if (org && org.subscription_settings?.allow_multiple_subscriptions !== true) {
			warning = `Turn on "Allow multiple subscriptions" in Polar (Settings, Subscriptions): the ${DEDICATED_IP_ADDON} add-on is a second subscription next to a customer's plan, and checkout refuses it until then.`;
		}
	} else {
		warning = `Check that "Allow multiple subscriptions" is on in Polar (Settings, Subscriptions): the ${DEDICATED_IP_ADDON} add-on needs it.`;
	}
	return { steps, warning };
}

const LABELS = {
	exists: "exists",
	create: "would create",
	created: "created",
	update: "would update",
	updated: "updated",
	archive: "would archive",
	archived: "archived",
	ignored: "ignored",
	problem: "PROBLEM",
};

export async function main(argv = process.argv.slice(2), env = process.env) {
	const isDryRun = argv.includes("--dry-run");
	const token = env.POLAR_ACCESS_TOKEN;
	if (!token && !isDryRun) {
		console.error("Set POLAR_ACCESS_TOKEN (an organization access token), or run with --dry-run.");
		process.exitCode = 1;
		return;
	}
	const base = getBase(env);
	console.log(`${isDryRun ? "Dry run" : "Setting up"} on ${base}, API version ${POLAR_API_VERSION}${token ? "" : " (no token: nothing is read from Polar)"}\n`);
	const { steps, warning } = await setupPolar({
		request: createRequest({ token, base }),
		isDryRun,
		organizationId: env.POLAR_ORGANIZATION_ID,
		hasToken: Boolean(token),
	});
	const width = Math.max(...steps.map(({ name }) => name.length));
	for (const { action, name, detail } of steps) console.log(`${name.padEnd(width)}  ${LABELS[action].padEnd(32)}  ${detail}`);
	const count = (...actions) => steps.filter(({ action }) => actions.includes(action)).length;
	console.log(
		`\n${count("created", "create")} ${isDryRun ? "to create" : "created"}, ${count("updated", "update")} ${isDryRun ? "to update" : "updated"}, ${count("archived", "archive")} ${isDryRun ? "to archive" : "archived"}, ${count("exists")} already right, ${count("problem")} to fix by hand.`
	);
	if (warning) console.log(`\n${warning}`);
	if (count("problem")) process.exitCode = 1;
	if (!isDryRun) console.log("\nThe app reads the products again within 10 minutes; plans show once both of their products are there.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`\n${error.message}`);
		process.exit(1);
	});
}
