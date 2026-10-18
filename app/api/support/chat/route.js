import { siteExtensions } from "@/lib/site-extensions";

// The support chat's questions (SupportChat in components/SiteExtensions.jsx). Only FlockStack Cloud answers them,
// through its site extensions; anywhere else this is a 404.
export async function POST(request) {
	const { supportAssistant } = siteExtensions;
	if (!supportAssistant) return new Response("Not found", { status: 404 });
	return supportAssistant.chat(request);
}
