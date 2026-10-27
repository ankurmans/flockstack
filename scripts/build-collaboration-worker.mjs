import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(join(root, "package.json"));
const esbuild = createRequire(join(dirname(require.resolve("wrangler/package.json")), "package.json"))("esbuild");
export async function buildCollaborationWorker() {
const result = await esbuild.build({ entryPoints: [join(root, "workers/collaboration/index.js")], bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"], write: false, plugins: [{ name: "editor-dom-cssom", setup(build) { build.onLoad({ filter: /node_modules[\\/]linkedom[\\/]worker\.js$/ }, args => {
	// Linkedom already bundles CSSOM. Its optional cssstyle override is unused by the editor and causes dynamic require in Workers.
	const source = readFileSync(args.path, "utf8"), optional = 'CSSOM.CSSStyleDeclaration = require("cssstyle").CSSStyleDeclaration;';
	if (!source.includes(optional)) throw new Error("Review the editor DOM parser optional CSSOM override after its dependency update");
	return { contents: source.replaceAll(optional, 'throw new Error("Use the bundled CSSOM implementation");'), loader: "js" };
}) } }], minifyWhitespace: true, charset: "ascii" });
const path = join(root, "workers/collaboration/dist/index.js"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, result.outputFiles[0].contents); return result.outputFiles[0].contents.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`build-collaboration-worker: ${await buildCollaborationWorker()} bytes`);
