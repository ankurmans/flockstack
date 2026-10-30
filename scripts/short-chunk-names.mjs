// Run by `next build`'s caller (buildCommand in open-next.config.ts), after scripts/dedupe-chunks.mjs and before OpenNext bundles the Worker.
//
// Turbopack names a server chunk after its modules and a hash (`server/chunks/ssr/lib_account-assistant_12dgega1l6364.js`), and writes that name
// wherever the chunk is needed: in the list every `import()` hands the loader (with nested async chunking an `import()` lists all the chunks its
// path needs, often twenty), in each route's entry (`R.c(...)`), in the SSR module maps of the client reference manifests and in the trace files
// OpenNext copies by. A build of FlockStack writes 3,350 such names 83,000 times in its chunks alone: 4.4 MB of the 34 MB handler was names.
// OpenNext's bundle then names a module after each file too (`require_lib_account_assistant_12dgega1l6364`, its path as the module's key).
//
// This gives every chunk a name of a few characters (`server/chunks/ssr/1a.js`) and writes the new name wherever the old one was. A chunk is
// found by its name and nothing else, so the app loads the same modules in the same order. The runtime (`[turbopack]_runtime.js`, which
// OpenNext patches by that name) and the `[externals]` chunks (which OpenNext reads by that name for the packages left outside) keep theirs.
// .next/chunk-names.json says which short name was which chunk, for reading a build. After the rewrite every chunk a file names must exist,
// or the build stops here instead of a page failing to load.
//   node scripts/short-chunk-names.mjs [.next folder ...]    (default: .next and .next/standalone/.next)
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// The characters of a chunk's name (Turbopack's names have brackets, parentheses and @), after the / of a path, a quote or the = of
// `sourceMappingURL=`, and not in static/ (the browser's chunks, which the client reference manifests list too); a match is a name only
// if it is in the map.
const NAME = /(?<=[/"'=])(?<!static\/(?:[\w.\-]+\/)*)[\w.\-@[\]()]+\.js(?![\w\-@[\]()])/g;
const SHORT = /^[0-9a-z]{1,4}\.js$/;
const TEXT = /\.(js|json|mjs|cjs)$/;
const CHUNK_PATH = /server\/chunks\/(?:ssr\/)?[\w.\-@[\]()]+\.js(?![\w\-@[\]()])/g;

function* walk(folder) {
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}

export function keepsName(name) {
	return name.startsWith("[turbopack") || name.includes("[externals]") || SHORT.test(name);
}

// Old name to new for the chunks of these chunk folders (the same build's, so one map serves them all). A name found in two folders
// keeps it, because a reference says the name and not always the folder.
export function planNames(chunkFolders) {
	const folders = new Map();
	for (const folder of chunkFolders.filter((candidate) => existsSync(candidate))) {
		for (const path of walk(folder)) {
			if (!path.endsWith(".js")) continue;
			const name = path.slice(path.lastIndexOf("/") + 1);
			const at = relative(folder, path);
			if (!folders.has(name)) folders.set(name, new Set());
			folders.get(name).add(at);
		}
	}
	const taken = new Set(folders.keys());
	const names = new Map();
	let next = 0;
	for (const [name, places] of [...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (keepsName(name) || places.size > 1) continue;
		let short;
		do short = `${(next++).toString(36)}.js`;
		while (taken.has(short));
		taken.add(short);
		names.set(name, short);
	}
	return names;
}

export function rewrite(text, names) {
	return text.replace(NAME, (match) => names.get(match) ?? match);
}

// Every chunk a file of the build names that is not on disk: a `server/chunks/...` (from the .next folder) anywhere, and a chunk a trace
// file lists (from the trace file's folder).
export function findMissing(dist) {
	const missing = new Set();
	for (const path of walk(join(dist, "server"))) {
		if (!TEXT.test(path)) continue;
		const text = readFileSync(path, "utf8");
		for (const [reference] of text.matchAll(CHUNK_PATH)) if (!existsSync(join(dist, reference))) missing.add(reference);
		if (!path.endsWith(".nft.json")) continue;
		for (const file of JSON.parse(text).files ?? []) {
			if (file.includes("chunks/") && !existsSync(join(dirname(path), file))) missing.add(relative(dist, join(dirname(path), file)));
		}
	}
	return [...missing];
}

export function shortenFolder(dist, names) {
	const chunks = join(dist, "server", "chunks");
	let files = 0;
	let saved = 0;
	for (const path of walk(join(dist, "server"))) {
		if (!TEXT.test(path)) continue;
		const text = readFileSync(path, "utf8");
		const shorter = rewrite(text, names);
		if (shorter === text) continue;
		writeFileSync(path, shorter);
		files++;
		saved += Buffer.byteLength(text) - Buffer.byteLength(shorter);
	}
	let renamed = 0;
	for (const path of [...walk(chunks)]) {
		const name = path.slice(path.lastIndexOf("/") + 1);
		const isMap = name.endsWith(".js.map");
		const short = names.get(isMap ? name.slice(0, -".map".length) : name);
		if (!short) continue;
		renameSync(path, join(path.slice(0, path.lastIndexOf("/")), isMap ? `${short}.map` : short));
		if (!isMap) renamed++;
	}
	const missing = findMissing(dist);
	if (missing.length > 0) throw new Error(`short-chunk-names: ${dist} names chunks that are not there: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
	return { renamed, files, saved };
}

export function shortenChunkNames(dists = [join(ROOT, ".next"), join(ROOT, ".next/standalone/.next")]) {
	const present = dists.filter((dist) => existsSync(join(dist, "server", "chunks")));
	const names = planNames(present.map((dist) => join(dist, "server", "chunks")));
	const results = present.map((dist) => ({ dist, ...shortenFolder(dist, names) }));
	if (present.length > 0) writeFileSync(join(present[0], "chunk-names.json"), `${JSON.stringify(Object.fromEntries([...names].map(([name, short]) => [short, name])), null, 1)}\n`);
	return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dists = process.argv.slice(2).length > 0 ? process.argv.slice(2) : undefined;
	const results = shortenChunkNames(dists);
	if (results.length === 0) console.warn("short-chunk-names: no chunks folder found, nothing to do");
	for (const { dist, renamed, files, saved } of results) console.log(`short-chunk-names: ${relative(ROOT, dist) || dist}: ${renamed} chunks renamed, ${files} files rewritten, ${(saved / 1e6).toFixed(1)} MB less`);
}
