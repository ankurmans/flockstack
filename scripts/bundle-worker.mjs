// Run by Wrangler before it uploads (`build.command` in wrangler.jsonc): bundles the Worker into .worker/, which wrangler.jsonc
// names as `main` with `no_bundle`. Wrangler's own `minify: true` would do the job, but it renames and rewrites the code of a
// 40 MB bundle, and V8 then needs 3 seconds of CPU where the plain bundle needs 1. What the Worker needs is smaller source,
// not different code, so this does what Wrangler does (its own bundler, through a dry run) and then only takes out the
// whitespace, and writes the few characters above U+00FF as escapes (scripts/narrow-bundle.mjs: with one of those, V8 keeps
// the whole source at two bytes a character).
//
// Without this the 43 MB handler, once Wrangler printed it with indentation, was a 63 MB script that took 130 MB of an
// isolate's 128 and was thrown away after every request, which is why every page cost the cold start of the whole app.
//   node scripts/bundle-worker.mjs [--force]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { narrowFolder } from "./narrow-bundle.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = join(ROOT, ".worker");
// What the bundle is made of: when none of it changed since the last run, the bundle is still good.
const INPUTS = [".open-next/server-functions/default/handler.mjs", ".open-next/middleware/handler.mjs", ".open-next/worker.js", "worker-entry.mjs", "wrangler.jsonc", "scripts/bundle-worker.mjs"];

export function readJsonc(text) {
	return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

// Whitespace only, so the code that runs is the code Wrangler bundled; ASCII, so no character above U+00FF comes back.
export function squeeze(source, esbuild) {
	return esbuild.transformSync(source, { loader: "js", minifyWhitespace: true, format: "esm", charset: "ascii", target: "esnext", legalComments: "none" }).code;
}

function getStamp() {
	return JSON.stringify(INPUTS.map((path) => (existsSync(join(ROOT, path)) ? [path, statSync(join(ROOT, path)).size, Math.round(statSync(join(ROOT, path)).mtimeMs)] : [path])));
}

export function bundleWorker({ force = false } = {}) {
	if (!existsSync(join(ROOT, ".open-next/server-functions/default/handler.mjs"))) {
		throw new Error("bundle-worker: .open-next is missing. Run `npx opennextjs-cloudflare build` first.");
	}
	// First, so what the stamp records is the handler as it is bundled (and a second run changes nothing).
	const { files, characters } = narrowFolder(join(ROOT, ".open-next"));
	if (characters > 0) console.log(`bundle-worker: ${characters} wide characters escaped in ${files} files`);
	const stampPath = join(OUT, "stamp.json");
	const stamp = getStamp();
	if (!force && existsSync(join(OUT, "worker-entry.js")) && existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp) {
		console.log("bundle-worker: .worker is up to date");
		return;
	}

	// The same entry, compatibility date and flags as the Worker, in a config of its own with nothing else: bindings do not change
	// the bundle, and one bundle serves both Workers.
	const config = readJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(join(OUT, "wrangler"), { recursive: true });
	writeFileSync(
		join(OUT, "bundle.jsonc"),
		JSON.stringify({ name: "bundle", main: "../worker-entry.mjs", compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags })
	);
	const require = createRequire(join(ROOT, "package.json"));
	const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
	const result = spawnSync(process.execPath, [wranglerBin, "deploy", "--dry-run", "--outdir", join(OUT, "wrangler"), "--config", join(OUT, "bundle.jsonc")], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
	if (result.status !== 0) {
		throw new Error(`bundle-worker: Wrangler's dry run failed.\n${result.stdout}\n${result.stderr}`);
	}

	const esbuild = createRequire(wranglerBin)("esbuild");
	const bundled = readFileSync(join(OUT, "wrangler", "worker-entry.js"), "utf8");
	const squeezed = squeeze(bundled, esbuild);
	writeFileSync(join(OUT, "worker-entry.js"), squeezed);
	// The WebAssembly and font files the bundle imports by name sit beside it, where Wrangler uploads them as modules.
	for (const name of readdirSync(join(OUT, "wrangler"))) {
		if (/\.(wasm|bin)$/.test(name)) copyFileSync(join(OUT, "wrangler", name), join(OUT, name));
	}
	rmSync(join(OUT, "wrangler"), { recursive: true, force: true });
	writeFileSync(stampPath, stamp);
	console.log(`bundle-worker: ${(bundled.length / 1e6).toFixed(1)} MB bundle written as ${(squeezed.length / 1e6).toFixed(1)} MB in .worker/worker-entry.js`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	bundleWorker({ force: process.argv.includes("--force") });
}
