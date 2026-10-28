import { WorkerEntrypoint } from "cloudflare:workers";
// FlockStack Cloud's lean API Worker: the REST API (/api/v1), the MCP server (/mcp), the OAuth endpoints an MCP client calls and
// their discovery documents, with no Next.js, React or server components. It is built from the same source modules as the app's
// routes (scripts/build-api-worker.mjs), is bound to the same database and buckets as its region's app, and is reached through
// the router's API binding (workers/router). docs/ARCHITECTURE-WORKERS.md has the picture.
import { getApiGroup } from "../../lib/api-routing.js";
import { SECURITY_HEADERS } from "../../lib/security-headers.js";
import { flushRevalidations } from "./runtime-hooks.js";
import { setBindings, runInRequest } from "./shims/runtime.js";
import { handleApiRequest } from "./handler.js";

// The 503 the router takes for "nothing happened here, ask the app": API_DISABLED=true turns this Worker off without touching the
// router, and a Worker that has no database answers the same, before it reads a body.
function unprocessed(reason) {
	return new Response(`${reason}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-fs-api-unprocessed": "1" } });
}

// What a request gets when something in the Worker throws, instead of the exception: the router turns an exception into a bare
// 502, and a client that gets one starts OAuth over. A GET the router asks the app again; anything else gets this answer, in the API's
// error shape.
function failed() {
	return Response.json(
		{ error: { code: "unavailable", message: "FlockStack could not answer this request. Try again in a moment." } },
		{ status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } }
	);
}

function withHeaders(response, startedAt) {
	if (response.status === 101) return response;
	const copy = new Response(response.body, response);
	for (const { key, value } of SECURITY_HEADERS) if (!copy.headers.has(key)) copy.headers.set(key, value);
	const timings = [];
	if (copy.headers.get("server-timing")) timings.push(copy.headers.get("server-timing"));
	timings.push(`api;dur=${Date.now() - startedAt}`);
	copy.headers.set("server-timing", timings.join(", "));
	if (!copy.headers.has("x-served-by")) copy.headers.set("x-served-by", "api");
	return copy;
}

// Calls done once the response's body has been read to its end (or dropped): an MCP tool runs while its answer streams, so
// what it revalidated is only known then.
function whenBodyDone(response, done) {
	if (!response.body || response.status === 101) {
		done();
		return response;
	}
	const { readable, writable } = new TransformStream({ flush: done });
	response.body.pipeTo(writable).catch(done);
	return new Response(readable, response);
}

const apiWorker = {
	async fetch(request, env, ctx) {
		const startedAt = Date.now();
		if (String(env.API_DISABLED ?? "").toLowerCase() === "true") return withHeaders(unprocessed("The API Worker is switched off"), startedAt);
		if (!env.DB) return withHeaders(unprocessed("The API Worker has no database"), startedAt);
		setBindings(env);
		return runInRequest(ctx, async (store) => {
			let response;
			try {
				response = withHeaders(await handleApiRequest(request), startedAt);
			} catch (error) {
				console.error("[api] unhandled error:", error?.message ?? error);
				if (store.revalidations.size > 0) ctx.waitUntil(flushRevalidations(store.revalidations, env));
				return withHeaders(failed(), startedAt);
			}
			// REST and OAuth answers are complete when the handler returns. An MCP tool runs while its answer streams, so what it
			// revalidated is known when the body ends.
			if (getApiGroup(new URL(request.url).pathname) !== "mcp") {
				if (store.revalidations.size > 0) ctx.waitUntil(flushRevalidations(store.revalidations, env));
				return response;
			}
			return whenBodyDone(response, () => store.revalidations.size > 0 && ctx.waitUntil(flushRevalidations(store.revalidations, env)));
		});
	},
};

export default apiWorker;

// Service binding RPC only: no HTTP route accepts a user or session reference.
export class CollaborationAuthority extends WorkerEntrypoint {
	async inspectTicket(ticket) {
		setBindings(this.env);
		return runInRequest(this.ctx, async () => (await import("../../lib/collaboration-authority.js")).inspectCollaborationTicket(ticket));
	}
	async authorize(reference) {
		setBindings(this.env);
		return runInRequest(this.ctx, async () => {
			try { const authorityModule = await import("../../lib/collaboration-authority.js"), current = await authorityModule.currentCollaboration(reference); return { allowed: true, reference: current.reference, role: current.role, fingerprint: current.fingerprint, name: authorityModule.editorDisplayName(current.user) }; }
			catch (error) { if (error.isActionError) return { allowed: false }; throw error; }
		});
	}
	async inspect(reference) {
		setBindings(this.env);
		return runInRequest(this.ctx, async () => (await import("../../lib/collaboration-authority.js")).inspectCollaboration(reference));
	}
	async checkpoint(reference, input) {
		setBindings(this.env);
		return runInRequest(this.ctx, async () => {
			const context = await (await import("../../lib/collaboration-authority.js")).currentCollaboration(reference);
			const { runAction } = await import("../../lib/actions/run-action.js");
			return runAction("checkpoint_campaign_collaboration", { account: context.account, user: context.user, input: { ...input, id: String(context.campaign._id) }, via: "dashboard" });
		});
	}
}

// Service binding RPC only, for the briefings Worker (workers/briefings): it writes a run's draft, calendar item and test email here,
// through runAction, so that Worker needs no SES or auth secrets. The module loads on the first call, never on an API request.
export class BriefingsDelivery extends WorkerEntrypoint {
	async deliverIssue(payload) {
		setBindings(this.env);
		return runInRequest(this.ctx, async () => (await import("../../lib/briefings-delivery.js")).deliverIssue(payload));
	}
	async notifyOwner(message) {
		setBindings(this.env);
		return runInRequest(this.ctx, async () => (await import("../../lib/briefings-delivery.js")).notifyOwner(message));
	}
}
