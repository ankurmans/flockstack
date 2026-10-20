"use client";

import { cn } from "@/lib/utils";

// One custom field's control, by its type, as a plain form input named `name` (a multiple list field's boxes all
// carry it). onCommit: the value as the field stores it, once the reader is done with it: on blur for what is typed,
// at once for what is picked. Without it, the form reads the inputs.
export default function InputCustomField({ field, name, value, onCommit, disabled, className, placeholder }) {
	const commit = (next) => onCommit?.(next);
	const base = cn("h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring md:text-sm", className);

	if (field.type === "list" && field.multiple) {
		const chosen = new Set(Array.isArray(value) ? value : []);
		return (
			<fieldset className="flex flex-wrap gap-x-4 gap-y-2" disabled={disabled}>
				<legend className="sr-only">{field.label}</legend>
				{field.options.map((option) => (
					<label key={option} className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							name={name}
							value={option}
							defaultChecked={chosen.has(option)}
							onChange={(event) => {
								const boxes = event.currentTarget.form ? [...event.currentTarget.form.querySelectorAll(`input[name="${CSS.escape(name)}"]`)] : null;
								const next = boxes ? boxes.filter((box) => box.checked).map((box) => box.value) : event.currentTarget.checked ? [...chosen, option] : [...chosen].filter((item) => item !== option);
								commit(field.options.filter((item) => next.includes(item)));
							}}
							className="size-4 accent-foreground"
						/>
						{option}
					</label>
				))}
			</fieldset>
		);
	}

	if (field.type === "list" || field.type === "boolean") {
		const options = field.type === "boolean" ? [["true", "Yes"], ["false", "No"]] : field.options.map((option) => [option, option]);
		return (
			<select
				name={name}
				defaultValue={value === undefined || value === null ? "" : String(value)}
				onChange={(event) => commit(field.type === "boolean" && event.target.value ? event.target.value === "true" : event.target.value)}
				disabled={disabled}
				aria-label={field.label}
				className={base}
			>
				<option value="">{placeholder ?? "Not set"}</option>
				{options.map(([optionValue, label]) => (
					<option key={optionValue} value={optionValue}>
						{label}
					</option>
				))}
			</select>
		);
	}

	const type = { number: "number", date: "date", datetime: "datetime-local" }[field.type] ?? "text";
	// A datetime-local input shows UTC here, as the field stores it.
	const shown = field.type === "datetime" && value ? String(value).slice(0, 16) : (value ?? "");
	return (
		<input
			type={type}
			name={name}
			defaultValue={shown}
			step={field.type === "number" ? "any" : undefined}
			maxLength={field.type === "text" ? 500 : undefined}
			placeholder={placeholder}
			onBlur={(event) => commit(event.target.value)}
			disabled={disabled}
			aria-label={field.label}
			className={base}
		/>
	);
}
