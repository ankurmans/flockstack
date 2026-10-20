// Run by Wrangler before it bundles the Worker (`build.command` in wrangler.jsonc). V8 keeps a script's source in memory,
// one byte per character, unless a single character is above U+00FF: then every character takes two. The OpenNext
// handler has a few hundred such characters (curly quotes and arrows in the docs and in regular expressions) and, at 43 MB,
// they cost the isolate 43 MB more of its 128 MB. This writes them as \uXXXX escapes, which every string, template
// and regular expression reads back as the same character. It is safe to run again on a folder it has already changed.
//   node scripts/narrow-bundle.mjs [folder]    (default .open-next)
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WIDE = /(\\*)([^\x00-\xff])/gu;

const escapeUnit = (unit) => `\\u${unit.toString(16).padStart(4, "0")}`;

export function narrowSource(source) {
	let count = 0;
	const narrowed = source.replace(WIDE, (_match, backslashes, character) => {
		count++;
		// A character above U+FFFF is two UTF-16 units, which a string or a regular expression reads as the pair.
		const escaped = Array.from({ length: character.length }, (_unused, index) => escapeUnit(character.charCodeAt(index))).join("");
		// "\’" was the character itself: with the backslash kept, "\\u2019" would read as the text u2019.
		if (backslashes.length % 2 === 1) return backslashes.slice(0, -1) + escaped;
		return backslashes + escaped;
	});
	return { narrowed, count };
}

function* walk(folder) {
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		if (statSync(path).isDirectory()) {
			// The handlers are single files with everything inlined; the folders are copies Wrangler never reads.
			if (!["assets", "cache", "node_modules", ".next"].includes(name)) yield* walk(path);
		} else if (/\.(mjs|js|cjs)$/.test(name)) yield path;
	}
}

export function narrowFolder(folder) {
	let files = 0;
	let characters = 0;
	for (const path of walk(folder)) {
		const source = readFileSync(path, "utf8");
		const { narrowed, count } = narrowSource(source);
		if (count === 0) continue;
		writeFileSync(path, narrowed);
		files++;
		characters += count;
	}
	return { files, characters };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const folder = process.argv[2] ?? fileURLToPath(new URL("../.open-next", import.meta.url));
	const { files, characters } = narrowFolder(folder);
	console.log(`narrow-bundle: ${characters} wide characters escaped in ${files} files`);
}
