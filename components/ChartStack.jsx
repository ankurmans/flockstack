import { formatNumber } from "@/lib/format";

// Colors cycle through the chart palette; past five, a lighter shade of the same.
function colorOf(index) {
	return { backgroundColor: `var(--chart-${(index % 5) + 1})`, opacity: index < 5 ? 1 : 0.55 };
}

// Bars for each period, stacked by group, drawn from the report's own numbers, with a table underneath for anyone who
// doesn't see the bars. columns: [{ label, values: [one for each series] }]; series: [{ label }].
export default function ChartStack({ columns, series, ariaLabel }) {
	const totals = columns.map(({ values }) => values.reduce((sum, value) => sum + value, 0));
	const most = Math.max(1, ...totals);

	return (
		<figure className="min-w-0">
			<div role="img" aria-label={ariaLabel} className="flex h-44 items-end gap-px sm:gap-0.5">
				{columns.map(({ label, values }, column) => (
					<div
						key={label}
						title={`${label}: ${formatNumber(totals[column])}${series.length > 1 ? ` (${series.map((item, index) => `${item.label} ${formatNumber(values[index])}`).join(", ")})` : ""}`}
						className="flex h-full min-w-px flex-1 flex-col-reverse"
					>
						<div className="flex flex-col-reverse overflow-hidden rounded-t-[3px]" style={{ height: `${(totals[column] / most) * 100}%` }}>
							{values.map((value, index) => (value > 0 ? <span key={series[index].label} style={{ ...colorOf(index), flexGrow: value }} /> : null))}
						</div>
					</div>
				))}
			</div>
			<div aria-hidden="true" className="mt-2 flex justify-between text-[11px] text-muted-foreground tabular-nums">
				<span>{columns[0]?.label}</span>
				<span>{columns.at(-1)?.label}</span>
			</div>
			{series.length > 1 && (
				<ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
					{series.map(({ label }, index) => (
						<li key={label} className="flex items-center gap-1.5">
							<span aria-hidden="true" className="size-2.5 rounded-sm" style={colorOf(index)} />
							{label}
						</li>
					))}
				</ul>
			)}
		</figure>
	);
}
