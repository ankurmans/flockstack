// The public pages Worker's logic, apart from its manifest so the tests can give it one. See workers/public/index.js.
import { fillMarkerStream } from "../../lib/prerender.js";
import { readAnalyticsEnv } from "../../lib/marketing/analytics-config.js";
import { readConsent, requiresConsent } from "../../lib/marketing/analytics-consent.js";

// The key of a request's path in the manifest. The query is not part of it: these pages and files are the same for any query.
export function lookup(manifest, region, pathname) {
	return manifest.regions?.[region]?.[pathname] ?? null;
}

// What the analytics component would have worked out for this visitor if the page had been rendered for them: the analytics
// key of this Worker (the same one the app has), and whether the visitor has to consent first (their country, or the EU
// deployment) with the choice they saved. Without a key there are no analytics, as on the app, and "declined" keeps it so.
export function analyticsValues(request, env, region) {
	const config = readAnalyticsEnv(env);
	if (!config) return { token: "FSNOANALYTICS", host: "https://prerender.invalid", replay: false, requiresConsent: true, consent: "declined" };
	return {
		...config,
		requiresConsent: requiresConsent({ country: request.headers.get("cf-ipcountry"), env: { FLOCKSTACK_REGION: region } }),
		consent: readConsent(request.headers.get("cookie")),
	};
}

const miss = (status, text) => new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-fs-public-miss": "1" } });

export function createHandler(manifest) {
	return async function fetch(request, env) {
		if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
		// One deployment per region: each holds its own region's files, and the build that goes with its app.
		const region = env.FLOCKSTACK_REGION === "eu" ? "eu" : "us";
		const entry = lookup(manifest, region, new URL(request.url).pathname);
		if (!entry) return miss(404, "No static copy of this page.");

		// The file is read through the assets binding; the router asks the app when it can't be read.
		let asset;
		try {
			asset = await env.ASSETS.fetch(new Request(`https://assets.local/${entry.file}`));
		} catch {
			return miss(502, "The static copy could not be read.");
		}
		if (asset.status !== 200) {
			await asset.body?.cancel();
			return miss(502, "The static copy could not be read.");
		}

		const headers = new Headers(entry.headers);
		headers.set("x-public-build", manifest.build);
		const isHead = request.method === "HEAD";
		if (isHead || !entry.replacements?.length) return new Response(isHead ? null : asset.body, { status: entry.status, headers });

		// The page streams out as it is read; only the bytes of the markers are changed on the way.
		return new Response(fillMarkerStream(asset.body, entry.replacements, analyticsValues(request, env, region)), { status: entry.status, headers });
	};
}
