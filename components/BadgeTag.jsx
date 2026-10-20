import { getTagPillClasses } from "@/lib/tag-colors";
import { cn } from "@/lib/utils";

// A tag as a small pill in its color; without one, the plain gray tags always had.
export default function BadgeTag({ name, color = null, className, children }) {
	return (
		<span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-normal", getTagPillClasses(color), className)}>
			{name}
			{children}
		</span>
	);
}
