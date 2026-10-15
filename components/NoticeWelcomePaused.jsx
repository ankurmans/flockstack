import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Welcome emails stopped for the month (lib/sending.js): next to the welcome email setting and on the billing page,
// which lists the plans itself.
export default function NoticeWelcomePaused({ title, detail, hasUpgradeLink = true, className }) {
	return (
		<div role="status" className={cn("flex flex-wrap items-center justify-between gap-3 bg-amber-500/10 text-sm", className)}>
			<p className="flex min-w-0 flex-1 basis-64 gap-2.5">
				<TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
				<span className="text-pretty">
					<span className="font-medium">{title}.</span> {detail}
				</span>
			</p>
			{hasUpgradeLink && (
				<Button asChild size="sm">
					<Link href="/billing">Upgrade</Link>
				</Button>
			)}
		</div>
	);
}
