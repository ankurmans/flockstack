import { formatCount } from "@/lib/format";

// What the contacts page says about a tag or field coming off a list in the background (lib/bulk-removal.js), as
// toRemovalOutput gives it: a line while it runs, then one when it's done or stopped.
export function describeRemoval({ kind, label, status, total, removed, percent }) {
	const what = kind === "tag" ? `the tag ${label}` : `the field ${label}`;
	if (status === "running") return `Removing ${what} from ${formatCount(total, "contact")}… ${percent}%`;
	if (status === "done") return `Removed ${what} from ${formatCount(removed, "contact")}`;
	return `Removing ${what} stopped after ${formatCount(removed, "contact")}`;
}
