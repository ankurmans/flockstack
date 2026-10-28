import { cn } from "@/lib/utils";

// An empty list in the dashboard: one lucide icon at the default stroke, a sentence, more words as children and an optional action.
// isCompact fits a list inside a card; without it, it stands for the whole page's list.
export default function StateEmpty({ icon: Icon, title, action, isCompact = false, className, children }) {
	if (isCompact) {
		return (
			<div className={cn("flex items-start gap-3 px-4 py-4 text-sm", className)}>
				<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
					<Icon className="size-4" aria-hidden="true" />
				</span>
				<span className="flex min-w-0 flex-col items-start gap-1.5 pt-1.5">
					<span className="font-medium text-pretty">{title}</span>
					{children}
					{action}
				</span>
			</div>
		);
	}
	return (
		<div className={cn("flex flex-col items-center justify-center gap-4 rounded-xl px-6 py-16 text-center shadow-border animate-enter", className)}>
			<div className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
				<Icon className="size-5" aria-hidden="true" />
			</div>
			<p className="text-sm font-medium text-pretty">{title}</p>
			{children}
			{action}
		</div>
	);
}
