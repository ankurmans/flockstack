// Renders the public pages once, from this app, into workers/public/dist: the files the public pages Worker serves
// (workers/public, docs/ARCHITECTURE-WORKERS.md). FlockStack Cloud only; a self-hosted server never needs it.
//   node scripts/build-public.mjs [--build] [--only us|eu] [--out workers/public/dist]
// --build runs the OpenNext build first (without it, .open-next must be there). The files go to dist/assets/us and dist/assets/eu,
// one folder per region, because each region has a Worker of its own (workers/public/wrangler.jsonc); dist/manifest.json lists them. Per region it starts the built Worker locally
// (wrangler dev, in workerd, the runtime production uses) with that region's settings and a dummy set of secrets of its own
// (nothing from .dev.vars or the account is read, and nothing is sent), asks it for every path in lib/public-routing.js and writes
// what it answers. Nothing is guessed: a page is what the app renders, including the 404 of a legal page that is not published.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANALYTICS_MARKERS, ANALYTICS_MARKER_PATTERN, PRERENDER_ENV } from "../lib/prerender.js";
import { PUBLIC_EXACT_PATHS, PUBLIC_LEGAL_PATHS } from "../lib/public-routing.js";
import { getRegionUrls } from "../lib/region.js";
import { bundleWorker } from "./bundle-worker.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const REGION_IDS = ["us", "eu"];
export const DEFAULT_OUT = join(ROOT, "workers/public/dist");

// The headers worth keeping from the app's answer: what the browser and crawlers act on. Not Transfer-Encoding, Date or
// anything the platform adds.
const KEPT_HEADERS = ["content-type", "cache-control", "content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "link", "vary", "access-control-allow-origin"];

export function parseArgs(argv) {
	const options = { build: false, only: null, out: DEFAULT_OUT };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--build") options.build = true;
		else if (argument === "--only") options.only = argv[++index];
		else if (argument === "--out") options.out = join(process.cwd(), argv[++index]);
		else throw new Error(`Unknown option ${argument}. Options: --build, --only us|eu, --out <directory>.`);
	}
	if (options.only !== null && !REGION_IDS.includes(options.only)) throw new Error("--only takes us or eu.");
	return options;
}

// The file a path is kept in, in its region's folder (each region's Worker uploads only its own). ".page" so no tool takes it for
// something to serve on its own.
export function fileFor(pathname) {
	return `${(pathname === "/" ? "/index" : pathname).slice(1)}.page`;
}

export function pickHeaders(headers) {
	const kept = {};
	for (const name of KEPT_HEADERS) {
		const value = headers.get(name);
		if (value) kept[name] = value;
	}
	return kept;
}

// What the build checks about one rendered page, so a render that went wrong is an error here and not a broken page later.
// Returns the problems found.
export function checkPage({ pathname, status, body, contentType }) {
	const problems = [];
	const isLegal = PUBLIC_LEGAL_PATHS.includes(pathname);
	if (status !== 200 && !(isLegal && status === 404)) problems.push(`answered ${status}`);
	if (!contentType) problems.push("has no content type");
	if (/text\/html/.test(contentType ?? "") && status === 200) {
		const text = body.toString("utf8");
		if (!/<\/html>\s*$/.test(text)) problems.push("HTML is cut off");
		if (!text.includes("<h1")) problems.push("has no h1");
	}
	return problems;
}

// The markers are in the data Next.js sends for the browser, so a page is checked to carry each of them the same number of
// times (a page that has some and not others would give the analytics component half of its settings).
export function countMarkers(text) {
	const counts = Object.fromEntries(Object.values(ANALYTICS_MARKERS).map((marker) => [marker, 0]));
	for (const [, marker] of text.matchAll(ANALYTICS_MARKER_PATTERN)) counts[marker]++;
	return counts;
}

// Where the markers are in a page, as byte offsets, so the Worker can stream the page and change only those bytes (a page of 4 MB
// is not read whole before its first byte is sent): [[start, end, marker, isEscaped], ...] in order. The page is read as one byte
// to a character, which the markers, plain ASCII, survive.
export function findMarkerReplacements(bytes) {
	const text = Buffer.from(bytes).toString("latin1");
	return [...text.matchAll(ANALYTICS_MARKER_PATTERN)].map((match) => [match.index, match.index + match[0].length, match[1], match[0].startsWith("\\") ? 1 : 0]);
}

export function hasMarkers(text) {
	const counts = Object.values(countMarkers(text));
	if (counts.every((count) => count === 0)) return false;
	if (new Set(counts).size !== 1) throw new Error(`analytics markers in uneven numbers: ${JSON.stringify(countMarkers(text))}`);
	return true;
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

// The Worker as the app runs it in a region, with the marker mode on (lib/prerender.js).
// Dummy secrets for the local run, only so the app starts (instrumentation.js): they sign nothing that is kept. They go in a
// .dev.vars file, which Wrangler never prints.
export function buildDevVars() {
	const secret = () => randomBytes(32).toString("hex");
	return `BETTER_AUTH_SECRET=${secret()}\nSUPPRESSION_HASH_KEY=${secret()}\nSES_ACCESS_KEY_ID=prerender-not-a-key\n`;
}

export function buildWranglerConfig({ region, appUrl, urls, root = ROOT }) {
	return {
		name: `flockstack-prerender-${region}`,
		main: join(root, ".worker/worker-entry.js"),
		no_bundle: true,
		compatibility_date: "2026-09-01",
		compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
		assets: { directory: join(root, ".open-next/assets"), binding: "ASSETS" },
		d1_databases: [{ binding: "DB", database_name: "prerender", database_id: "00000000-0000-0000-0000-000000000000" }],
		r2_buckets: ["IMAGES", "FILES", "EXPORTS"].map((binding, index) => ({ binding, bucket_name: `prerender-${index}` })),
		vars: {
			FLOCKSTACK_CLOUD: "true",
			FLOCKSTACK_REGION: region,
			APP_URL: appUrl,
			REGION_URL_US: urls.us,
			REGION_URL_EU: urls.eu,
			IMAGES_STORAGE: "r2",
			[PRERENDER_ENV]: "true",
			POSTHOG_KEY: ANALYTICS_MARKERS.token,
			...(process.env.SUPPORT_EMAIL ? { SUPPORT_EMAIL: process.env.SUPPORT_EMAIL } : {}),
		},
	};
}

async function waitUntilReady(origin, child, timeoutMs = 180_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error(`wrangler dev stopped (exit code ${child.exitCode})`);
		try {
			const response = await fetch(`${origin}/api/health`, { redirect: "manual" });
			await response.arrayBuffer();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	throw new Error(`wrangler dev did not start in ${timeoutMs / 1000} s`);
}

async function renderRegion({ region, out, root = ROOT }) {
	const urls = getRegionUrls({});
	const appUrl = urls[region];
	const dir = mkdtempSync(join(tmpdir(), `flockstack-prerender-${region}-`));
	const config = buildWranglerConfig({ region, appUrl, urls, root });
	const configPath = join(dir, "wrangler.json");
	writeFileSync(configPath, JSON.stringify(config));
	writeFileSync(join(dir, ".dev.vars"), buildDevVars());
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const wranglerBin = join(root, "node_modules/wrangler/bin/wrangler.js");
	const child = spawn(process.execPath, [wranglerBin, "dev", "--config", configPath, "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "state")], {
		cwd: root,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
	});
	let log = "";
	child.stdout.on("data", (chunk) => (log = (log + chunk).slice(-4000)));
	child.stderr.on("data", (chunk) => (log = (log + chunk).slice(-4000)));
	const entries = {};
	const digest = createHash("sha256");
	try {
		await waitUntilReady(origin, child);
		for (const pathname of PUBLIC_EXACT_PATHS) {
			const response = await fetch(`${origin}${pathname}`, { redirect: "manual", headers: { accept: "*/*" } });
			const body = Buffer.from(await response.arrayBuffer());
			const contentType = response.headers.get("content-type");
			const problems = checkPage({ pathname, status: response.status, body, contentType });
			if (problems.length > 0) throw new Error(`${region} ${pathname}: ${problems.join(", ")}`);
			let replacements = [];
			try {
				if (/^(text|application)\//.test(contentType) && hasMarkers(body.toString("utf8"))) replacements = findMarkerReplacements(body);
			} catch (error) {
				throw new Error(`${region} ${pathname}: ${error.message}`);
			}
			const file = fileFor(pathname);
			mkdirSync(dirname(join(out, "assets", region, file)), { recursive: true });
			writeFileSync(join(out, "assets", region, file), body);
			digest.update(`${region} ${pathname} `).update(body);
			entries[pathname] = { file, status: response.status, headers: pickHeaders(response.headers), replacements, bytes: body.length };
		}
	} catch (error) {
		throw new Error(`${error.message}\n--- wrangler dev, last output ---\n${log}`);
	} finally {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			// Already gone.
		}
		rmSync(dir, { recursive: true, force: true });
	}
	return { entries, digest: digest.digest("hex") };
}

export async function buildPublic({ build = false, only = null, out = DEFAULT_OUT, root = ROOT } = {}) {
	if (build) {
		rmSync(join(root, ".next"), { recursive: true, force: true });
		const result = spawnSync("npx", ["opennextjs-cloudflare", "build"], { cwd: root, stdio: "inherit" });
		if (result.status !== 0) throw new Error("The OpenNext build failed.");
	}
	if (!existsSync(join(root, ".open-next/server-functions/default/handler.mjs"))) {
		throw new Error("build-public: .open-next is missing. Run `npm run build:public` (it builds first) or `npx opennextjs-cloudflare build`.");
	}
	bundleWorker();
	// A region left out of this run (--only) keeps what a run before wrote for it.
	for (const region of only ? [only] : REGION_IDS) rmSync(join(out, "assets", region), { recursive: true, force: true });
	mkdirSync(join(out, "assets"), { recursive: true });
	const regions = {};
	const digests = [];
	for (const region of only ? [only] : REGION_IDS) {
		console.log(`build-public: rendering ${PUBLIC_EXACT_PATHS.length} paths for ${region}`);
		const { entries, digest } = await renderRegion({ region, out, root });
		regions[region] = entries;
		digests.push(digest);
	}
	// What the build is called: a hash of every page's bytes, so a change to any of them changes it.
	const build_id = createHash("sha256").update(JSON.stringify(regions)).update(digests.join()).digest("hex").slice(0, 12);
	const previous = only && existsSync(join(out, "manifest.json")) ? JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).regions : {};
	const manifest = { version: 1, build: build_id, regions: { ...previous, ...regions } };
	writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
	const bytes = Object.values(regions).flatMap((paths) => Object.values(paths)).reduce((sum, { bytes: size }) => sum + size, 0);
	console.log(`build-public: ${Object.keys(regions).join(" and ")} written to ${out} (${(bytes / 1e6).toFixed(1)} MB, build ${build_id})`);
	return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await buildPublic(parseArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(`\n${error.message}`);
		process.exit(1);
	}
}
