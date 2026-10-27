import { existsSync } from "node:fs";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./lib/security-headers.js";

// Uploads served from the S3 bucket's CDN, read at build time like the rest of this file.
const IMAGES_CDN_URL = process.env.IMAGES_CDN_URL;
const IMAGES_CDN_HOST = IMAGES_CDN_URL && URL.canParse(IMAGES_CDN_URL) ? new URL(IMAGES_CDN_URL).hostname : null;

// A newsletter's signup forms are framed by other sites (lib/forms.js), so their page alone may be. X-Frame-Options has no
// "any site" value: ALLOWALL isn't standard, and where a browser reads frame-ancestors it ignores the header anyway.
const FRAMEABLE_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace("frame-ancestors 'none'", "frame-ancestors *");

// FlockStack Cloud's marketing site extends the shared pages through these two modules. Where its files exist they
// take the defaults' place; the open source has none of them (tests/setup/hooks.mjs resolves the same way).
const SITE_EXTENSIONS = Object.entries({
	"@/lib/site-extensions": "./lib/marketing/site-extensions.js",
	"@/lib/site-routing": "./lib/marketing/site-routing.js",
	"@/components/SiteExtensions": "./components/marketing/SiteExtensions.jsx",
}).filter(([, target]) => existsSync(new URL(target, import.meta.url)));

// The FlockStack Cloud build (scripts/deploy-all.mjs sets FLOCKSTACK_CLOUD_BUILD=true for it) keeps images in R2 only, so the S3, CloudFront and
// Vercel Blob clients (with undici and the AWS SDK parts only they use, 2.2 MB of the Worker) are replaced by a stub that throws. Everything else,
// the open source build included, has the real packages: lib/image-storage.js loads each by import() when its storage is chosen.
const IS_CLOUD_BUILD = process.env.FLOCKSTACK_CLOUD_BUILD === "true";
const STORAGE_CLIENTS = IS_CLOUD_BUILD ? Object.fromEntries(["@vercel/blob", "@aws-sdk/client-s3", "@aws-sdk/client-cloudfront"].map((name) => [name, "./lib/cloud-build/unavailable-storage.js"])) : {};

/** @type {import('next').NextConfig} */
const nextConfig = {
	poweredByHeader: false,
	// Read by lib/image-storage.js, so the build can say which storage it has.
	env: IS_CLOUD_BUILD ? { FLOCKSTACK_CLOUD_BUILD: "true" } : {},
	// One Worker holds every route, so a module that several routes share should sit in a chunk of its own, loaded once, not be
	// copied into each route's chunks: this takes 5 MB out of the 43 MB handler, and the memory V8 keeps its source in.
	experimental: { turbopackServerSideNestedAsyncChunking: true },
	turbopack: { resolveAlias: { ...Object.fromEntries(SITE_EXTENSIONS), ...STORAGE_CLIENTS } },
	images: {
		remotePatterns: [
			{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
			...(IMAGES_CDN_HOST ? [{ protocol: "https", hostname: IMAGES_CDN_HOST }] : []),
		],
	},
	async headers() {
		return [
			{ source: "/:path*", headers: SECURITY_HEADERS },
			{ source: "/reader/sponsorships/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
			{ source: "/reader/billing", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
			{ source: "/reader/groups/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
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
