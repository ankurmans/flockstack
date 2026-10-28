// mingo's package.json sends the `node` condition to its CommonJS build, and every bundle of this repository resolves with that condition
// (Next.js's server layers, scripts/build-api-worker.mjs with platform node). CommonJS can't be tree-shaken, so importing
// $group from mingo/operators/pipeline brought every operator of the package: 430 KB in each Worker and in each of the app's
// layers, where lib/docdb/mingo-engine.js names about 60 of them. The ESM build is the same code with a sideEffects list, so each subpath
// pointed at it leaves only what is named. Tests run in Node without a bundler and keep the CommonJS build.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

// { "mingo/aggregator": "<root>/node_modules/mingo/esm/aggregator.js", ... }, or paths starting "./" from the root with { relativeTo: true },
// as Turbopack's resolveAlias takes them. "mingo" itself (its entry registers every operator) is left as it is.
export function getMingoEsmAliases(root, { relativeTo = false } = {}) {
	const manifest = createRequire(join(root, "package.json")).resolve("mingo/package.json");
	const { exports } = JSON.parse(readFileSync(manifest, "utf8"));
	const aliases = {};
	for (const [subpath, target] of Object.entries(exports)) {
		if (subpath === "." || typeof target?.default !== "string" || !target.default.startsWith("./esm/")) continue;
		const path = join(dirname(manifest), target.default);
		aliases[`mingo${subpath.slice(1)}`] = relativeTo ? `./${relative(root, path)}` : path;
	}
	return aliases;
}
