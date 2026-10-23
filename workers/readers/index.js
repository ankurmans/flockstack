// FlockStack Cloud's lean readers Worker: what a reader's mail client or browser sends by itself and the app answers without
// rendering a page (the open pixel, the click redirect, unsubscribe, the archive's beacons, the address signup forms post to), with
// no Next.js, React or server components. It is built from the same source modules as the app's routes
// (scripts/build-readers-worker.mjs), is bound to the same database as its region's app, and is reached through the router's READERS
// binding. docs/ARCHITECTURE-WORKERS.md has the picture.
import { SECURITY_HEADERS } from "../../lib/security-headers.js";
import { flushRevalidations } from "../api/runtime-hooks.js";
import { setBindings, runInRequest } from "../api/shims/runtime.js";
import { handleReaderRequest } from "./handler.js";

// The 503 the router takes for "nothing happened here, ask the app": READERS_DISABLED=true turns this Worker off without touching
// the router, and a Worker that has no database answers the same, before it reads a body.
function unprocessed(reason) {
	return new Response(`${reason}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-fs-readers-unprocessed": "1" } });
}

function withHeaders(response, startedAt) {
	if (response.status === 101) return response;
	const copy = new Response(response.body, response);
	for (const { key, value } of SECURITY_HEADERS) if (!copy.headers.has(key)) copy.headers.set(key, value);
	const timings = [];
	if (copy.headers.get("server-timing")) timings.push(copy.headers.get("server-timing"));
	timings.push(`readers;dur=${Date.now() - startedAt}`);
	copy.headers.set("server-timing", timings.join(", "));
	if (!copy.headers.has("x-served-by")) copy.headers.set("x-served-by", "readers");
	return copy;
}

const readersWorker = {
	async fetch(request, env, ctx) {
		const startedAt = Date.now();
		if (String(env.READERS_DISABLED ?? "").toLowerCase() === "true") return withHeaders(unprocessed("The readers Worker is switched off"), startedAt);
		if (!env.DB) return withHeaders(unprocessed("The readers Worker has no database"), startedAt);
		setBindings(env);
		return runInRequest(ctx, async (store) => {
			let response;
			try {
				response = withHeaders(await handleReaderRequest(request), startedAt);
			} finally {
				// A signup or an unsubscribe can drop a cached page; the app does the dropping, after the answer.
				if (store.revalidations.size > 0) ctx.waitUntil(flushRevalidations(store.revalidations, env));
			}
			return response;
		});
	},
};

export default readersWorker;
