import Link from "next/link";
import { getEntryHref, getEntryLabel, KIND_STYLES } from "@/lib/content-view";
import { CHANNEL_LABELS, STATE_LABELS } from "@/lib/content-rules";
import { timeZoneLabel } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

// One entry of the content calendar. A plan is outlined and says Planned; a campaign that really goes out or went out is filled
// and says Scheduled, Sending, Paused or Sent. The words carry the difference, not only the colors.
export default function ChipCalendar({ entry, viewerTimeZone, isRoomy = false }) {
	const label = getEntryLabel(entry);
	const zone = entry.kind === "planned" && entry.time && entry.timeZone && entry.timeZone !== viewerTimeZone ? ` ${timeZoneLabel(entry.timeZone, new Date(entry.at))}` : "";
	const details = [
		entry.title || "Untitled",
		label,
		entry.channel ? CHANNEL_LABELS[entry.channel] : null,
		entry.funnelStage,
		entry.state && entry.kind === "planned" ? STATE_LABELS[entry.state] : null,
		entry.editedAfterApproval ? "edited after approval" : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<Link href={getEntryHref(entry)} title={details} className={cn("block rounded px-1.5 py-0.5 text-xs", isRoomy ? "py-1 text-sm" : "truncate", KIND_STYLES[entry.kind])}>
			<span className="font-medium">{label}</span> {entry.time && <span className="tabular-nums opacity-70">{entry.time}{zone} </span>}
			{entry.funnelStage && <span className="opacity-70">{entry.funnelStage} </span>}
			{entry.title || "Untitled"}
			{entry.editedAfterApproval && <span className="ml-1 font-medium text-amber-700 dark:text-amber-300">Edited after approval</span>}
		</Link>
	);
}
