"use client";

import { Activity, BarChart3, Calendar, FileText, Handshake, List, Newspaper, Rocket, Scale, Users } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SECTION_ICON_KEYS, iconKeyForSection } from "@/lib/section-icons";

// The same icons the issue shows beside each section's heading (docs/VISUALS-DESIGN.md, Icon keys).
export const SECTION_ICONS = {
	lead: [Newspaper, "Lead"],
	"market-pulse": [Activity, "Market pulse"],
	earnings: [BarChart3, "Earnings"],
	roundup: [List, "Roundup"],
	"deal-flow": [Handshake, "Deal flow"],
	regulation: [Scale, "Regulation"],
	people: [Users, "People"],
	launches: [Rocket, "Launches"],
	"coming-up": [Calendar, "Coming up"],
	generic: [FileText, "Generic"],
};

// The section's icon, and a pick of the ten: "default" is the one the issue would give it (lib/section-icons.js), by its id or title.
export default function SelectSectionIcon({ sectionId, title, value, onChange }) {
	const [ShownIcon, shownLabel] = SECTION_ICONS[iconKeyForSection({ id: sectionId, title, icon: value })];
	const [DefaultIcon] = SECTION_ICONS[iconKeyForSection({ id: sectionId, title })];
	return (
		<Select value={value || "default"} onValueChange={(next) => onChange(next === "default" ? null : next)}>
			<SelectTrigger className="w-44" aria-label={`Icon: ${shownLabel}`}>
				<SelectValue>
					<ShownIcon aria-hidden="true" />
					{value ? shownLabel : "Default"}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="default">
					<DefaultIcon aria-hidden="true" />
					Default
				</SelectItem>
				{SECTION_ICON_KEYS.map((key) => {
					const [Icon, label] = SECTION_ICONS[key];
					return (
						<SelectItem key={key} value={key}>
							<Icon aria-hidden="true" />
							{label}
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}
