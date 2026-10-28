// Builds the optional briefings Worker (workers/briefings) into workers/briefings/dist/index.js: the same esbuild step, shims and rules as
// the API Worker (scripts/build-api-worker.mjs), from the briefings' entry. The engine is lib/briefings, the app's own module.
//   node scripts/build-briefings-worker.mjs [--sourcemap] [--metafile]
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApiWorker } from "./build-api-worker.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const BRIEFINGS = join(ROOT, "workers/briefings");
export const OUT_DIR = join(BRIEFINGS, "dist");
export const OUT_FILE = join(OUT_DIR, "index.js");

export function buildBriefingsWorker({ sourcemap = false, metafile = false, outFile = OUT_FILE, entry = join(BRIEFINGS, "index.js") } = {}) {
	return buildApiWorker({ sourcemap, metafile, outFile, entry });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { bytes } = await buildBriefingsWorker({ sourcemap: process.argv.includes("--sourcemap"), metafile: process.argv.includes("--metafile") });
	console.log(`build-briefings-worker: ${(bytes / 1e6).toFixed(2)} MB in workers/briefings/dist/index.js`);
}
