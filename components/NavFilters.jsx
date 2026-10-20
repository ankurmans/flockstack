import Link from "next/link";
import { cn } from "@/lib/utils";

// A row of choices that each change one thing in the page's address, the rest kept: a range, a breakdown. options: [value, label].
export default function NavFilters({ label, name, current, options, base, query }) {
	return (
		<div className="flex flex-wrap items-center gap-1.5 text-sm">
			<span className="mr-1 text-muted-foreground">{label}</span>
			{options.map(([value, text]) => {
				const next = new URLSearchParams({ ...query, [name]: value });
				const isActive = String(current) === String(value);
				return (
					<Link
						key={value}
						href={`${base}?${next}`}
						aria-current={isActive ? "true" : undefined}
						className={cn(
							"rounded-lg px-2.5 py-1 transition-colors duration-150",
							isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						)}
					>
						{text}
					</Link>
				);
			})}
		</div>
	);
}
