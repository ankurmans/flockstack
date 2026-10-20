"use client";

import { Check } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TAG_COLORS, getTagSwatchClasses } from "@/lib/tag-colors";
import { cn } from "@/lib/utils";

// A tag's color swatch; opening it lists the colors, and "Gray" is the plain one.
export default function PickerTagColor({ tag, color, disabled, onPick }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label={`Color of the tag ${tag}: ${color ?? "none"}`}
					className="grid size-4 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className={cn("size-2.5 rounded-full", getTagSwatchClasses(color))} />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-36">
				{TAG_COLORS.map((name) => (
					<DropdownMenuItem key={name} onSelect={() => onPick(name === "gray" ? null : name)}>
						<span className={cn("size-2.5 rounded-full", getTagSwatchClasses(name))} />
						<span className="capitalize">{name}</span>
						{(color ?? "gray") === name && <Check className="ml-auto" />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
