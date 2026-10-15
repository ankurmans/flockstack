import { cn } from "@/lib/utils";

// A row of the campaign editor's cards: its label, then a field or a value on the same line.
export default function RowCampaign({ label, className, children }) {
	return (
		<div
			className={cn(
				"grid min-h-11 grid-cols-[6rem_minmax(0,1fr)] items-center px-4 transition-colors duration-150 focus-within:bg-muted/40",
				className
			)}
		>
			<span className="text-sm text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}
