import "server-only";
import { cookies, headers } from "next/headers";
import { REGION_COOKIE, chooseRegion, readCountry } from "@/lib/region";

// request.cf is the same data as the cf-ipcountry header; it is only read when the header is missing (the proxy off, or
// a server that isn't behind Cloudflare, where there is nothing to read).
async function readCf() {
	try {
		const { getCloudflareContext } = await import("@opennextjs/cloudflare");
		return (await getCloudflareContext({ async: true })).cf;
	} catch {
		return undefined;
	}
}

// The region the sign-in page and the landing page start on for this visitor: ?region=, the cookie, their country.
export async function readRegionChoice(queryRegion) {
	const [requestHeaders, cookieStore] = await Promise.all([headers(), cookies()]);
	const cf = requestHeaders.get("cf-ipcountry") ? undefined : await readCf();
	return chooseRegion({
		query: queryRegion,
		cookie: cookieStore.get(REGION_COOKIE)?.value,
		country: readCountry(requestHeaders, cf),
	});
}
