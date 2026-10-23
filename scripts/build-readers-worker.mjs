// Builds the lean readers Worker (workers/readers) into workers/readers/dist/index.js: the same esbuild step, shims and rules as the
// API Worker (scripts/build-api-worker.mjs), from the readers' entry. The routes it serves are the app's own modules.
//   node scripts/build-readers-worker.mjs [--sourcemap] [--metafile]
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApiWorker } from "./build-api-worker.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const READERS = join(ROOT, "workers/readers");
export const OUT_DIR = join(READERS, "dist");
export const OUT_FILE = join(OUT_DIR, "index.js");

export function buildReadersWorker({ sourcemap = false, metafile = false, outFile = OUT_FILE, entry = join(READERS, "index.js") } = {}) {
	return buildApiWorker({ sourcemap, metafile, outFile, entry });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { bytes } = await buildReadersWorker({ sourcemap: process.argv.includes("--sourcemap"), metafile: process.argv.includes("--metafile") });
	console.log(`build-readers-worker: ${(bytes / 1e6).toFixed(2)} MB in workers/readers/dist/index.js`);
}
