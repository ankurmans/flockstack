// Bundles worker.mjs with FlockStack's real lib/docdb, models and bulk code paths, and the tests' stubs for what
// reaches outside (tests/setup/hooks.mjs): Next.js, DNS lookups of mail domains, OpenNext's context.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const stub = (name) => here(`../../tests/stubs/${name}`);
const STUBS = {
	"server-only": stub("empty.mjs"),
	"next/headers": stub("next-headers.mjs"),
	"next/cache": stub("next-cache.mjs"),
	"next/navigation": stub("next-navigation.mjs"),
	"next/server": stub("next-server.mjs"),
	"@upstash/qstash": stub("qstash.mjs"),
	"@upstash/qstash/nextjs": stub("qstash-nextjs.mjs"),
	"@opennextjs/cloudflare": stub("opennext-cloudflare.mjs"),
	"@/lib/ses": stub("ses.mjs"),
	"@/lib/dns-check": stub("dns-check.mjs"),
	"@/lib/mail-domains": stub("mail-domains.mjs"),
	"@/lib/dns-broker": stub("dns-broker.mjs"),
	"@/lib/cloudflare-api": stub("cloudflare-api.mjs"),
	"@/lib/remote-image": stub("remote-image.mjs"),
};

await build({
	entryPoints: [here("./worker.mjs")],
	outfile: here("./dist/worker.js"),
	bundle: true,
	format: "esm",
	platform: "neutral",
	target: "es2023",
	conditions: ["workerd", "worker", "import"],
	mainFields: ["module", "main"],
	external: ["node:*", "cloudflare:*"],
	logLevel: "warning",
	plugins: [
		{
			name: "stubs",
			setup(builder) {
				builder.onResolve({ filter: /.*/ }, ({ path }) => (STUBS[path] ? { path: STUBS[path] } : undefined));
			},
		},
	],
});
