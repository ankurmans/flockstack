import { scoped } from "@/lib/account-scope";
import { serveAudio } from "@/lib/audio-serve";
import { getCurrentAccount } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { isObjectIdString } from "@/lib/validation";
import AudioVersion from "@/models/AudioVersion";

// The writer's own copy of an issue's audio, for the dashboard's player: a draft has no web page yet. The session is
// checked here, and the file is the account's own.
export async function GET(request, { params }) {
	const { id } = await params;
	const current = await getCurrentAccount();
	if (!current) return new Response("Unauthorized", { status: 401 });
	if (!isObjectIdString(id)) return new Response("Not found", { status: 404 });
	await connectDb();
	const audio = await AudioVersion.findOne(scoped(current.account, { campaignId: id, "file.key": { $type: "string" } }))
		.select({ file: 1 })
		.lean();
	if (!audio) return new Response("Not found", { status: 404 });
	return serveAudio(request, audio.file, { access: "private", version: new URL(request.url).searchParams.get("v") });
}
