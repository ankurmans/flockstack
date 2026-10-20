import { scoped } from "@/lib/account-scope";
import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { isAudioEnabled } from "@/lib/audio-config";
import { serveAudio } from "@/lib/audio-serve";
import { connectDb } from "@/lib/db";
import { findSessionReader } from "@/lib/reader-session";
import { isPaidContact } from "@/lib/tiers";
import AudioVersion from "@/models/AudioVersion";

// An issue's audio, at /audio/<slug>.mp3 on the newsletter's own domain (proxy.js). Range requests work (podcast apps and
// iOS need them). Audio of an issue for everyone is public; audio of an issue for paid subscribers only is heard by a reader
// signed in to the newsletter (lib/reader-session.js) whose subscription is paid, and by nobody else.
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

	// An issue that became paid-only after its audio was made is paid-only audio from then on.
	const isPaidOnly = audio.file.scope === "paid" || issue.audience === "paid";
	if (isPaidOnly) {
		const reader = await findSessionReader(newsletter);
		if (!isPaidContact(reader)) {
			return new Response("This audio is for paid subscribers", { status: reader ? 403 : 401, headers: { "Cache-Control": "private, no-store" } });
		}
	}
	return serveAudio(request, audio.file, { access: isPaidOnly ? "private" : "public", version: new URL(request.url).searchParams.get("v") });
}
