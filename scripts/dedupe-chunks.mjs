// Run by `next build`'s caller (buildCommand in open-next.config.ts), after the build and before OpenNext bundles the Worker.
//
// Turbopack writes the same chunk once for every chunk group that needs it, under a different name each time: the files are
// byte for byte the same except for the last line, the source map's address. A build of FlockStack has 95 such files in 48 groups,
// 10.6 MB of the 29.5 MB of chunks (one chunk, 197 KB, is there 19 times), and OpenNext's bundle carries every file it is
// given, so the Worker's script was a third larger than it had to be. This keeps one file of each group and makes the others
// a line that loads it: `module.exports=require("./the-first.js")`. A chunk is a list of module factories that its loader
// installs when it first reads the file, and a second read of the same list installs nothing new, so the app behaves as it did.
//   node scripts/dedupe-chunks.mjs [folder ...]    (default: .next/server/chunks and .next/standalone/.next/server/chunks)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Smaller files are not worth a stub; the runtime that loads chunks is never one.
const MIN_BYTES = 2048;
const SOURCE_MAP_LINE = /\n*\/\/# sourceMappingURL=[^\n]*\s*$/;

function* walk(folder) {
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (name.endsWith(".js") && !name.startsWith("[turbopack]")) yield path;
	}
}

// The stub that stands for a duplicate: the same exports as the file it points at.
export function toStub(from, canonical) {
	let target = relative(dirname(from), canonical).split("\\").join("/");
	if (!target.startsWith(".")) target = `./${target}`;
	return `module.exports=require(${JSON.stringify(target)});\n`;
}

export function dedupeFolder(folder) {
	const groups = new Map();
	for (const path of walk(folder)) {
		const source = readFileSync(path, "utf8");
		if (Buffer.byteLength(source) < MIN_BYTES || !/^(module\.exports=\[|\(\(\)=>\{"use strict";module\.exports=\[)/.test(source)) continue;
		const hash = createHash("sha256").update(source.replace(SOURCE_MAP_LINE, "")).digest("hex");
		if (!groups.has(hash)) groups.set(hash, []);
		groups.get(hash).push({ path, bytes: Buffer.byteLength(source) });
	}
	let files = 0;
	let saved = 0;
	for (const copies of groups.values()) {
		if (copies.length < 2) continue;
		copies.sort((a, b) => a.path.localeCompare(b.path));
		const [canonical, ...rest] = copies;
		for (const { path, bytes } of rest) {
			const stub = toStub(path, canonical.path);
			writeFileSync(path, stub);
			files++;
			saved += bytes - Buffer.byteLength(stub);
		}
	}
	return { files, saved, groups: [...groups.values()].filter((copies) => copies.length > 1).length };
}

export function dedupeChunks(folders = [join(ROOT, ".next/server/chunks"), join(ROOT, ".next/standalone/.next/server/chunks")]) {
	const results = [];
	for (const folder of folders.filter((candidate) => existsSync(candidate))) results.push({ folder, ...dedupeFolder(folder) });
	return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const folders = process.argv.slice(2).length > 0 ? process.argv.slice(2) : undefined;
	const results = dedupeChunks(folders);
	if (results.length === 0) console.warn("dedupe-chunks: no chunks folder found, nothing to do");
	for (const { folder, files, saved, groups } of results) console.log(`dedupe-chunks: ${relative(ROOT, folder) || folder}: ${files} files in ${groups} groups now load another, ${(saved / 1e6).toFixed(1)} MB less`);
}
