import { Check, Link2Off, PauseCircle } from "lucide-react";
import { confirmPause } from "@/app/briefing-pause/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";
import { scoped } from "@/lib/account-scope";
import { isDeletionPending } from "@/lib/account-state";
import { verifyPauseToken } from "@/lib/briefing-pause-links";
import { connectDb } from "@/lib/db";
import Account from "@/models/Account";
import Briefing from "@/models/Briefing";

// The page the pause link in a briefing's note after an auto-send opens. Opening it pauses nothing (mail scanners and link previews
// open links); only its button does. The URL carries the token: keep it out of search results, caches and referrer headers.
export const dynamic = "force-dynamic";
export const metadata = {
	title: "Pause a briefing",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

// The token as it was signed; a broken escape (a link cut or mangled by a mail client) is simply not a link of ours.
function readToken(value) {
	try {
		return decodeURIComponent(String(value ?? ""));
	} catch {
		return "";
	}
}

async function load(link) {
	try {
		await connectDb();
		const account = await Account.findById(link.accountId).lean();
		if (!account || isDeletionPending(account)) return null;
		return await Briefing.findOne(scoped(account, { _id: link.briefingId })).select({ name: 1, status: 1 }).lean();
	} catch (error) {
		console.error("[briefing-pause] Could not load:", error?.message);
		return null;
	}
}

export default async function BriefingPausePage({ params, searchParams }) {
	const [{ token }, query] = await Promise.all([params, searchParams]);
	const signed = readToken(token);
	const link = verifyPauseToken(signed);
	const briefing = link ? await load(link) : null;

	return (
		<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
			{!briefing ? (
				<CardNotice icon={Link2Off} title="This link doesn't work">
					It may be older than 14 days, or its briefing was deleted. Pause the briefing in the dashboard instead.
				</CardNotice>
			) : briefing.status === "paused" ? (
				<CardNotice icon={Check} tone="success" title={query?.result === "paused" ? "Paused" : "Already paused"}>
					{briefing.name} makes nothing until you turn it back on in the dashboard. Issues it already sent stay sent.
				</CardNotice>
			) : (
				<CardNotice icon={PauseCircle} title="Pause this briefing?">
					<span className="block">{briefing.name} stops running on its schedule until you turn it back on. An issue already sent can&apos;t be taken back.</span>
					{query?.result === "busy" && <span className="mt-2 block">Too many tries from here: wait a few minutes and press it again.</span>}
					<form action={confirmPause} className="mt-4">
						<input type="hidden" name="token" value={signed} />
						<Button type="submit">Pause {briefing.name}</Button>
					</form>
				</CardNotice>
			)}
		</main>
	);
}
