import { existsSync } from "node:fs";

// No script-src: Next.js's inline scripts would need per-request nonces, which archive pages can't have
// while they're cached (ISR). script-src-attr still blocks inline event handlers everywhere.
const CONTENT_SECURITY_POLICY = [
	"frame-ancestors 'none'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"script-src-attr 'none'",
].join("; ");

// Uploads served from the S3 bucket's CDN, read at build time like the rest of this file.
const IMAGES_CDN_URL = process.env.IMAGES_CDN_URL;
const IMAGES_CDN_HOST = IMAGES_CDN_URL && URL.canParse(IMAGES_CDN_URL) ? new URL(IMAGES_CDN_URL).hostname : null;

// A newsletter's signup forms are framed by other sites (lib/forms.js), so their page alone may be. X-Frame-Options has no
// "any site" value: ALLOWALL isn't standard, and where a browser reads frame-ancestors it ignores the header anyway.
const FRAMEABLE_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace("frame-ancestors 'none'", "frame-ancestors *");

const SECURITY_HEADERS = [
	{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
	{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	// The origin only, FlockStack's own pages included: a URL like a contacts search can hold a subscriber's email,
	// and the page it leads to can send its referrer to analytics.
	{ key: "Referrer-Policy", value: "strict-origin" },
];

// FlockStack Cloud's marketing site extends the shared pages through these two modules. Where its files exist they
// take the defaults' place; the open source has none of them (tests/setup/hooks.mjs resolves the same way).
const SITE_EXTENSIONS = Object.entries({
	"@/lib/site-extensions": "./lib/marketing/site-extensions.js",
	"@/lib/site-routing": "./lib/marketing/site-routing.js",
	"@/components/SiteExtensions": "./components/marketing/SiteExtensions.jsx",
}).filter(([, target]) => existsSync(new URL(target, import.meta.url)));

/** @type {import('next').NextConfig} */
const nextConfig = {
	poweredByHeader: false,
	// One Worker holds every route, so a module that several routes share should sit in a chunk of its own, loaded once, not be
	// copied into each route's chunks: this takes 5 MB out of the 43 MB handler, and the memory V8 keeps its source in.
	experimental: { turbopackServerSideNestedAsyncChunking: true },
	turbopack: { resolveAlias: Object.fromEntries(SITE_EXTENSIONS) },
	images: {
		remotePatterns: [
			{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
			...(IMAGES_CDN_HOST ? [{ protocol: "https", hostname: IMAGES_CDN_HOST }] : []),
		],
	},
	async headers() {
		return [
			{ source: "/:path*", headers: SECURITY_HEADERS },
			// Later rules win for the same header.
			{
				source: "/embed/:id",
				headers: [
					{ key: "Content-Security-Policy", value: FRAMEABLE_CONTENT_SECURITY_POLICY },
					{ key: "X-Frame-Options", value: "ALLOWALL" },
				],
			},
		];
	},
};

export default nextConfig;
