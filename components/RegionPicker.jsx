"use client";

import { useEffect } from "react";
import { Check } from "lucide-react";
import { REGION_COOKIE, REGION_COOKIE_MAX_AGE } from "@/lib/region";
import { cn } from "@/lib/utils";

const TITLE = "Where should your data live?";

// Kept for a year on this host, and only ever for the region this host serves, so one host's cookie never points away
// from itself.
function rememberRegion(id) {
	try {
		document.cookie = `${REGION_COOKIE}=${id}; path=/; max-age=${REGION_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
	} catch {
		// Cookies blocked: the choice still travels in the link.
	}
}

// Where the account's data lives, for sign-up. options: each region with the sign-in address choosing it leads to
// (lib/region.js); selected: the one to start on; current: the region of this server; remember: the visitor picked
// current with ?region=, so it is kept for next time.
export default function RegionPicker({ options, selected, current, remember = false, className }) {
	useEffect(() => {
		if (remember) rememberRegion(current);
	}, [remember, current]);

	return (
		<div role="group" aria-label={TITLE} className={className}>
			<p aria-hidden="true" className="text-sm font-medium">
				{TITLE}
			</p>
			<ul className="mt-2 grid gap-2 sm:grid-cols-2">
				{options.map(({ id, name, host, href }) => {
					const isSelected = id === selected;
					return (
						<li key={id}>
							<a
								href={href}
								aria-current={isSelected ? "true" : undefined}
								onClick={() => id === current && rememberRegion(id)}
								className={cn(
									"flex items-center justify-between gap-3 rounded-xl bg-card px-3.5 py-2.5 text-left shadow-border transition-[color,background-color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
									isSelected ? "bg-muted ring-1 ring-foreground/50" : "hover:bg-muted/60"
								)}
							>
								<span className="flex min-w-0 flex-col">
									<span className="text-sm font-medium">{name}</span>
									<span className="truncate font-mono text-[11px] text-muted-foreground">{host}</span>
								</span>
								{isSelected && <Check aria-hidden="true" className="size-4 shrink-0" />}
							</a>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
