// Moves the Worker routes of the newsletters' hosts between a region's app Worker and its router, so that what a reader's mail client
// sends to a newsletter's own address (the open pixel, the click redirect, unsubscribe) reaches the router and, through it, the readers
// Worker. A newsletter's host is not the router's: its address is a Cloudflare for SaaS custom hostname, or `<slug>.SHARED_DOMAIN`, and
// each has a route `<host>/*` to a Worker (lib/custom-hostnames.js, README, Domains on Cloudflare). While those routes name the app
// Worker, the router never sees them and READERS_ENABLED changes nothing for them.
//
//   node scripts/route-archive-hosts.mjs --to router [--only us|eu] [--zone <id> ...]            lists what would move
//   node scripts/route-archive-hosts.mjs --to router --apply                                    moves it
//   node scripts/route-archive-hosts.mjs --to app --apply                                       moves it back (the rollback)
//
// Zones: --zone, else CLOUDFLARE_SAAS_ZONE_ID and CLOUDFLARE_SHARED_ZONE_ID. The token is CLOUDFLARE_API_TOKEN (Workers Routes: Edit on
// those zones). Only routes that name a region's app Worker (or its router, going back) are touched, and only their Worker: patterns are
// kept. A route that names anything else is left alone and listed. Without --apply nothing is changed. After moving routes to the
// routers, set FLOCKSTACK_WORKER_NAME on each app Worker to its router's name (flockstack-router, flockstack-router-eu): lib/custom-
// hostnames.js compares a host's route with it, and takes a route that names another Worker for another region's. docs/ARCHITECTURE-WORKERS.md
// has the runbook.
import { fileURLToPath } from "node:url";

export const REGION_WORKERS = {
	us: { app: "flockstack", router: "flockstack-router" },
	eu: { app: "flockstack-eu", router: "flockstack-router-eu" },
};
const API = "https://api.cloudflare.com/client/v4";

export function parseArgs(argv, env = process.env) {
	const options = { to: null, only: null, apply: false, zones: [] };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--to") options.to = argv[++index];
		else if (argument === "--only") options.only = argv[++index];
		else if (argument === "--zone") options.zones.push(argv[++index]);
		else if (argument === "--apply") options.apply = true;
		else throw new Error(`Unknown option ${argument}. Options: --to router|app, --only us|eu, --zone <id>, --apply.`);
	}
	if (!["router", "app"].includes(options.to)) throw new Error("--to takes router or app.");
	if (options.only !== null && !Object.hasOwn(REGION_WORKERS, options.only)) throw new Error("--only takes us or eu.");
	if (options.zones.length === 0) options.zones = [env.CLOUDFLARE_SAAS_ZONE_ID, env.CLOUDFLARE_SHARED_ZONE_ID].map((id) => String(id ?? "").trim()).filter(Boolean);
	options.zones = [...new Set(options.zones)];
	if (options.zones.length === 0) throw new Error("No zone: pass --zone <id>, or set CLOUDFLARE_SAAS_ZONE_ID and CLOUDFLARE_SHARED_ZONE_ID.");
	return options;
}

// What to do with a list of routes: the ones to move, with the Worker they get, and the ones left alone.
export function planMoves(routes, { to, only = null }) {
	const from = to === "router" ? "app" : "router";
	const regions = Object.entries(REGION_WORKERS).filter(([region]) => !only || region === only);
	const moves = [];
	const left = [];
	for (const route of routes) {
		const region = regions.find(([, workers]) => workers[from] === route.script);
		if (region) moves.push({ id: route.id, pattern: route.pattern, from: route.script, to: region[1][to] });
		else left.push({ pattern: route.pattern, script: route.script ?? null });
	}
	return { moves, left };
}

async function call(fetchImpl, token, method, path, body) {
	const response = await fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body && { "content-type": "application/json" }) }, ...(body && { body: JSON.stringify(body) }) });
	const data = await response.json().catch(() => null);
	if (!response.ok || data?.success === false) throw new Error(`Cloudflare refused ${method} ${path}: ${(data?.errors ?? []).map(({ code, message }) => `${message} (${code})`).join("; ") || `HTTP ${response.status}`}`);
	return data;
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
	const options = parseArgs(argv, env);
	const token = String(env.CLOUDFLARE_API_TOKEN ?? "").trim();
	if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
	const result = [];
	for (const zone of options.zones) {
		const { result: routes } = await call(fetchImpl, token, "GET", `/zones/${encodeURIComponent(zone)}/workers/routes`);
		const { moves, left } = planMoves(routes ?? [], options);
		log(`\nZone ${zone}: ${moves.length} route(s) to move, ${left.length} left alone.`);
		for (const move of moves) log(`  ${move.pattern}: ${move.from} -> ${move.to}`);
		for (const other of left) log(`  (kept) ${other.pattern} -> ${other.script ?? "no Worker"}`);
		if (options.apply) {
			for (const move of moves) {
				await call(fetchImpl, token, "PUT", `/zones/${encodeURIComponent(zone)}/workers/routes/${encodeURIComponent(move.id)}`, { pattern: move.pattern, script: move.to });
				log(`  moved ${move.pattern}`);
			}
		}
		result.push({ zone, moves, left });
	}
	log(options.apply ? "\nDone. Set FLOCKSTACK_WORKER_NAME on each app Worker to match (see the header of this script)." : "\nDry run: nothing changed. Add --apply to move them.");
	return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
