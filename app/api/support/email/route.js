import { siteExtensions } from "@/lib/site-extensions";

// The support chat's "Email a human" (SupportChat in components/SiteExtensions.jsx), for a signed-in person. Only
// FlockStack Cloud answers it, through its site extensions; anywhere else this is a 404.
export async function POST(request) {
	const { supportAssistant } = siteExtensions;
	if (!supportAssistant) return new Response("Not found", { status: 404 });
	return supportAssistant.email(request);
}
