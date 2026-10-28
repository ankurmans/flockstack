import { Check, Link2Off, ThumbsDown, ThumbsUp } from "lucide-react";
import { confirmVerdict } from "@/app/briefing-verdict/actions";
import CardNotice from "@/components/CardNotice";
import ImageLinkPreview from "@/components/ImageLinkPreview";
import { Button } from "@/components/ui/button";
import { scoped } from "@/lib/account-scope";
import { isDeletionPending } from "@/lib/account-state";
import { verifyVerdictToken } from "@/lib/briefing-verdict-links";
import { findRunStory } from "@/lib/briefing-verdicts";
import { connectDb } from "@/lib/db";
import Account from "@/models/Account";
import Briefing from "@/models/Briefing";
import BriefingVerdict from "@/models/BriefingVerdict";

// The page a keep or drop link in a briefing's note opens. Opening it records nothing (mail scanners and link previews open links);
// only its button does. The URL carries the token: keep it out of search results, caches and referrer headers.
export const dynamic = "force-dynamic";
export const metadata = {
	title: "Rate a briefing story",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

const WORDS = { keep: "Keep", drop: "Drop" };

// The token as it was signed; a broken escape (a link cut or mangled by a mail client) is simply not a link of ours.
function readToken(value) {
	try {
		return decodeURIComponent(String(value ?? ""));
	} catch {
		return "";
	}
}

// The story's site, for its link preview: an https page only.
function httpsHost(url) {
	try {
		const parsed = new URL(String(url ?? ""));
		return parsed.protocol === "https:" ? parsed.hostname.replace(/^www\./, "") : "";
	} catch {
		return "";
	}
}

async function load(link) {
	try {
		await connectDb();
		const account = await Account.findById(link.accountId).lean();
		if (!account || isDeletionPending(account)) return null;
		const { run, story } = await findRunStory(account, link.runId, link.storyKey);
		const [briefing, existing] = await Promise.all([
			Briefing.findOne(scoped(account, { _id: run.briefingId })).select({ name: 1 }).lean(),
			BriefingVerdict.findOne(scoped(account, { briefingId: run.briefingId, runId: run._id, storyKey: link.storyKey })).select({ verdict: 1 }).lean(),
		]);
		return briefing ? { story, host: httpsHost(story.url), briefingName: briefing.name, existing: existing?.verdict ?? null } : null;
	} catch (error) {
		if (error?.code !== "not_found") console.error("[briefing-verdict] Could not load:", error?.message);
		return null;
	}
}

export default async function BriefingVerdictPage({ params, searchParams }) {
	const [{ token }, query] = await Promise.all([params, searchParams]);
	const signed = readToken(token);
	const link = verifyVerdictToken(signed);
	const found = link ? await load(link) : null;

	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{!found ? (
				<CardNotice icon={Link2Off} title="This link doesn't work">
					It may be older than 14 days, or its briefing was deleted. Rate the story on the run&apos;s page in the dashboard instead.
				</CardNotice>
			) : found.existing ? (
				<CardNotice icon={Check} tone="success" title={query?.result === "recorded" ? "Thanks, recorded" : "Already recorded"}>
					{WORDS[found.existing]}: &ldquo;{found.story.title}&rdquo;, for {found.briefingName}. To change it, open the run in the dashboard.
				</CardNotice>
			) : (
				<CardNotice icon={link.verdict === "keep" ? ThumbsUp : ThumbsDown} title={`${WORDS[link.verdict]} this story?`}>
					{found.host && (
						<a href={found.story.url} target="_blank" rel="noreferrer noopener" className="my-3 flex items-center gap-3 rounded-lg p-2 text-left shadow-border hover:bg-muted/60">
							<ImageLinkPreview src={found.story.previewImage} alt={found.story.title} />
							<span className="min-w-0">
								<span className="line-clamp-2 font-medium text-foreground">{found.story.title}</span>
								<span className="block truncate text-xs">{found.host}</span>
							</span>
						</a>
					)}
					<span className="block">
						&ldquo;{found.story.title}&rdquo;, found by {found.briefingName}. {link.verdict === "keep" ? "Later issues pick more stories like it." : "Later issues pick fewer stories like it."}
					</span>
					{query?.result === "busy" && <span className="mt-2 block">Too many tries from here: wait a few minutes and press it again.</span>}
					<form action={confirmVerdict} className="mt-4">
						<input type="hidden" name="token" value={signed} />
						<Button type="submit">{link.verdict === "keep" ? "Keep this story" : "Drop this story"}</Button>
					</form>
				</CardNotice>
			)}
		</main>
	);
}
