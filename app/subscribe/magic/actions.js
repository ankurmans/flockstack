"use server";

import { headers } from "next/headers";
import { subscribeByMagicLink } from "@/lib/magic-links";
import { getClientIp } from "@/lib/rate-limit";
import { toReferrerHost } from "@/lib/attribution";

// The click on a Magic Link's page. The address, the key and the signature come from the link; what the person sees is
// only what happened to that address.
export async function subscribeWithMagic(_state, formData) {
	const requestHeaders = await headers();
	// The page that sent the person here, as the page worked it out; this request's own Referer is the page itself.
	return subscribeByMagicLink({ formData, ip: getClientIp(requestHeaders), referer: toReferrerHost(formData.get("from")) ?? "" });
}
