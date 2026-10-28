// Builds the lean API Worker (workers/api) into workers/api/dist/index.js: one ES module from the same source files the app's
// routes use, with no Next.js, React or server components. The shared code imports a few Next.js and OpenNext modules, and this
// build puts small adapters from workers/api/shims in their place (their imports are never called on the API's paths, or are
// answered by the Worker's own bindings). `@/` is the repository root, as in jsconfig.json.
//   node scripts/build-api-worker.mjs [--sourcemap] [--metafile]
// Like scripts/bundle-worker.mjs for the app, the output has its whitespace taken out and nothing renamed, and no character above
// U+00FF: V8 keeps a script's source in memory at one byte a character only while every character fits in a byte (see that script).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMingoEsmAliases } from "./mingo-esm.mjs";
import { narrowSource } from "./narrow-bundle.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const API = join(ROOT, "workers/api");
export const OUT_DIR = join(API, "dist");
export const OUT_FILE = join(OUT_DIR, "index.js");
const SHIMS = join(API, "shims");

// Module name -> the file that stands in for it.
export const ALIASES = {
	"server-only": join(SHIMS, "empty.js"),
	"next/headers": join(SHIMS, "next-only.js"),
	"next/headers.js": join(SHIMS, "next-only.js"),
	"next/cache": join(SHIMS, "next-only.js"),
	"next/navigation": join(SHIMS, "next-only.js"),
	"next/server": join(SHIMS, "next-server.js"),
	react: join(SHIMS, "react.js"),
	"@opennextjs/cloudflare": join(SHIMS, "opennext-cloudflare.js"),
	"@/lib/runtime-hooks": join(API, "runtime-hooks.js"),
	...getMingoEsmAliases(ROOT),
};
// The FlockStack Cloud build (FLOCKSTACK_CLOUD_BUILD=true, set by scripts/deploy-all.mjs) keeps images in R2 only: the S3, CloudFront and
// Vercel Blob clients are replaced by a stub that throws, as in next.config.mjs.
export const CLOUD_BUILD_ALIASES = Object.fromEntries(
	["@vercel/blob", "@aws-sdk/client-s3", "@aws-sdk/client-cloudfront"].map((name) => [name, join(ROOT, "lib/cloud-build/unavailable-storage.js")])
);
export const isCloudBuild = (env = process.env) => env.FLOCKSTACK_CLOUD_BUILD === "true";
const EXTENSIONS = ["", ".js", ".jsx", ".mjs", "/index.js"];
const BUILTINS = new Set(builtinModules);

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function loadEsbuild() {
	// Wrangler brings esbuild; the repository does not name it.
	const require = createRequire(join(ROOT, "package.json"));
	return createRequire(join(dirname(require.resolve("wrangler/package.json")), "package.json"))("esbuild");
}

export function createPlugin({ aliases = { ...ALIASES, ...(isCloudBuild() && CLOUD_BUILD_ALIASES) } } = {}) {
	return {
		name: "flockstack-api-worker",
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				const request = args.path;
				if (aliases[request]) return { path: aliases[request] };
				if (request.startsWith("@/")) {
					const base = join(ROOT, request.slice(2));
					const found = EXTENSIONS.map((extension) => `${base}${extension}`).find(isFile);
					if (found) return { path: found };
				}
				// CommonJS packages still need a static ESM import for a runtime built-in: an external require would survive bundling.
				if (request.startsWith("node:") || BUILTINS.has(request)) {
					const path = request.startsWith("node:") ? request : `node:${request}`;
					return args.kind === "require-call" ? { path, namespace: "node-require" } : { path, external: true };
				}
				if (request.startsWith("cloudflare:")) return { path: request, external: true };
				// The `browser` condition brings the AWS SDK's browser builds, whose Node-only exports are placeholders, so a client's
				// runtime config has to be its browser one too (fetch, Web Crypto), as its package.json "browser" field says. The
				// Node one calls those placeholders and every SES call fails (tests/api-worker-ses-sdk.test.mjs).
				if (request === "./runtimeConfig" && args.importer.includes("/node_modules/@aws-sdk/")) {
					const browser = join(dirname(args.importer), "runtimeConfig.browser.js");
					if (isFile(browser)) return { path: browser };
				}
			});
			build.onLoad({ filter: /.*/, namespace: "node-require" }, ({ path }) => ({ contents: `import * as builtin from ${JSON.stringify(path)}; module.exports = builtin.default ?? builtin;`, loader: "js" }));
		},
	};
}

export async function buildApiWorker({ sourcemap = false, metafile = false, minifyWhitespace = true, outFile = OUT_FILE, entry = join(API, "index.js") } = {}) {
	const esbuild = loadEsbuild();
	mkdirSync(dirname(outFile), { recursive: true });
	const result = await esbuild.build({
		entryPoints: [entry],
		outfile: outFile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "esnext",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		plugins: [createPlugin()],
		minifyWhitespace,
		charset: "ascii",
		legalComments: "none",
		keepNames: false,
		sourcemap,
		metafile,
		logLevel: "error",
		define: { "process.env.NODE_ENV": '"production"', ...(isCloudBuild() && { "process.env.FLOCKSTACK_CLOUD_BUILD": '"true"' }) },
	});
	// esbuild escapes the wide characters of strings but leaves those in regular expressions: write them as escapes too, as
	// scripts/narrow-bundle.mjs does for the app, so no character of the script is above U+00FF.
	const { narrowed } = narrowSource(readFileSync(outFile, "utf8"));
	writeFileSync(outFile, narrowed);
	if (metafile) writeFileSync(`${outFile}.meta.json`, JSON.stringify(result.metafile));
	return { outFile, bytes: statSync(outFile).size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { bytes } = await buildApiWorker({ sourcemap: process.argv.includes("--sourcemap"), metafile: process.argv.includes("--metafile") });
	console.log(`build-api-worker: ${(bytes / 1e6).toFixed(2)} MB in workers/api/dist/index.js`);
}
