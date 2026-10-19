import { CURRENCIES } from "@/lib/payments/config";
import { cn } from "@/lib/utils";

// A native select, so a form's action reads it as a field.
export default function SelectCurrency({ name, defaultValue, className }) {
	return (
		<select
			name={name}
			defaultValue={defaultValue}
			aria-label="Currency"
			className={cn(
				"h-9 w-24 rounded-lg border border-input bg-transparent px-2 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring md:text-sm dark:bg-input/30",
				className
			)}
		>
			{CURRENCIES.map((currency) => (
				<option key={currency} value={currency}>
					{currency.toUpperCase()}
				</option>
			))}
		</select>
	);
}
