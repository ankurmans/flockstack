"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { setCampaignSegments } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/toast";

const MAX_SEGMENTS = 5;

function describe(ids, segments, empty) {
	if (ids.length === 0) return empty;
	if (ids.length === 1) return segments.find(({ id }) => id === ids[0])?.name ?? "1 segment";
	return `${ids.length} segments`;
}

// Who a campaign goes to: everyone, or contacts in any of up to 5 saved segments, leaving out those in up to 5 others.
export default function SelectSegments({ campaignId, include, exclude, segments }) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [chosen, setChosen] = useState({ include, exclude });

	function toggle(list, id) {
		const other = list === "include" ? "exclude" : "include";
		const current = chosen[list];
		const next = current.includes(id) ? current.filter((one) => one !== id) : [...current, id];
		if (next.length > MAX_SEGMENTS) return void toast.error(`${MAX_SEGMENTS} segments at most`);
		const changed = { ...chosen, [list]: next, [other]: chosen[other].filter((one) => one !== id) };
		setChosen(changed);
		startTransition(async () => {
			const result = await setCampaignSegments(campaignId, changed);
			if (result?.error) return void toast.error(result.error);
			router.refresh();
		});
	}

	function menu(list, label, empty) {
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm" disabled={isPending} aria-label={label} className="max-w-full">
						<span className="truncate">{describe(chosen[list], segments, empty)}</span>
						<ChevronDown data-icon="inline-end" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-64">
					<DropdownMenuLabel>{label}</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{segments.map((segment) => (
						<DropdownMenuCheckboxItem
							key={segment.id}
							checked={chosen[list].includes(segment.id)}
							onCheckedChange={() => toggle(list, segment.id)}
							onSelect={(event) => event.preventDefault()}
						>
							{segment.name}
						</DropdownMenuCheckboxItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	return (
		<span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
			{menu("include", "In any of these segments", "Everyone")}
			<span>leaving out</span>
			{menu("exclude", "Leave out these segments", "nobody")}
		</span>
	);
}
