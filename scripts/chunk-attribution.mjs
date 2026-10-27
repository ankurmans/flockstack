// Which packages and which of the project's files the app handler's bytes belong to. The handler is made of Turbopack's chunks (minified, with module numbers, no
// names), so the metafile of the OpenNext bundle (.open-next/server-functions/default/handler.mjs.meta.json) says how big each chunk file is but not what is in it.
// Each chunk has a source map in .next/server/chunks; its mappings say which source file every stretch of the chunk came from, and the length of a stretch is the
// distance to the next one on the same line. The result is output bytes per source, in each of Next.js's two layers (ssr and rsc), which is how a library used by
// both is counted twice. Stretches with no source (module wrappers, runtime glue) are left out: about a fifth of the chunk bytes. Read-only.
//   node scripts/chunk-attribution.mjs [--top 40] [--json]        (after `npx opennextjs-cloudflare build`; docs/PERF-RELEASE-ANALYSIS.md)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT = ".open-next/server-functions/default";
const BASE64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((char, index) => [char, index]));

// The segments of a source map's `mappings` that have a source: { line, col, source } with 0-based line and column.
export function decodeMappings(mappings) {
	const segments = [];
	let line = 0;
	let column = 0;
	let source = 0;
	let index = 0;
	while (index < mappings.length) {
		const char = mappings[index];
		if (char === ";") {
			line++;
			column = 0;
			index++;
			continue;
		}
		if (char === ",") {
			index++;
			continue;
		}
		const fields = [];
		while (index < mappings.length && mappings[index] !== "," && mappings[index] !== ";") {
			let shift = 0;
			let value = 0;
			let more;
			do {
				const digit = BASE64[mappings[index++]];
				more = digit & 32;
				value += (digit & 31) << shift;
				shift += 5;
			} while (more);
			fields.push(value & 1 ? -(value >> 1) : value >> 1);
		}
		column += fields[0];
		if (fields.length >= 4) {
			source += fields[1];
			segments.push({ line, col: column, source });
		} else segments.push({ line, col: column, source: -1 });
	}
	return segments;
}

// Bytes of `text` (a chunk) per source file of its map (a plain or an indexed one).
export function attributeChunk(text, map) {
	const lineLength = text.split("\n").map((line) => Buffer.byteLength(line, "utf8") + 1);
	const sections = map.sections ?? [{ offset: { line: 0, column: 0 }, map }];
	const bytes = new Map();
	for (const section of sections) {
		const segments = decodeMappings(section.map.mappings);
		segments.forEach((segment, index) => {
			if (segment.source < 0) return;
			const next = segments[index + 1];
			const line = segment.line + section.offset.line;
			const end = next && next.line === segment.line ? next.col : (lineLength[line] ?? 0);
			const name = section.map.sources[segment.source];
			bytes.set(name, (bytes.get(name) ?? 0) + Math.max(0, end - segment.col));
		});
	}
	return bytes;
}

// "../../../../node_modules/%40better-auth/core/dist/x.mjs" is the package @better-auth/core; anything else is a file of the project.
export function describeSource(source) {
	const path = decodeURIComponent(source).replace(/^(\.\.\/)+/, "").replace(/^\[project\]\//, "");
	const at = path.lastIndexOf("node_modules/");
	if (at < 0) return { kind: "project", name: path };
	const parts = path.slice(at + "node_modules/".length).split("/");
	return { kind: "package", name: parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] };
}

export function attributeHandler(root = ROOT, folder = DEFAULT) {
	const meta = JSON.parse(readFileSync(join(root, folder, "handler.mjs.meta.json"), "utf8"));
	const inputs = Object.values(meta.outputs)[0].inputs;
	const packages = new Map();
	const files = new Map();
	const layers = { ssr: 0, rsc: 0 };
	let skipped = 0;
	for (const [key, { bytesInOutput }] of Object.entries(inputs)) {
		const path = key.replace(`${folder}/`, "");
		if (!path.startsWith(".next/server/chunks/")) continue;
		const mapFile = join(root, `${path}.map`);
		if (!existsSync(mapFile)) {
			skipped += bytesInOutput;
			continue;
		}
		const text = readFileSync(join(root, path), "utf8");
		// A duplicate chunk is replaced by a line that loads the first one (scripts/dedupe-chunks.mjs): nothing to count.
		if (text.length < bytesInOutput * 0.5) continue;
		const layer = path.includes("/chunks/ssr/") ? "ssr" : "rsc";
		for (const [source, bytes] of attributeChunk(text, JSON.parse(readFileSync(mapFile, "utf8")))) {
			const { kind, name } = describeSource(source);
			const into = kind === "package" ? packages : files;
			const row = into.get(name) ?? { ssr: 0, rsc: 0 };
			row[layer] += bytes;
			into.set(name, row);
			layers[layer] += bytes;
		}
	}
	return { packages, files, layers, skipped, handlerBytes: Object.values(meta.outputs)[0].bytes };
}

const total = (row) => row.ssr + row.rsc;
const mb = (bytes) => (bytes / 1e6).toFixed(2).padStart(6);

function main(argv) {
	if (!existsSync(join(ROOT, DEFAULT, "handler.mjs.meta.json"))) {
		console.error("No build: run `npx opennextjs-cloudflare build` first (the handler's metafile is written next to handler.mjs).");
		return 2;
	}
	const top = Number(argv[argv.indexOf("--top") + 1]) || 40;
	const result = attributeHandler();
	const rank = (map) => [...map].sort((a, b) => total(b[1]) - total(a[1]));
	if (argv.includes("--json")) {
		console.log(JSON.stringify({ handlerBytes: result.handlerBytes, layers: result.layers, packages: rank(result.packages), files: rank(result.files).slice(0, 200) }));
		return 0;
	}
	const attributed = result.layers.ssr + result.layers.rsc;
	console.log(`handler ${mb(result.handlerBytes)} MB; chunk bytes with a source: ${mb(attributed)} MB (ssr layer ${mb(result.layers.ssr)}, rsc layer ${mb(result.layers.rsc)}); in chunks without a map: ${mb(result.skipped)} MB`);
	console.log("\npackages (MB, ssr+rsc, each layer)");
	for (const [name, row] of rank(result.packages).slice(0, top)) console.log(`${mb(total(row))}  ${mb(row.ssr)} ${mb(row.rsc)}  ${name}`);
	console.log("\nproject files");
	for (const [name, row] of rank(result.files).slice(0, top)) console.log(`${mb(total(row))}  ${mb(row.ssr)} ${mb(row.rsc)}  ${name}`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
