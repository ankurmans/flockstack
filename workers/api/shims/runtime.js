// The request the lean API Worker is serving, for the pieces that stand in for Next.js and OpenNext: the Worker's bindings (what
// getCloudflareContext hands out), its execution context (what after() hands work to) and the pages the request asked to drop.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();
let bindings = null;

export function setBindings(env) {
	bindings = env;
}

export function getBindings() {
	return bindings;
}

// Runs one request's work with its context, and returns what the request asked to revalidate (a Map of path to type).
export function runInRequest(ctx, run) {
	const store = { ctx, revalidations: new Map() };
	return storage.run(store, () => run(store));
}

export function getRequestStore() {
	return storage.getStore() ?? null;
}
