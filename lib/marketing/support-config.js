import { PRIVACY_EMAIL } from "@/lib/legal";
import { isPrerendering } from "@/lib/prerender";

// What the support chat needs to know before it renders: whether the server has a text AI, and where a person writes.
// Kept apart from lib/marketing/support-assistant.js so the pages that render the button don't load the docs index.

// Whether the help chat can answer: an Anthropic or Groq key that may be used, or the Worker's Workers AI binding
// (wrangler.jsonc, "ai"). False on a self-hosted server with neither, or `next dev`.
export async function isSupportAiAvailable() {
	// The files of the public pages are rendered as FlockStack Cloud shows them, help chat included (lib/prerender.js).
	if (isPrerendering()) return true;
	return (await import("@/lib/platform-ai")).isTextAiAvailable();
}

// Where "Email a human" sends: SUPPORT_EMAIL, else the address the legal pages give.
export function getSupportAddress(env = process.env) {
	return String(env.SUPPORT_EMAIL ?? "").trim() || PRIVACY_EMAIL;
}
