"use client";

import { Eye } from "lucide-react";
import { formatCompact, formatNumber } from "@/lib/format";

export default function BadgeViews({ views, isCompact = false }) {
	const exact = formatNumber(views);

	return (
		<span className="inline-flex items-center gap-1 tabular-nums">
			<Eye aria-hidden="true" className="size-3.5" />
			{isCompact ? formatCompact(views) : exact}
			<span className="sr-only">{views === 1 ? " view" : " views"}</span>
		</span>
	);
}
