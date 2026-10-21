// next/headers, next/navigation and next/cache for modules that import them but never call them on the API's paths (sessions and
// pages). A request-scoped call fails the way Next.js fails outside a request, which Better Auth's cookie plugin treats as
// "nothing to do"; the rest say what they need.
function outsideRequest(name) {
	return async () => {
		throw new Error(`\`${name}\` was called outside a request scope.`);
	};
}

function needsNext(name) {
	return () => {
		throw new Error(`${name}() needs Next.js: it is not available in the API Worker`);
	};
}

export const headers = outsideRequest("headers");
export const cookies = outsideRequest("cookies");
export const redirect = needsNext("redirect");
export const permanentRedirect = needsNext("permanentRedirect");
export const notFound = needsNext("notFound");
export const unstable_cache = (run) => run;
export const revalidateTag = () => {};
export { revalidatePath } from "../runtime-hooks.js";
