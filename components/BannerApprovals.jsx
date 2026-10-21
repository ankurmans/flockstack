import Link from "next/link";
import { ShieldQuestion } from "lucide-react";
import { countPendingApprovals } from "@/lib/approvals";
import { connectDb } from "@/lib/db";

// Above every dashboard page while an AI agent's request waits for the owner (lib/approvals.js). Rendered in a Suspense, so the
// count never holds the page back.
export default async function BannerApprovals({ account }) {
	await connectDb();
	const count = await countPendingApprovals(account);
	if (count === 0) return null;

	return (
		<Link
			href="/approvals"
			data-approvals-banner
			role="status"
			className="mb-6 flex items-center gap-2.5 rounded-xl bg-amber-500/10 px-4 py-3 text-sm transition-colors duration-150 hover:bg-amber-500/15 animate-enter"
		>
			<ShieldQuestion aria-hidden className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
			<span className="text-pretty">
				<span className="font-medium">{count === 1 ? "An AI agent is" : `${count} requests from AI agents are`} waiting for your approval.</span> Nothing happens until you decide.
			</span>
		</Link>
	);
}
