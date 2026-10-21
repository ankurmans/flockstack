// @opennextjs/cloudflare in the lean API Worker: the bindings the Worker was started with.
import { getBindings } from "./runtime.js";

export async function getCloudflareContext() {
	return { env: getBindings(), ctx: undefined, cf: undefined };
}
