"use client";

// The events an endpoint takes, as boxes. selected: for a controlled list (the endpoint's page); without it the boxes are
// the form's own.
export default function ListEventChoices({ events, selected, onChange }) {
	return (
		<fieldset className="grid gap-1.5 sm:grid-cols-2">
			<legend className="sr-only">Events</legend>
			{events.map(({ type, title }) => (
				<label
					key={type}
					className="flex items-start gap-2.5 rounded-lg p-2.5 shadow-border transition-[box-shadow,background-color] duration-150 hover:shadow-border-hover has-checked:bg-muted/60"
				>
					<input
						type="checkbox"
						name="events"
						value={type}
						{...(selected
							? { checked: selected.includes(type), onChange: (event) => onChange(event.target.checked ? [...selected, type] : selected.filter((item) => item !== type)) }
							: {})}
						className="mt-0.5 size-4 shrink-0 accent-foreground"
					/>
					<span className="flex min-w-0 flex-col">
						<span className="text-sm font-medium">{title}</span>
						<span className="truncate font-mono text-[11px] text-muted-foreground">{type}</span>
					</span>
				</label>
			))}
		</fieldset>
	);
}
