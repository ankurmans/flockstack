import { scoped } from "@/lib/account-scope";
import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { isAudioEnabled } from "@/lib/audio-config";
import { serveAudio } from "@/lib/audio-serve";
import { connectDb } from "@/lib/db";
import { getAudioAccess } from "@/lib/reader-access";
import AudioVersion from "@/models/AudioVersion";

// An issue's audio, at /audio/<slug>.mp3 on the newsletter's own domain (proxy.js). Range requests work (podcast apps and
// iOS need them). Who may hear it is lib/reader-access.js getAudioAccess: anyone for an open issue, a signed-in subscriber for an
// issue the gate holds, a paid reader whose tier can read it for a paid issue.
export async function GET(request, { params }) {
	const { slug, post } = await params;
	const newsletter = isAudioEnabled() ? await getArchiveNewsletter(slug) : null;
	const issue = newsletter && (await getArchiveIssue(newsletter, post));
	if (!issue) return new Response("Not found", { status: 404 });
	await connectDb();
	const audio = await AudioVersion.findOne(scoped(newsletter.accountId, { campaignId: issue._id, "file.key": { $type: "string" } }))
		.select({ file: 1 })
		.lean();
	if (!audio) return new Response("Not found", { status: 404 });

	// Who may hear it is decided as for reading the issue: a paid issue by tier, a gated issue by a signed-in subscriber.
	const access = await getAudioAccess({ newsletter, issue, file: audio.file });
	if (!access.ok) return new Response("This audio is for subscribers who can read the issue", { status: access.status, headers: { "Cache-Control": "private, no-store" } });
	return serveAudio(request, audio.file, { access: access.access, version: new URL(request.url).searchParams.get("v") });
}
