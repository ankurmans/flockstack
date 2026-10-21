// lib/runtime-hooks.js for the lean API Worker: the build puts this file in its place. after() hands the work to the Worker's
// execution context, and revalidatePath() notes the page for the app, which does the dropping (flushRevalidations).
import { buildRevalidateBody, REVALIDATE_PATH, SIGNATURE_HEADER, signBody } from "../../lib/internal-revalidate.js";
import { getRequestStore } from "./shims/runtime.js";

export function after(task) {
	const work = Promise.resolve()
		.then(() => (typeof task === "function" ? task() : task))
		.catch((error) => console.error("[after]", error?.message ?? error));
	getRequestStore()?.ctx?.waitUntil(work);
}

export function revalidatePath(path, type) {
	getRequestStore()?.revalidations.set(path, type);
}

// Called once the response is ready: one signed request to the app for everything the request dropped. Best effort, like the
// app's own revalidation: a failure is logged and nothing else.
export async function flushRevalidations(revalidations, env) {
	if (revalidations.size === 0) return;
	if (!env.APP || !process.env.BETTER_AUTH_SECRET) {
		console.warn("[revalidate] no APP binding or secret: the pages stay cached until they expire");
		return;
	}
	try {
		const body = buildRevalidateBody([...revalidations]);
		const response = await env.APP.fetch(new Request(new URL(REVALIDATE_PATH, process.env.APP_URL || "https://app.invalid"), {
			method: "POST",
			headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(body, process.env.BETTER_AUTH_SECRET) },
			body,
		}));
		if (!response.ok) console.warn(`[revalidate] the app answered ${response.status}`);
		await response.body?.cancel();
	} catch (error) {
		console.warn("[revalidate] could not reach the app:", error?.message ?? error);
	}
}
