import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { describeWatch, getActiveWatch } from "@/lib/account-watch-rules";

// Above every dashboard page while the account is past an early warning (lib/account-watch.js): what was measured, where
// the block is, and the docs page on what to do. Nothing is stopped yet; a blocked account gets BannerBlocked instead.
export default function BannerWatch({ account, now = new Date() }) {
	const issues = getActiveWatch(account, now);
	if (issues.length === 0) return null;

	return (
		<div data-watch-banner role="status" className="mb-6 flex flex-col gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm animate-enter">
			{issues.map((item) => {
				const { title, summary } = describeWatch(item);
				return (
					<p key={item.issue} data-watch-issue={item.issue} className="flex min-w-0 items-start gap-2.5">
						<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
						<span className="text-pretty">
							<span className="font-medium">{title}.</span> {summary}
						</span>
					</p>
				);
			})}
			<p className="pl-6.5 text-muted-foreground">
				Nothing is stopped yet.{" "}
				<Link href="/docs/warnings" className="font-medium text-foreground underline underline-offset-4">
					What to do
				</Link>
			</p>
		</div>
	);
}
