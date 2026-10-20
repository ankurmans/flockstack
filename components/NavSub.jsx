"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Tabs between the pages of one section of the dashboard. A tab is active on its own address and below it, except for the
// addresses another tab names.
export default function NavSub({ items, label }) {
	const pathname = usePathname();
	const isActive = ({ href, except = [] }) =>
		(pathname === href || pathname.startsWith(`${href}/`)) && !except.some((path) => pathname === path || pathname.startsWith(`${path}/`));

	return (
		<nav aria-label={label} className="mb-6 flex gap-1 overflow-x-auto border-b border-border/60 pb-px [scrollbar-width:none]">
			{items.map((item) => (
				<Link
					key={item.href}
					href={item.href}
					aria-current={isActive(item) ? "page" : undefined}
					className={cn(
						"-mb-px shrink-0 border-b-2 px-3 pb-2.5 text-sm font-medium transition-colors duration-150",
						isActive(item) ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
					)}
				>
					{item.label}
				</Link>
			))}
		</nav>
	);
}
