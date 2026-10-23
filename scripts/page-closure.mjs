// What a page evaluates the first time its route is asked for: its static import closure, which esbuild can list with the byte sizes the
// code takes in a bundle. Next.js bundles with Turbopack, so the sizes are an approximation of its chunks, but which packages a page pulls
// in is exact: an `import()` is not followed (it loads when it runs), and a client component's import of a "use server" file is a
// reference to the action, not its code, as Next.js compiles it. A module a page imports and does not need to run is a cold start's cost:
// the Worker evaluates it before it answers (docs/PERFORMANCE.md). tests/dashboard-weight.test.mjs keeps the dashboard's pages free of
// the packages that only an action, a webhook or an editor needs.
//   node scripts/page-closure.mjs "app/(app)/contacts/page.js" [top]          the packages a page pulls in
//   node scripts/page-closure.mjs --why "app/(app)/contacts/page.js" zod      the chain of imports that brings one in
import { readFileSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXTENSIONS = ["", ".js", ".jsx", ".mjs", "/index.js", "/index.jsx"];
const NOT_BUNDLED = /^(next|react|react-dom|server-only|@opennextjs)(\/|$)/;

function loadEsbuild() {
	// Wrangler brings esbuild; the repository does not name it.
	const require = createRequire(join(ROOT, "package.json"));
	return createRequire(join(dirname(require.resolve("wrangler/package.json")), "package.json"))("esbuild");
}

const isFile = (path) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};
const head = (file) => {
	try {
		return readFileSync(file, "utf8").slice(0, 400);
	} catch {
		return "";
	}
};
const hasDirective = (file, directive) => new RegExp(`^\\s*(//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/\\s*)*["']${directive}["']`).test(head(file));

function createPlugin() {
	return {
		name: "page-closure",
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				const request = args.path;
				const isRelative = (request.startsWith("./") || request.startsWith("../")) && !args.resolveDir.includes("node_modules");
				if (request.startsWith("@/") || isRelative) {
					const base = request.startsWith("@/") ? join(ROOT, request.slice(2)) : join(args.resolveDir, request);
					const found = EXTENSIONS.map((extension) => `${base}${extension}`).find(isFile);
					if (found) {
						if (args.importer && hasDirective(args.importer, "use client") && hasDirective(found, "use server")) return { path: found, external: true };
						return { path: found };
					}
				}
				if (NOT_BUNDLED.test(request)) return { path: request, external: true };
				if (request.startsWith("node:") || builtinModules.includes(request)) return { path: request, external: true };
				if (request.endsWith(".css")) return { path: request, external: true };
			});
		},
	};
}

// { files, bytes, packages: Map(name -> bytes), imports: file -> its static imports } for an entry such as "app/(app)/contacts/page.js".
export async function closure(entry) {
	const result = await loadEsbuild().build({
		entryPoints: [join(ROOT, entry)],
		bundle: true,
		write: false,
		outfile: "/dev/null",
		format: "esm",
		platform: "node",
		target: "esnext",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		plugins: [createPlugin()],
		loader: { ".js": "jsx", ".jsx": "jsx" },
		jsx: "automatic",
		metafile: true,
		minifyWhitespace: true,
		logLevel: "silent",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const meta = result.metafile;
	const inputs = Object.values(meta.outputs)[0].inputs;
	const seen = new Set();
	const prev = new Map([[entry, null]]);
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift();
		seen.add(file);
		for (const item of meta.inputs[file]?.imports ?? []) {
			if (item.kind === "dynamic-import" || !meta.inputs[item.path] || prev.has(item.path)) continue;
			prev.set(item.path, file);
			queue.push(item.path);
		}
	}
	const packages = new Map();
	for (const file of seen) {
		const found = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
		const key = found ? found[1] : file.split("/").slice(0, 2).join("/");
		packages.set(key, (packages.get(key) ?? 0) + (inputs[file]?.bytesInOutput ?? 0));
	}
	return { files: seen.size, bytes: [...packages.values()].reduce((a, b) => a + b, 0), packages, prev };
}

// The chain of imports from the entry to the first file whose path contains `needle`, or null.
export function whyLoaded({ prev }, needle) {
	const hit = [...prev.keys()].find((file) => file.includes(needle));
	if (!hit) return null;
	const chain = [];
	for (let file = hit; file; file = prev.get(file)) chain.push(file);
	return chain.reverse();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args[0] === "--why") {
		const result = await closure(args[1]);
		for (const needle of args.slice(2)) console.log(whyLoaded(result, needle)?.join("\n  -> ") ?? `${needle}: not loaded`);
	} else {
		const result = await closure(args[0]);
		console.log(`${args[0]}: ${result.files} files, ${(result.bytes / 1e6).toFixed(2)} MB`);
		for (const [name, bytes] of [...result.packages].sort((a, b) => b[1] - a[1]).slice(0, Number(args[1] ?? 20))) console.log(`${(bytes / 1e3).toFixed(0).padStart(7)} KB  ${name}`);
	}
}
