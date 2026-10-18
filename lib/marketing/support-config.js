import { PRIVACY_EMAIL } from "@/lib/legal";

// What the support chat needs to know before it renders: whether the Worker has Workers AI, and where a person writes.
// Kept apart from lib/marketing/support-assistant.js so the pages that render the button don't load the docs index.

// The Worker's Workers AI binding (wrangler.jsonc, "ai"), or null: a self-hosted server, or `next dev` without it.
export async function getAiBinding() {
	try {
		const { getCloudflareContext } = await import("@opennextjs/cloudflare");
		const { env } = await getCloudflareContext({ async: true });
		return typeof env?.AI?.run === "function" ? env.AI : null;
	} catch {
		return null;
	}
}

// Where "Email a human" sends: SUPPORT_EMAIL, else the address the legal pages give.
export function getSupportAddress(env = process.env) {
	return String(env.SUPPORT_EMAIL ?? "").trim() || PRIVACY_EMAIL;
}
