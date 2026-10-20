import { formatNumber } from "@/lib/format";

// Counts as bars, the largest filling the row. rows: [{ key, label, count }].
export default function ListTally({ rows, emptyLabel = "Nothing yet" }) {
	const largest = Math.max(1, ...rows.map(({ count }) => count));
	if (rows.length === 0) return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;

	return (
		<ul className="flex flex-col gap-2">
			{rows.map(({ key, label, count }) => (
				<li key={key} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm">
					<span className="truncate">{label}</span>
					<span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
						<span className="block h-full rounded-full bg-primary" style={{ width: `${(count / largest) * 100}%` }} />
					</span>
					<span className="text-right tabular-nums">{formatNumber(count)}</span>
				</li>
			))}
		</ul>
	);
}
