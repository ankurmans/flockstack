// @opennextjs/cloudflare in the lean API Worker: the bindings the Worker was started with, and the request's execution context.
import { getBindings, getRequestStore } from "./runtime.js";

// Read at once (`getCloudflareContext().ctx`, what lib/docdb/driver.js does to know the request) or awaited, as OpenNext's is.
export function getCloudflareContext() {
	const context = { env: getBindings(), ctx: getRequestStore()?.ctx, cf: undefined };
	return Object.assign(Promise.resolve(context), context);
}
