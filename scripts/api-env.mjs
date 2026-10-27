// Lists the environment variables and bindings the lean API Worker's bundle reads, so a new region or a rebuilt Worker gets all the
// secrets it needs: secrets belong to one Worker, so flockstack-api and flockstack-api-eu each need their own copy of the app's.
//   node scripts/api-env.mjs            (builds workers/api/dist first when it is missing)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OUT_FILE, buildApiWorker } from "./build-api-worker.mjs";

// What the platform and the libraries probe for and the code never needs set.
const IGNORED = /^(NODE_ENV|CI|DEBUG|NODE_V8_COVERAGE|JEST_WORKER_ID|NO_PROXY|HTTP_PROXY|HTTPS_PROXY|LOCALAPPDATA|AWS_LOGIN_CACHE_DIRECTORY|UNDICI_NO_FG|FLOCKSTACK_SQLITE|VERCEL_.*|NEXT_PUBLIC_.*|KV_REST_.*)$/;
// Bindings of the Worker (workers/api/wrangler.jsonc).
export const BINDINGS = ["DB", "IMAGES", "FILES", "EXPORTS", "AI", "APP", "COLLABORATION_STORAGE"];

export function listEnvironment(source) {
	// process.env.NAME, and env.NAME where a function takes process.env as its argument (lib/config.js, lib/region.js).
	const names = new Set([...source.matchAll(/(?:process\.env|\benv\d*)\.([A-Z][A-Z0-9_]{2,})/g)].map(([, name]) => name));
	return [...names].filter((name) => !IGNORED.test(name) && !BINDINGS.includes(name)).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (!existsSync(OUT_FILE)) await buildApiWorker();
	console.log(`Bindings (wrangler.jsonc): ${BINDINGS.join(", ")}\n`);
	console.log("Variables and secrets the bundle reads (set what the app has, `wrangler secret put <NAME> --config workers/api/wrangler.jsonc [--env eu]`):");
	for (const name of listEnvironment(readFileSync(OUT_FILE, "utf8"))) console.log(`  ${name}`);
}
