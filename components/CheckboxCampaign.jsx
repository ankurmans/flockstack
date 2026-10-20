"use client";

import { useCampaignSelection } from "@/components/ProviderCampaignSelection";

// A row's checkbox, above the row's link; with `all`, the header's, which ticks every row of the page.
export default function CheckboxCampaign({ id, status, all = null, label }) {
	const selection = useCampaignSelection();
	if (!selection) return null;
	const isOn = all ? all.length > 0 && all.every(([key]) => selection.selected.has(key)) : selection.selected.has(id);

	return (
		<input
			type="checkbox"
			checked={isOn}
			onChange={() => (all ? selection.setMany(all, !isOn) : selection.toggle(id, status))}
			aria-label={label}
			className="relative z-10 size-4 cursor-pointer accent-foreground"
		/>
	);
}
