// How much of the app Worker's script each class of request pulls in, from the build's own records: every route's entry file in
// .next/server/app lists the chunks it loads when its first request arrives (`R.c("server/chunks/...")`, the Turbopack runtime's
// list), and esbuild's metafile for the handler says how many bytes each chunk file is in the bundle. A class is a set of routes;
// its weight is the union of their chunks (a chunk two routes share is counted once), and "own" is the part no other class loads.
// It is a measure of what a cold request evaluates, on top of the parse cost of the whole script, which every request pays.
//   node scripts/route-weights.mjs [--json] [--routes]    (after `npx opennextjs-cloudflare build`)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT = ".open-next/server-functions/default";

// Which class a route (a key of app-paths-manifest.json, such as "/(app)/campaigns/(list)/page") is. First match wins.
export const CLASSES = [
	["system", [/^\/api\/(jobs|cron|webhooks|internal|health|admin)\//, /^\/api\/health\//]],
	["api", [/^\/api\/v1\//, /^\/api\/mcp\//, /^\/mcp\//, /^\/\.well-known\//, /^\/api\/auth\//]],
	[
		"reader",
		[
			/^\/(archive|c|o|f|p|embed|unsubscribe|confirm|keep|referral|poll|survey|preferences|pledge|gift|gifts|reader|subscribe|recommendations|welcome)\//,
			/^\/api\/(unsubscribe|views|visit|recommendations|embed-script|shop|audio|product-files)\//,
		],
	],
	["public", [/^\/\(site\)\//, /^\/(llms|llms-full|llms-docs)\.txt\//, /^\/(robots|sitemap|site\.webmanifest|opengraph-image|_global-error|_not-found)/, /^\/api\/(palette|support)\//]],
];

export function classify(route) {
	for (const [name, patterns] of CLASSES) if (patterns.some((pattern) => pattern.test(route))) return name;
	return "dashboard";
}

export function readRouteChunks(entryFile) {
	const source = readFileSync(entryFile, "utf8");
	return [...source.matchAll(/R\.c\("([^"]+)"\)/g)].map(([, name]) => name);
}

export function measure(root = ROOT, base = DEFAULT) {
	const server = join(root, base, ".next/server");
	const metaPath = join(root, base, "handler.mjs.meta.json");
	if (!existsSync(metaPath)) throw new Error("No handler.mjs.meta.json: run `npx opennextjs-cloudflare build` first.");
	const meta = JSON.parse(readFileSync(metaPath, "utf8"));
	const inputs = Object.values(meta.outputs)[0].inputs;
	const size = new Map();
	for (const [file, info] of Object.entries(inputs)) {
		const at = file.indexOf(".next/server/");
		if (at !== -1) size.set(file.slice(at + ".next/".length), info.bytesInOutput);
	}
	const total = Object.values(inputs).reduce((sum, { bytesInOutput }) => sum + bytesInOutput, 0);
	const manifest = JSON.parse(readFileSync(join(server, "app-paths-manifest.json"), "utf8"));
	const routes = Object.entries(manifest).map(([route, file]) => {
		const chunks = new Set(readRouteChunks(join(server, file)));
		const bytes = [...chunks].reduce((sum, chunk) => sum + (size.get(chunk) ?? 0), 0);
		return { route, class: classify(route), chunks, bytes };
	});
	const byClass = {};
	for (const item of routes) (byClass[item.class] ??= []).push(item);
	const union = (items) => new Set(items.flatMap(({ chunks }) => [...chunks]));
	const weigh = (set) => [...set].reduce((sum, chunk) => sum + (size.get(chunk) ?? 0), 0);
	const classes = Object.entries(byClass).map(([name, items]) => {
		const chunks = union(items);
		const others = union(routes.filter((item) => item.class !== name));
		const own = new Set([...chunks].filter((chunk) => !others.has(chunk)));
		const heaviest = items.reduce((best, item) => (item.bytes > best.bytes ? item : best));
		const lightest = items.reduce((best, item) => (item.bytes < best.bytes ? item : best));
		return { name, routes: items.length, unionBytes: weigh(chunks), ownBytes: weigh(own), heaviest: { route: heaviest.route, bytes: heaviest.bytes }, lightest: { route: lightest.route, bytes: lightest.bytes } };
	});
	const all = union(routes);
	return { totalBytes: total, routeChunksBytes: weigh(all), classes, routes: routes.map(({ route, class: name, bytes }) => ({ route, class: name, bytes })) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const result = measure();
	if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
	else {
		const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
		console.log(`handler.mjs ${mb(result.totalBytes)}; route chunks ${mb(result.routeChunksBytes)}, the rest (Next.js runtime, OpenNext, instrumentation, proxy) ${mb(result.totalBytes - result.routeChunksBytes)}\n`);
		console.log("class       routes  loads (union)   only this class   heaviest route                             lightest route");
		for (const item of result.classes) {
			console.log(`${item.name.padEnd(10)} ${String(item.routes).padStart(6)}  ${mb(item.unionBytes).padStart(13)}   ${mb(item.ownBytes).padStart(15)}   ${`${item.heaviest.route} ${mb(item.heaviest.bytes)}`.padEnd(42)} ${item.lightest.route} ${mb(item.lightest.bytes)}`);
		}
		if (process.argv.includes("--routes")) for (const item of result.routes.sort((a, b) => b.bytes - a.bytes)) console.log(`${mb(item.bytes).padStart(10)}  ${item.class.padEnd(10)} ${item.route}`);
	}
}
